import { eq, inArray, sql } from 'drizzle-orm';
import { InlineKeyboard, type Api } from 'grammy';
import type { Message } from 'grammy/types';
import { db } from '../db/client.js';
import { burstPart, burstSession } from '../db/schema.js';
import { enqueueBurstFlush, enqueueBurstReflush } from '../queue/index.js';
import { markImportDone } from '../db/users.js';
import { batchIngest, DUPE_SAMPLE_CAP, type BatchResult } from './batch.js';
import { draftsFromMessages } from './draft.js';
import { makeProgress, finalText } from './progress.js';
import { checkUserBudget, nextResetUtc, formatResetUtc } from '../ai/usage.js';

/**
 * Массовая заливка пересылок управляется ЯВНЫМ флагом-сессией в БД (строка burst_session) — ТОЛЬКО по
 * команде /import, без эвристики по частоте. Пока сессия активна, ВСЁ (одиночки и альбомы) копится в один
 * буфер burst_part и обрабатывается одним batchIngest — без поштучных «Принял» и без онлайн-кластеризации.
 * Вне сессии каждое сообщение идёт обычным путём (мгновенное «Принял»). Апдейты сериализованы по userId
 * (sequentialize), флаш защищён single-flight guard — двойной обработки буфера нет.
 */
const EDIT_THROTTLE_MS = 2000; // не чаще — переякоривание счётчика вниз (send+delete, лимиты Telegram)
/**
 * Окно «оседания» альбома: если на момент флаша часть с media_group_id пришла позже, чем (now − это),
 * альбом ещё досыпается. Не флашим на полуприходе (порвали бы группу на пост + сиротские картинки) —
 * откладываем коротким добором (enqueueBurstReflush). Telegram шлёт члены альбома в пределах ~1с.
 */
const ALBUM_SETTLE_MS = 2500;

const lastEdit = new Map<number, number>(); // userId → когда последний раз правили счётчик
const flushing = new Set<number>(); // userId, чей буфер прямо сейчас обрабатывается (single-flight)

/** Кнопка завершения заливки под прогресс-сообщением. */
export function doneKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('✅ Готово', 'import:done');
}

/** Идёт ли сейчас сессия заливки у пользователя (источник истины — БД, переживает рестарт). */
async function isImportActive(userId: number): Promise<boolean> {
  const [row] = await db
    .select({ u: burstSession.userId })
    .from(burstSession)
    .where(eq(burstSession.userId, userId))
    .limit(1);
  return Boolean(row);
}

/**
 * Открыть сессию заливки по команде /import (атомарный claim строки). Возвращает true, если сессия
 * именно сейчас создана (false — уже была активна). Шлёт прогресс-сообщение с кнопкой «Готово».
 */
export async function startImport(api: Api, userId: number, chatId: number): Promise<boolean> {
  const claimed = await db
    .insert(burstSession)
    .values({ userId })
    .onConflictDoNothing()
    .returning({ u: burstSession.userId });
  if (claimed.length === 0) return false; // уже активна

  lastEdit.delete(userId);

  const text =
    'Режим заливки включён. Пересылай сохранённое пачками (в Telegram — до 100 за раз), можно ' +
    'с паузами — соберу всё в одну заливку, без спама по одному. Нажми «Готово», когда закончишь.';
  const progress = await api.sendMessage(chatId, text, { reply_markup: doneKeyboard() }).catch(() => null);
  if (progress) {
    await db
      .update(burstSession)
      .set({ progressChatId: progress.chat.id, progressMessageId: progress.message_id })
      .where(eq(burstSession.userId, userId));
  }
  return true;
}

/** Положить сообщение в буфер заливки + троттленно обновить счётчик. */
async function bufferPart(api: Api, userId: number, msg: Message): Promise<void> {
  await db.insert(burstPart).values({ userId, message: msg });
  const [s] = await db
    .update(burstSession)
    .set({ count: sql`${burstSession.count} + 1` })
    .where(eq(burstSession.userId, userId))
    .returning();

  if (s) {
    const now = Date.now();
    const text = `Собираю заливку… принял ${s.count}`;
    const haveSlot = Boolean(s.progressChatId && s.progressMessageId);
    if (now - (lastEdit.get(userId) ?? 0) >= EDIT_THROTTLE_MS) {
      lastEdit.set(userId, now);
      // Переякориваем прогресс ВНИЗ: десятки пересылок выталкивают старое сообщение вверх, и счётчик с
      // кнопкой «Готово» уходят из поля зрения. Поэтому шлём свежее в конец чата, затем удаляем старое
      // и переписываем координаты в сессии — так статус и «Готово» всегда на виду. Сначала send, потом
      // delete (без «дыры»); оба в .catch — старое могло устареть (>48ч)/быть удалено, это не критично.
      const fresh = await api
        .sendMessage(msg.chat.id, text, { reply_markup: doneKeyboard() })
        .catch(() => null);
      if (fresh) {
        if (haveSlot) await api.deleteMessage(s.progressChatId!, s.progressMessageId!).catch(() => {});
        await db
          .update(burstSession)
          .set({ progressChatId: fresh.chat.id, progressMessageId: fresh.message_id })
          .where(eq(burstSession.userId, userId));
      }
    } else if (haveSlot) {
      // Между переякориваниями дёшево правим счётчик НА МЕСТЕ: иначе при быстрой пачке (все части за
      // <throttle) число застревало на первом показе — «принял 1» на десяток фото. edit дешевле send+delete;
      // «not modified»/протухшее сообщение — в .catch (не критично, дойдёт со следующей пересылкой/якорем).
      await api.editMessageText(s.progressChatId!, s.progressMessageId!, text, { reply_markup: doneKeyboard() }).catch(() => {});
    }
  }
  await enqueueBurstFlush(userId); // debounce: окно продлевается на каждую пересылку
}

