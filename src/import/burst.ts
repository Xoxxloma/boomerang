import { eq, inArray, sql } from 'drizzle-orm';
import { InlineKeyboard, type Api } from 'grammy';
import type { Message } from 'grammy/types';
import { db } from '../db/client.js';
import { burstPart, burstSession } from '../db/schema.js';
import {
  enqueueBurstFlush,
  enqueueBurstReflush,
  enqueueBurstReap,
  enqueueBurstFlushAt,
} from '../queue/index.js';
import { markImportDone } from '../db/users.js';
import { batchIngest, DUPE_SAMPLE_CAP, type BatchResult } from './batch.js';
import { draftsFromMessages } from './draft.js';
import { makeProgress, finalText } from './progress.js';
import { checkUserBudget, nextResetUtc, formatResetUtc } from '../ai/usage.js';
import { tuning } from '../config/tuning.js';

/**
 * Массовая заливка пересылок управляется ЯВНЫМ флагом-сессией в БД (строка burst_session) — ТОЛЬКО по
 * команде /import, без эвристики по частоте. Пока сессия активна, ВСЁ (одиночки и альбомы) копится в один
 * буфер burst_part и обрабатывается одним batchIngest — без поштучных «Принял» и без онлайн-кластеризации.
 * Вне сессии каждое сообщение идёт обычным путём (мгновенное «Принял»). Апдейты сериализованы по userId
 * (sequentialize), флаш защищён single-flight guard — двойной обработки буфера нет.
 */
const EDIT_THROTTLE_MS = 2000; // не чаще — переякоривание счётчика вниз (send+delete, лимиты Telegram)
/**
 * Минимальный возраст сессии, при котором «жнец» вправе её погасить. Чуть меньше BURST_REAP_SEC (300с):
 * если сессия моложе — это свежий пере-созданный /import, его погасит собственный, позже стоящий «жнец».
 */
const REAP_MIN_AGE_MS = 290_000;

const lastEdit = new Map<number, number>(); // userId → когда последний раз правили счётчик
const flushing = new Set<number>(); // userId, чей буфер прямо сейчас обрабатывается (single-flight)

/**
 * Кнопка «Отмена» — ТОЛЬКО на стартовом сообщении, пока не пришёл ни один файл. Гасит пустую сессию
 * (не флашит). Как только пошли файлы, счётчик переякоривается без клавиатуры — кнопка исчезает.
 */
export function cancelKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('❌ Отмена', 'import:cancel');
}

/**
 * Надёжно показать статус заливки: шлём НОВОЕ сообщение (всегда оказывается внизу, под пересланными
 * постами; sendMessage не падает как editMessageText «can't be edited»/«not found») и удаляем старый
 * счётчик. Используется для терминальных сообщений (итог/бюджет-стоп/сбой/жнец) — критичный путь.
 */
async function replaceStatus(
  api: Api,
  chatId: number,
  oldMsgId: number | null,
  text: string,
): Promise<Message | null> {
  const sent = await api.sendMessage(chatId, text).catch(() => null);
  if (oldMsgId != null) await api.deleteMessage(chatId, oldMsgId).catch(() => {});
  return sent;
}

/** Текущие координаты прогресс-сообщения сессии (хендлер мог переякорить — читаем перед правкой итога). */
async function currentAnchor(userId: number): Promise<{ chatId: number; msgId: number } | null> {
  const [s] = await db
    .select({ chatId: burstSession.progressChatId, msgId: burstSession.progressMessageId })
    .from(burstSession)
    .where(eq(burstSession.userId, userId))
    .limit(1);
  return s?.chatId && s?.msgId ? { chatId: s.chatId, msgId: s.msgId } : null;
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
 * именно сейчас создана (false — уже была активна). Шлёт стартовое сообщение с кнопкой «Отмена» и
 * ставит «жнец» забытой пустой сессии (enqueueBurstReap).
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
    'с паузами. Перестанешь кидать — через пару секунд соберу всё сам и пришлю итог. Передумал — нажми «Отмена».';
  const progress = await api.sendMessage(chatId, text, { reply_markup: cancelKeyboard() }).catch(() => null);
  if (progress) {
    await db
      .update(burstSession)
      .set({ progressChatId: progress.chat.id, progressMessageId: progress.message_id })
      .where(eq(burstSession.userId, userId));
  }
  await enqueueBurstReap(userId); // забытую пустую сессию погасит «жнец» (reapEmptyImport)
  return true;
}

