import { GrammyError, InlineKeyboard, type Bot, type Context } from 'grammy';
import { getItem, deleteItem, itemDisplayName } from '../../db/items.js';
import { enqueueProcess } from '../../queue/index.js';
import { IMAGE_SHELF } from '../../cluster/assign.js';
import { classify } from '../../ingest/classify.js';
import { handleQuery } from './search.js';
import {
  assignItemCluster,
  createCluster,
  findClusterByNameCI,
  getCluster,
  listClusters,
  updateCentroid,
} from '../../db/clusters.js';
import { updatedCentroid } from '../../cluster/math.js';
import { setEditPending, getEditPending, delEditPending } from '../../db/sessions.js';
import { setProactiveMode } from '../../db/users.js';
import { flushBurst, doneKeyboard } from '../../import/burst.js';
import type { Item } from '../../db/schema.js';

/**
 * Последнее сообщение-переход «↑ Источник» на чат (chatId → {msgId, itemId}).
 * Держим максимум одно: новое вытесняет старое, при удалении item — чистим.
 * Эфемерная навигация — in-memory ок (потеря при рестарте безвредна).
 */
const lastJump = new Map<number, { msgId: number; itemId: string }>();

/**
 * Единственная «живая» карточка поста на чат (chatId → msgId). Новый тап по посту переиспользует
 * её (editMessageText), а не плодит сообщение вниз — список/выдача остаются на месте, спама нет.
 * In-memory ок (как lastJump): после рестарта первый тап создаст новую, старая осиротеет с живыми кнопками.
 */
const lastCard = new Map<number, number>();

/** Потолок длины тела карточки (лимит сообщения Telegram — 4096, оставляем запас под заголовок). */
const CARD_MAX = 3900;

/**
 * Кнопки карточки записи. Условны под доступные действия:
 *  - 🔗 Открыть — если есть внешний url (статьи/ссылки);
 *  - ↑ Источник — только для живых пересылок (есть tgMessageId); у импорта его нет → кнопку не шлём;
 *  - всегда удаление и закрытие.
 */
function cardKeyboard(item: Item): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (item.url) kb.url('🔗 Открыть', item.url);
  if (item.tgMessageId) kb.text('↑ Источник', `src:${item.id}`);
  kb.text('🗑 Удалить', `delc:${item.id}`).text('✕', 'close');
  return kb;
}

/**
 * Тело карточки: заголовок + происхождение + ПОЛНЫЙ текст записи (читаем прямо в боте — у импорта
 * ссылки на оригинал нет). Сырой OCR (ocrText) НЕ показываем — спека §3.4 (только в индекс).
 */
function renderCard(item: Item): string {
  const title = item.title?.trim();
  // Шапку «…» рисуем ТОЛЬКО при настоящем title (ссылки/документы). У чистого текстового поста
  // title нет, sourceName упал бы на префикс rawText — это обрезанный дубль тела, а не заголовок.
  const lines: string[] = title ? [`«${title}»`] : [];
  if (item.sourceChat) lines.push(`📡 из: ${item.sourceChat}`);

  const body = (item.rawText ?? item.description ?? item.transcript ?? '').trim();
  // Тело не повторяет заголовок (когда он есть и совпадает с телом — напр. документ без подписи).
  if (body && body !== title) {
    if (lines.length) lines.push('');
    lines.push(body.length > CARD_MAX ? `${body.slice(0, CARD_MAX)}…` : body);
  }
  return lines.join('\n');
}

/**
 * Показать карточку поста, переиспользуя единственный слот на чат: если карточка уже висит — правим
 * её на месте (editMessageText), иначе создаём новую и запоминаем. Так тап за тапом не плодим сообщения.
 */