/**
 * Вызывается в начале приёма сообщения. Если идёт сессия заливки (/import) — буферизует ЛЮБОЕ сообщение
 * (включая члены альбома) и возвращает true. Вне сессии — false (сообщение пойдёт обычным путём).
 * Авто-старта по частоте нет: заливка только по явной команде.
 */
export async function maybeBufferBurst(api: Api, msg: Message): Promise<boolean> {
  const userId = msg.from?.id;
  if (!userId) return false;

  if (await isImportActive(userId)) {
    await bufferPart(api, userId, msg);
    return true;
  }
  return false;
}

/**
 * Сбой авто-флаша (debounce-воркер): правим прогресс-сообщение, чтобы пользователь не остался без
 * сигнала (через кнопку «Готово» try/catch в callbacks его уведомляет, а debounce-путь — нет).
 * Буфер и сессия целы (flushBurst при броске их не трогает) — повторное «Готово» довезёт. Best-effort.
 */
export async function notifyBurstFlushFailed(api: Api, userId: number): Promise<void> {
  const [session] = await db
    .select({ chatId: burstSession.progressChatId, msgId: burstSession.progressMessageId })
    .from(burstSession)
    .where(eq(burstSession.userId, userId))
    .limit(1);
  if (!session?.chatId || !session?.msgId) return;
  await api
    .editMessageText(
      session.chatId,
      session.msgId,
      'Не получилось долить заливку сейчас — буфер сохранён, ничего не пропало. Нажми «Готово» ещё раз чуть позже.',
      { reply_markup: doneKeyboard() },
    )
    .catch(() => {});
}

/** Суммирование результатов волн обработки буфера в один итог для финального сообщения. */
function addResult(acc: BatchResult, r: BatchResult): BatchResult {
  return {
    saved: acc.saved + r.saved,
    images: acc.images + r.images,
    skipped: acc.skipped + r.skipped,
    existingDupeCount: acc.existingDupeCount + r.existingDupeCount,
    inBatchDupeCount: acc.inBatchDupeCount + r.inBatchDupeCount,
    // Счётчики точные; сэмплы имён — обрезаем (для UI достаточно нескольких).
    existingDupes: [...acc.existingDupes, ...r.existingDupes].slice(0, DUPE_SAMPLE_CAP),
    inBatchDupes: [...acc.inBatchDupes, ...r.inBatchDupes].slice(0, DUPE_SAMPLE_CAP),
    totalClusters: r.totalClusters, // итоговое число кластеров — из последней волны
    stoppedForBudget: acc.stoppedForBudget || r.stoppedForBudget,
  };
}

/**
 * Флаш заливки (кнопка «Готово» или debounce-воркер). Single-flight guard: если буфер юзера уже
 * обрабатывается (параллельный вызов «Готово» + воркер), второй выходит сразу — двойной обработки нет.
 * Буфер обрабатываем ВОЛНАМИ: читаем порцию, batchIngest, удаляем ТОЛЬКО обработанные id (не
 * `where userId`!) — иначе пересылки, пришедшие во время долгого batchIngest, удалились бы необработанными.
 * Сессию закрываем лишь когда буфер реально опустел. Сбой batchIngest оставляет буфер+сессию (ретрай
 * довезёт). Упор в дневной лимит расхода (stoppedForBudget) — НЕ ошибка: уже векторизованное вставлено,
 * остаток остаётся в буфере, сессию НЕ закрываем и сообщаем юзеру; дольём после сброса лимита (дедуп не
 * задвоит вставленное). Возвращает суммарный результат или null (пусто / уже флашится / уже обработано).
 */