/**
 * Отмена ПУСТОЙ сессии заливки (кнопка «Отмена» на стартовом сообщении). Гасим только если в буфер
 * так и не пришло ни одной пересылки (count === 0) — начатую заливку не выбрасываем. Возвращает true,
 * если сессия отменена. Само сообщение правит вызывающий (callback).
 */
export async function discardEmptyImport(userId: number): Promise<boolean> {
  const [s] = await db
    .select({ count: burstSession.count })
    .from(burstSession)
    .where(eq(burstSession.userId, userId))
    .limit(1);
  if (!s || s.count > 0) return false; // сессии нет / файлы уже пошли — не отменяем
  await db.delete(burstPart).where(eq(burstPart.userId, userId)); // на всякий случай (обычно пусто)
  await db.delete(burstSession).where(eq(burstSession.userId, userId));
  lastEdit.delete(userId);
  return true;
}

/**
 * «Жнец» забытой пустой сессии (debounce-воркер, см. enqueueBurstReap). Гасим сессию, ТОЛЬКО если в
 * неё так и не пришло ни одной пересылки (count === 0) и она достаточно старая (≈BURST_REAP_SEC) — так
 * не тронем свежую пере-созданную сессию (у неё свой «жнец») и не оборвём начатую заливку.
 */
export async function reapEmptyImport(api: Api, userId: number): Promise<void> {
  const [s] = await db
    .select()
    .from(burstSession)
    .where(eq(burstSession.userId, userId))
    .limit(1);
  if (!s || s.count > 0) return;
  if (Date.now() - s.createdAt.getTime() < REAP_MIN_AGE_MS) return; // свежая сессия — пропускаем
  await db.delete(burstSession).where(eq(burstSession.userId, userId));
  lastEdit.delete(userId);
  if (s.progressChatId) {
    await replaceStatus(
      api,
      s.progressChatId,
      s.progressMessageId,
      'Режим заливки выключен — ничего не пришло. Набери /import, когда будешь готов.',
    );
  }
}