async function showCard(ctx: Context, item: Item): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId == null) return;
  const opts = {
    reply_markup: cardKeyboard(item),
    link_preview_options: { is_disabled: true as const },
  };
  const existing = lastCard.get(chatId);
  if (existing != null) {
    try {
      await ctx.api.editMessageText(chatId, existing, renderCard(item), opts);
      return;
    } catch (e) {
      // «not modified» — тапнули тот же пост дважды: ничего не пересоздаём, выходим.
      if (e instanceof GrammyError && e.description.includes('message is not modified')) return;
      // Иначе сообщение недоступно (удалено юзером / не редактируется) — освобождаем слот и шлём новое.
      lastCard.delete(chatId);
    }
  }
  const sent = await ctx.reply(renderCard(item), opts);
  lastCard.set(chatId, sent.message_id);
}

/** Клавиатура под L1-сообщением: поправить категорию + удалить из архива. */
export function fixKeyboard(itemId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('🔀 Не та категория', `fix:${itemId}`)
    .row()
    .text('🗑 Удалить', `del:${itemId}`);
}

export function registerCallbacks(bot: Bot): void {
  // Шаг 1: показать список существующих категорий для переноса.
  bot.callbackQuery(/^fix:(.+)$/, async (ctx) => {
    const itemId = ctx.match[1]!;
    const userId = ctx.from.id;
    const msg = ctx.callbackQuery.message;
    if (!msg) return ctx.answerCallbackQuery();

    // Item мог быть удалён пользователем — не показываем выбор категории «в пустоту».
    if (!(await getItem(itemId))) {
      return ctx.answerCallbackQuery({ text: 'Запись не найдена', show_alert: true });
    }

    const cs = await listClusters(userId);

    await setEditPending(msg.chat.id, msg.message_id, itemId);

    // Существующие категории (до 12) + всегда возможность завести новую вручную.
    const kb = new InlineKeyboard();
    for (const c of cs.slice(0, 12)) {
      kb.text(c.name, `pick:${c.id}`).row();
    }
    kb.text('➕ Новая категория', `newcat:${itemId}`);
    await ctx.editMessageReplyMarkup({ reply_markup: kb });
    await ctx.answerCallbackQuery();
  });

  // Шаг 2: перенести item в выбранную категорию (ручная правка → lock).
  bot.callbackQuery(/^pick:(.+)$/, async (ctx) => {
    const clusterId = ctx.match[1]!;
    const msg = ctx.callbackQuery.message;
    if (!msg) return ctx.answerCallbackQuery();

    const itemId = await getEditPending(msg.chat.id, msg.message_id);
    if (!itemId) {
      return ctx.answerCallbackQuery({ text: 'Сессия правки истекла', show_alert: true });
    }

    const cluster = await getCluster(clusterId);
    if (!cluster || cluster.userId !== ctx.from.id) {
      return ctx.answerCallbackQuery({ text: 'Категория не найдена' });
    }

    const item = await getItem(itemId);
    if (!item) {
      await delEditPending(msg.chat.id, msg.message_id);
      return ctx.answerCallbackQuery({ text: 'Запись не найдена', show_alert: true });
    }

    // Ручная правка учит систему: фиксируем и подтягиваем центроид к этому примеру.
    await assignItemCluster(itemId, clusterId, true);
    if (item?.embedding && cluster.centroid) {
      const next = updatedCentroid(cluster.centroid as number[], cluster.size, item.embedding as number[]);
      await updateCentroid(clusterId, next, cluster.size + 1);
    }

    await delEditPending(msg.chat.id, msg.message_id);
    await ctx.editMessageText(`✅ Перенёс в «${cluster.name}»`);
    await ctx.answerCallbackQuery({ text: 'Готово' });
  });

  // Opt-in проактивных всплытий (режим 2): ответ на первый образец / переключатель из /settings.
  bot.callbackQuery('optin:on', async (ctx) => {
    await setProactiveMode(ctx.from.id, 'on');
    await ctx.editMessageReplyMarkup({}).catch(() => {});
    await ctx.answerCallbackQuery({ text: 'Включил напоминания 🪃' });
  });
  bot.callbackQuery('optin:off', async (ctx) => {
    await setProactiveMode(ctx.from.id, 'off');
    await ctx.editMessageReplyMarkup({}).catch(() => {});
    await ctx.answerCallbackQuery({ text: 'Ок, не буду напоминать' });
  });

  // «📋 Свести» из сообщения о созревании темы (режим 2) → синтез по теме через обычный путь поиска
  // (handleQuery сам уважает бюджет-гард, degraded-фоллбэк и шлёт ответ со ссылками на источники).
  bot.callbackQuery(/^synth:(.+)$/, async (ctx) => {
    const clusterId = ctx.match[1]!;
    const cluster = await getCluster(clusterId);
    if (!cluster || cluster.userId !== ctx.from.id) {
      return ctx.answerCallbackQuery({ text: 'Тема не найдена', show_alert: true });
    }
    await ctx.answerCallbackQuery({ text: 'Свожу…' });
    await handleQuery(ctx, cluster.name);
  });

  // «Повторить» из сообщения о сбое индексации — перезапуск L2 для КОНКРЕТНОЙ записи (это сообщение).
  // Категорию L1 не персистим → восстанавливаем классификацией (картинкам — полка). notifyOnSuccess:
  // при успехе воркер обновит это же сообщение на «доиндексировал».
  bot.callbackQuery(/^reidx:(.+)$/, async (ctx) => {
    const itemId = ctx.match[1]!;
    const item = await getItem(itemId);
    if (!item || item.userId !== ctx.from.id) {
      return ctx.answerCallbackQuery({ text: 'Запись не найдена', show_alert: true });
    }
    const msg = ctx.callbackQuery.message;
    const ack = msg ? { chatId: msg.chat.id, messageId: msg.message_id } : undefined;
    const seed = item.type === 'image' ? IMAGE_SHELF : await classify(item, item.userId);
    await enqueueProcess(itemId, seed, ack, true);
    await ctx.editMessageText(`🔄 Повторяю «${itemDisplayName(item)}»…`).catch(() => {});
    await ctx.answerCallbackQuery({ text: 'Повторяю…' });
  });

  // Переход к источнику: reply на исходное сообщение → по цитате лента скроллит к оригиналу
  // (в личке с ботом прямой ссылки на сообщение нет, reply — единственный нативный способ).
  // Держим максимум один переход на чат: предыдущий удаляем, чтобы не плодить мёртвые сообщения.
  bot.callbackQuery(/^src:(.+)$/, async (ctx) => {
    const itemId = ctx.match[1]!;
    const item = await getItem(itemId);
    const chatId = ctx.chat?.id;
    if (!item?.tgMessageId || !chatId) {
      return ctx.answerCallbackQuery({ text: 'Исходное сообщение недоступно' });
    }
    const prev = lastJump.get(chatId);
    if (prev) {
      await ctx.api.deleteMessage(chatId, prev.msgId).catch(() => {});
      lastJump.delete(chatId);
    }
    try {
      const sent = await ctx.api.sendMessage(chatId, '↑ Источник', {
        reply_parameters: { message_id: item.tgMessageId },
      });
      lastJump.set(chatId, { msgId: sent.message_id, itemId });
      await ctx.answerCallbackQuery();
    } catch {
      await ctx.answerCallbackQuery({ text: 'Не удалось перейти к сообщению' });
    }
  });

  // Карточка источника из выдачи /find: переход / удаление / закрыть. Свежее сообщение под ответом → видно.
  bot.callbackQuery(/^card:(.+)$/, async (ctx) => {
    const itemId = ctx.match[1]!;
    const item = await getItem(itemId);
    if (!item || item.userId !== ctx.from.id) {
      return ctx.answerCallbackQuery({ text: 'Запись не найдена', show_alert: true });
    }
    await showCard(ctx, item);
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery('close', async (ctx) => {
    await ctx.deleteMessage().catch(() => {});
    // Закрыли отслеживаемую карточку — освобождаем слот (по msgId, чтобы не стереть актуальный).
    const chatId = ctx.chat?.id;
    const msgId = ctx.callbackQuery.message?.message_id;
    if (chatId != null && lastCard.get(chatId) === msgId) lastCard.delete(chatId);
    await ctx.answerCallbackQuery();
  });

  // «Готово» под прогрессом заливки → немедленный флаш буфера. flushBurst сам правит прогресс на итог.
  bot.callbackQuery('import:done', async (ctx) => {
    await ctx.answerCallbackQuery({ text: 'Собираю заливку…' });
    let res;
    try {
      res = await flushBurst(ctx.api, ctx.from.id);
    } catch (err) {
      // Бюджет-стоп flushBurst обрабатывает сам (правит прогресс-сообщение). Сюда долетают лишь прочие
      // сбои (сеть/API): буфер и сессия сохранены — сообщаем без грязного отказа и оставляем кнопку повтора.
      console.error('import flush error:', err);
      await ctx
        .editMessageText('Не получилось долить сейчас — буфер сохранён, нажми «Готово» ещё раз чуть позже.', {
          reply_markup: doneKeyboard(),
        })
        .catch(() => {});
      return;
    }
    if (!res) {
      // Буфер пуст (ничего не переслал или уже флашнули по простою) — убираем кнопку.
      await ctx
        .editMessageText('Заливка пустая — ничего не переслал. Набери /import и перешли сохранённое.')
        .catch(() => {});
    }
  });

  // Удаление — подтверждение НА МЕСТЕ (правим клавиатуру того же сообщения, не шлём вниз).
  // del: — кнопка из fixKeyboard (сообщение-приём); delc: — кнопка из карточки источника.
  bot.callbackQuery(/^del:(.+)$/, async (ctx) => {
    const itemId = ctx.match[1]!;
    const item = await getItem(itemId);
    if (!item || item.userId !== ctx.from.id) {
      return ctx.answerCallbackQuery({ text: 'Запись не найдена', show_alert: true });
    }
    const kb = new InlineKeyboard()
      .text('✅ Удалить', `delok:fix:${itemId}`)
      .text('❌ Отмена', `delno:fix:${itemId}`);
    await ctx.editMessageReplyMarkup({ reply_markup: kb });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^delc:(.+)$/, async (ctx) => {
    const itemId = ctx.match[1]!;
    const item = await getItem(itemId);
    if (!item || item.userId !== ctx.from.id) {
      return ctx.answerCallbackQuery({ text: 'Запись не найдена', show_alert: true });
    }
    const kb = new InlineKeyboard()
      .text('✅ Удалить', `delok:card:${itemId}`)
      .text('❌ Отмена', `delno:card:${itemId}`);
    await ctx.editMessageReplyMarkup({ reply_markup: kb });
    await ctx.answerCallbackQuery();
  });

  // Подтверждено: удаляем item из БД + пересланный пост из чата (если бот ещё может, ~48ч) +
  // висящий переход «↑ Источник» к этому item. Карточку (kind=card) убираем целиком,
  // сообщение-приём (kind=fix) — оставляем меткой «Удалено» (без мёртвых ссылок).
  bot.callbackQuery(/^delok:(fix|card):(.+)$/, async (ctx) => {
    const kind = ctx.match[1]!;
    const itemId = ctx.match[2]!;
    const item = await getItem(itemId); // нужен tgMessageId до удаления
    const ok = await deleteItem(itemId, ctx.from.id);
    const chatId = ctx.chat?.id;
    if (ok && chatId) {
      if (item?.tgMessageId) await ctx.api.deleteMessage(chatId, item.tgMessageId).catch(() => {});
      const jump = lastJump.get(chatId);
      if (jump?.itemId === itemId) {
        await ctx.api.deleteMessage(chatId, jump.msgId).catch(() => {});
        lastJump.delete(chatId);
      }
    }
    if (!ok) {
      await ctx.editMessageText('Запись уже удалена.');
    } else if (kind === 'card') {
      await ctx.deleteMessage().catch(() => {}); // карточку убираем — без мёртвого тумбстоуна
      // Карточка удалена целиком — освобождаем слот (по msgId), чтобы следующий тап создал свежую.
      const msgId = ctx.callbackQuery.message?.message_id;
      if (chatId != null && lastCard.get(chatId) === msgId) lastCard.delete(chatId);
    } else {
      await ctx.editMessageText('🗑 Удалено.');
    }
    await ctx.answerCallbackQuery();
  });

  // Отмена — восстанавливаем исходные кнопки сообщения (fix-приём или карточка).
  bot.callbackQuery(/^delno:(fix|card):(.+)$/, async (ctx) => {
    const kind = ctx.match[1]!;
    const itemId = ctx.match[2]!;
    let kb: InlineKeyboard;
    if (kind === 'card') {
      const item = await getItem(itemId);
      // Запись внезапно пропала — оставляем только закрытие, без мёртвых кнопок.
      kb = item ? cardKeyboard(item) : new InlineKeyboard().text('✕', 'close');
    } else {
      kb = fixKeyboard(itemId);
    }
    await ctx.editMessageReplyMarkup({ reply_markup: kb });
    await ctx.answerCallbackQuery();
  });

  // Новая категория: просим имя через force_reply, ввод привязываем к id сообщения-приглашения.
  bot.callbackQuery(/^newcat:(.+)$/, async (ctx) => {
    const itemId = ctx.match[1]!;
    if (!(await getItem(itemId))) {
      return ctx.answerCallbackQuery({ text: 'Запись не найдена', show_alert: true });
    }
    const prompt = await ctx.reply('Как назвать категорию? Ответь на это сообщение названием.', {
      reply_markup: { force_reply: true },
    });
    await setEditPending(prompt.chat.id, prompt.message_id, itemId);
    await ctx.answerCallbackQuery();
  });

  // Перехват ответа с названием новой категории. Регистрируется ДО ingest (см. bot/index.ts),
  // поэтому ответ на приглашение не уйдёт в сохранение как обычный контент.
  bot.on('message:text', async (ctx, next) => {
    const replyTo = ctx.message.reply_to_message;
    if (!replyTo) return next();

    const itemId = await getEditPending(ctx.chat.id, replyTo.message_id);
    if (!itemId) return next(); // обычный текст → дальше в ingest

    const name = ctx.message.text.trim().slice(0, 40);
    if (!name) {
      await delEditPending(ctx.chat.id, replyTo.message_id);
      await ctx.reply('Пустое название — отменил. Нажми «🔀 Не та категория» ещё раз.');
      return;
    }

    const item = await getItem(itemId);
    if (!item || item.userId !== ctx.from.id) {
      await delEditPending(ctx.chat.id, replyTo.message_id);
      await ctx.reply('Запись не найдена.');
      return;
    }

    const emb = (item.embedding as number[] | null) ?? null;
    const existing = await findClusterByNameCI(ctx.from.id, name);
    if (existing) {
      // Категория уже есть (в любом регистре) — переносим, не плодим дубль. Ручная правка → lock.
      await assignItemCluster(itemId, existing.id, true);
      if (emb && existing.centroid) {
        const nextCentroid = updatedCentroid(existing.centroid as number[], existing.size, emb);
        await updateCentroid(existing.id, nextCentroid, existing.size + 1);
      }
      await ctx.reply(`✅ Перенёс в «${existing.name}».`);
    } else {
      const created = await createCluster(ctx.from.id, name, emb);
      await assignItemCluster(itemId, created.id, true);
      await ctx.reply(`✅ Создал категорию «${name}» и положил туда.`);
    }

    await delEditPending(ctx.chat.id, replyTo.message_id);
  });
}