export async function flushBurst(api: Api, userId: number): Promise<BatchResult | null> {
  if (flushing.has(userId)) return null; // уже обрабатывается другим вызовом — не дублируем
  flushing.add(userId);
  try {
    const [session] = await db
      .select()
      .from(burstSession)
      .where(eq(burstSession.userId, userId))
      .limit(1);
    const chatId = session?.progressChatId ?? null;
    const msgId = session?.progressMessageId ?? null;
    const onProgress = makeProgress(api, chatId, msgId);

    let total: BatchResult | null = null;
    let stoppedForBudget = false;
    // Волны: дозалитое во время batchIngest подхватываем следующим проходом, ничего не теряя.
    for (;;) {
      const parts = await db.select().from(burstPart).where(eq(burstPart.userId, userId));
      if (parts.length === 0) break;

      // Пре-чек бюджета перед дорогой волной: уже за дневным потолком / глобальная пауза → не строим
      // черновики и не тратим. Буфер и сессия остаются — дольём после сброса лимита.
      if (!checkUserBudget(userId).allowed) {
        stoppedForBudget = true;
        break;
      }

      // Гейт оседания альбомов: пока ничего в этом вызове не обработали (total===null) и какой-то альбом
      // ещё досыпается (часть пришла <ALBUM_SETTLE_MS назад) — НЕ флашим, иначе порвём группу на пост +
      // сиротские картинки. Откладываем коротким добором, буфер/сессию не трогаем. После обработки первой
      // волны (total!==null) не ждём: опоздавший осколок уже-постнутого альбома отсеет дроп в batchIngest.
      if (total === null) {
        const now = Date.now();
        const stillArriving = parts.some((p) => {
          const gid = (p.message as Message).media_group_id;
          return gid != null && now - p.createdAt.getTime() < ALBUM_SETTLE_MS;
        });
        if (stillArriving) {
          await enqueueBurstReflush(userId);
          if (chatId && msgId) {
            await api
              .editMessageText(chatId, msgId, 'Дособираю альбомы… ещё пару секунд.', {
                reply_markup: doneKeyboard(),
              })
              .catch(() => {});
          }
          return { saved: 0, images: 0, skipped: 0, existingDupes: [], inBatchDupes: [],
            existingDupeCount: 0, inBatchDupeCount: 0, totalClusters: 0, deferred: true };
        }
      }

      const ids = parts.map((p) => p.id);
      const messages = parts
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((p) => p.message as Message);
      // Склейка альбомов: пост с подписью+картинками → одна запись, как в обычном альбомном пути.
      const drafts = draftsFromMessages(messages);

      // Если batchIngest бросит (сеть/API) — буфер и сессия остаются, ничего не потеряно (ретрай довезёт).
      const res = await batchIngest(userId, drafts, onProgress);
      total = total ? addResult(total, res) : res;

      if (res.stoppedForBudget) {
        // Лимит исчерпан ПОСРЕДИ волны: уже векторизованное batchIngest вставил, остаток пула не обработан.
        // НЕ удаляем parts (дедуп не даст задвоить вставленное на ретрае) и НЕ закрываем сессию.
        stoppedForBudget = true;
        break;
      }

      // Удаляем ТОЛЬКО обработанные части — части, пришедшие во время batchIngest, останутся на след. волну.
      await db.delete(burstPart).where(inArray(burstPart.id, ids));
    }

    if (stoppedForBudget) {
      // Часть (или всё) осталась в буфере. Сессию НЕ закрываем — заливка продолжится после сброса лимита
      // (кнопка «Готово» / debounce). Сообщаем понятно, без грязного отказа и без зависшего бота.
      const resetsAt = formatResetUtc(nextResetUtc());
      const savedSoFar = total?.saved ?? 0;
      if (chatId && msgId) {
        await api
          .editMessageText(
            chatId,
            msgId,
            savedSoFar > 0
              ? `Залил ${savedSoFar}, но упёрся в дневной лимит расхода. Остальное долью после ` +
                  `${resetsAt} — буфер сохранён, ничего не пропадёт. Нажми «Готово» после сброса.`
              : `Дневной лимит расхода исчерпан. Долью заливку после ${resetsAt} — буфер сохранён, ` +
                  `ничего не пропадёт. Нажми «Готово» после сброса.`,
            { reply_markup: doneKeyboard() },
          )
          .catch(() => {});
      }
      return (
        total ?? {
          saved: 0,
          images: 0,
          skipped: 0,
          existingDupes: [],
          inBatchDupes: [],
          existingDupeCount: 0,
          inBatchDupeCount: 0,
          totalClusters: 0,
          stoppedForBudget: true,
        }
      );
    }

    // Буфер пуст → безопасно закрыть сессию.
    await db.delete(burstSession).where(eq(burstSession.userId, userId));
    lastEdit.delete(userId);

    if (total === null) return null; // нечего было заливать / другой вызов всё обработал

    if (chatId && msgId) {
      await api.editMessageText(chatId, msgId, finalText(total)).catch(() => {});
    }
    await markImportDone(userId);
    return total;
  } finally {
    flushing.delete(userId);
  }
}