/** Положить сообщение в буфер заливки + троттленно обновить счётчик. */
async function bufferPart(api: Api, userId: number, msg: Message): Promise<void> {
  await db.insert(burstPart).values({ userId, message: msg });
  const [s] = await db
    .update(burstSession)
    .set({ count: sql`${burstSession.count} + 1` })
    .where(eq(burstSession.userId, userId))
    .returning();

  // ОДНО сообщение-счётчик на всю заливку. На ПЕРВОМ файле один раз переякориваем вниз: шлём счётчик в
  // конец чата (без клавиатуры), удаляем стартовое сообщение с «Отмена» (отмены после файлов нет) и
  // запоминаем новые координаты. Дальше правим этот счётчик НА МЕСТЕ (троттленно) — без повторных
  // send+delete, поэтому ни двойных сообщений, ни гонок за message_id. Итог придёт отдельным сообщением.
  if (s) {
    const text = `Собираю заливку… принял ${s.count}`;
    if (s.count === 1) {
      const fresh = await api.sendMessage(msg.chat.id, text).catch(() => null);
      if (fresh) {
        if (s.progressChatId && s.progressMessageId) {
          await api.deleteMessage(s.progressChatId, s.progressMessageId).catch(() => {});
        }
        await db
          .update(burstSession)
          .set({ progressChatId: fresh.chat.id, progressMessageId: fresh.message_id })
          .where(eq(burstSession.userId, userId));
        lastEdit.set(userId, Date.now());
      }
    } else if (s.progressChatId && s.progressMessageId) {
      const now = Date.now();
      if (now - (lastEdit.get(userId) ?? 0) >= EDIT_THROTTLE_MS) {
        lastEdit.set(userId, now);
        await api.editMessageText(s.progressChatId, s.progressMessageId, text).catch(() => {});
      }
    }
  }
  await enqueueBurstFlush(userId); // кикофф/добор авто-флаша по тишине
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
 * сигнала. Буфер и сессия целы (flushBurst при броске их не трогает) — pg-boss доретраит сам, а
 * следующая пересылка довезёт заново. Best-effort.
 */
export async function notifyBurstFlushFailed(api: Api, userId: number): Promise<void> {
  const [session] = await db
    .select({ chatId: burstSession.progressChatId, msgId: burstSession.progressMessageId })
    .from(burstSession)
    .where(eq(burstSession.userId, userId))
    .limit(1);
  if (!session?.chatId) return;
  // Сессия цела — шлём свежим сообщением и переписываем якорь (ретрай/следующая пересылка работают с ним).
  const sent = await replaceStatus(
    api,
    session.chatId,
    session.msgId,
    'Не получилось долить заливку сейчас — буфер сохранён, ничего не пропало. Дозалью сам; если долго ' +
      'тихо — пришли /import ещё раз.',
  );
  if (sent) {
    await db
      .update(burstSession)
      .set({ progressChatId: sent.chat.id, progressMessageId: sent.message_id })
      .where(eq(burstSession.userId, userId));
  }
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
 * Флаш заливки (debounce-кикофф + добор по тишине / авто-возобновление). Single-flight guard: если
 * буфер юзера уже обрабатывается (параллельные кикофф + reflush), второй вызов выходит сразу — двойной
 * обработки нет.
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

      // Гейт оседания (трейлинг-завершение): пока ничего в этом вызове не обработали (total===null) и
      // ЛЮБАЯ часть пришла <burstSettleMs назад — НЕ флашим, ждём «тишины». Так заливка завершается через
      // ~2-3с после ПОСЛЕДНЕЙ отправки (а не после первой), и альбом не рвётся на пост + сиротские картинки.
      // Откладываем коротким добором, буфер/сессию не трогаем; сообщение НЕ правим — счётчиком владеет
      // хендлер bufferPart (иначе фон и хендлер задвоят прогресс). После первой волны (total!==null) не
      // ждём: опоздавший осколок уже-постнутого альбома отсеет дроп в batchIngest.
      if (total === null) {
        const now = Date.now();
        const stillArriving = parts.some((p) => now - p.createdAt.getTime() < tuning.burstSettleMs);
        if (stillArriving) {
          await enqueueBurstReflush(userId);
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
      // Часть (или всё) осталась в буфере. Сессию НЕ закрываем — заливку возобновим сами после сброса
      // лимита (enqueueBurstFlushAt). Сообщаем понятно, без грязного отказа и без зависшего бота.
      const reset = nextResetUtc();
      const resetsAt = formatResetUtc(reset);
      await enqueueBurstFlushAt(userId, (reset.getTime() - Date.now()) / 1000);
      const savedSoFar = total?.saved ?? 0;
      const anchor = await currentAnchor(userId);
      const budgetText =
        savedSoFar > 0
          ? `Залил ${savedSoFar}, но упёрся в дневной лимит расхода. Остальное долью сам после ` +
            `${resetsAt} — буфер сохранён, ничего не пропадёт.`
          : `Дневной лимит расхода исчерпан. Долью заливку сам после ${resetsAt} — буфер сохранён, ` +
            `ничего не пропадёт.`;
      // Сессия НЕ закрыта — шлём свежим сообщением и переписываем якорь, чтобы возобновление работало с ним.
      const sent = await replaceStatus(api, anchor?.chatId ?? userId, anchor?.msgId ?? null, budgetText);
      if (sent) {
        await db
          .update(burstSession)
          .set({ progressChatId: sent.chat.id, progressMessageId: sent.message_id })
          .where(eq(burstSession.userId, userId));
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

    // Буфер пуст → безопасно закрыть сессию. Якорь перечитываем СЕЙЧАС: хендлер мог переякорить счётчик
    // во время долгого batchIngest, и стартовый msgId уже удалён.
    const anchor = await currentAnchor(userId);
    await db.delete(burstSession).where(eq(burstSession.userId, userId));
    lastEdit.delete(userId);

    if (total === null) return null; // нечего было заливать / другой вызов всё обработал

    // Итог — НОВЫМ сообщением вниз (надёжно, всегда под постами), счётчик удаляем. chatId в личке = userId.
    await replaceStatus(api, anchor?.chatId ?? userId, anchor?.msgId ?? null, finalText(total));
    await markImportDone(userId);
    return total;
  } finally {
    flushing.delete(userId);
  }
}
