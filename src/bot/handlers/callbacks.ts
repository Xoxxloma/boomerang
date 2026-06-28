import { InlineKeyboard, type Bot, type Context } from 'grammy';
import { getItem, deleteItem, itemDisplayName, listSimilarItems } from '../../db/items.js';
import { tuning } from '../../config/tuning.js';
import { enqueueProcess } from '../../queue/index.js';
import { discardEmptyImport, startImport } from '../../import/burst.js';
import { saveItem, duplicateText } from '../../ingest/save.js';
import { handleQuery } from './search.js';
import type { Item } from '../../db/schema.js';

/**
 * Последнее сообщение-переход «↑ Источник» на чат (chatId → {msgId, itemId}).
 * Держим максимум одно: новое вытесняет старое, при удалении item — чистим.
 * Эфемерная навигация — in-memory ок (потеря при рестарте безвредна).
 */
const lastJump = new Map<number, { msgId: number; itemId: string }>();

/**
 * Единственная «живая» карточка поста на чат (chatId → msgId). Новый тап по посту удаляет прежнюю и
 * шлёт свежую вниз чата — карточка всегда перед глазами (правка на месте была невидима при скролле).
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
function cardKeyboard(item: Item, similar: Item[] = [], expanded = false): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (item.url) kb.url('🔗 Открыть', item.url);
  if (item.tgMessageId) kb.text('↑ Источник', `src:${item.id}`);
  if (item.url || item.tgMessageId) kb.row();
  // Управление записью живёт здесь (а не на сообщении-приёме): напомнить + удалить. Категорий нет —
  // организация по источнику. rem:/delc: уже зарегистрированы.
  kb.text('🪃 Напомнить', `rem:${item.id}`).text('🗑 Удалить', `delc:${item.id}`).row();
  // «Похожие» — семантически близкие записи (item-kNN, та же нить, что в Карте). Чтобы не раздувать
  // карточку, по умолчанию это ОДНА кнопка-разворот (sim:); по тапу она раскрывается в 1-3 соседа,
  // каждый из которых открывается отдельно (card:). Кнопку не показываем, если соседей нет.
  if (similar.length > 0) {
    if (expanded) {
      for (const n of similar) kb.text(`🪐 ${truncate(itemDisplayName(n), 40)}`, `card:${n.id}`).row();
    } else {
      kb.text(`🪐 Похожие (${similar.length})`, `sim:${item.id}`).row();
    }
  }
  kb.text('✕', 'close');
  return kb;
}

/** Усечение подписи кнопки-соседа (длинные заголовки переносятся и ломают вид). */
function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
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
  // Никогда не отдаём пустую строку (Telegram отвергнет sendMessage('')): фолбэк — имя записи.
  return lines.join('\n') || itemDisplayName(item);
}

/** Подпись фото-карточки: только источник (сырой OCR не показываем, §3.4). Пусто → без подписи. */
function imageCaption(item: Item): string | undefined {
  return item.sourceChat ? `📡 из: ${item.sourceChat}` : undefined;
}

/**
 * Карточка картинки = САМО фото (а не текст): у голого изображения нет заголовка/тела, и текстовая
 * карточка была пустой — «не видно, что за изображение». Фото нельзя editMessageText, поэтому слот
 * карточки пересоздаём: удаляем прежнюю (любого типа) и шлём фото.
 */
async function showPhotoCard(ctx: Context, chatId: number, item: Item, similar: Item[]): Promise<void> {
  const existing = lastCard.get(chatId);
  if (existing != null) {
    await ctx.api.deleteMessage(chatId, existing).catch(() => {});
    lastCard.delete(chatId);
  }
  try {
    const sent = await ctx.replyWithPhoto(item.tgFileId!, {
      caption: imageCaption(item),
      reply_markup: cardKeyboard(item, similar),
    });
    lastCard.set(chatId, sent.message_id);
  } catch {
    // file_id мог протухнуть (фото не отдаётся) — не оставляем юзера без карточки: шлём текстовый фолбэк.
    const sent = await ctx.reply(renderCard(item), {
      reply_markup: cardKeyboard(item, similar),
      link_preview_options: { is_disabled: true as const },
    });
    lastCard.set(chatId, sent.message_id);
  }
}

/**
 * Показать карточку поста в единственном слоте на чат: прежнюю карточку (если висит) удаляем и шлём
 * свежую ВНИЗ чата (как showPhotoCard). Правка на месте была невидима, когда карточка уезжала вверх —
 * теперь она всегда перед глазами. Повторный тап по тому же посту просто переносит карточку вниз.
 */
async function showCard(ctx: Context, item: Item): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId == null) return;
  // Семантические соседи (item-kNN) для блока «Рядом». У записи без вектора вернётся [] — блока нет.
  const similar = await listSimilarItems(item.userId, item, tuning.similarLimit);
  // Картинку показываем как фото (видно содержимое), остальное — текстовой карточкой.
  if (item.type === 'image' && item.tgFileId) {
    await showPhotoCard(ctx, chatId, item, similar);
    return;
  }
  const opts = {
    reply_markup: cardKeyboard(item, similar),
    link_preview_options: { is_disabled: true as const },
  };
  const existing = lastCard.get(chatId);
  if (existing != null) {
    await ctx.api.deleteMessage(chatId, existing).catch(() => {});
    lastCard.delete(chatId);
  }
  const sent = await ctx.reply(renderCard(item), opts);
  lastCard.set(chatId, sent.message_id);
}

/**
 * Клавиатура под сообщением о дубле: одна кнопка, открывающая полную карточку записи — тот же UI,
 * что и в результатах поиска (card:). В карточке уже живут «🔗 Открыть», «↑ Источник», «🪃 Напомнить»
 * и рабочее удаление (delc: → подтверждение). Колбэк card: уже зарегистрирован.
 */
export function duplicateKeyboard(item: Item): InlineKeyboard {
  return new InlineKeyboard().text('🗂 Открыть карточку', `card:${item.id}`);
}

export function registerCallbacks(bot: Bot): void {
  // Развилка «Найти / Сохранить» по сырому набранному тексту (ingest.ts шлёт «Что делаем?» как reply).
  // Текст берём из reply_to_message — stateless, без таблицы (в callback_data он бы не влез, лимит 64б).
  bot.callbackQuery(/^fork:(search|save)$/, async (ctx) => {
    const action = ctx.match[1]!; // 'search' | 'save'
    const cbMsg = ctx.callbackQuery.message;
    // reply_to_message есть только у полного Message (не InaccessibleMessage) — narrowing через 'in'.
    const original = cbMsg && 'reply_to_message' in cbMsg ? cbMsg.reply_to_message : undefined;
    const text = original?.text?.trim();
    const chatId = ctx.chat?.id;

    // Контекст потерян: развилка протухла (>48ч → inaccessible) либо исходный текст недоступен.
    if (!cbMsg || !original || !text || chatId == null) {
      await ctx.editMessageText('Текст потерялся — напиши заново.').catch(() => {});
      return ctx.answerCallbackQuery();
    }

    if (action === 'search') {
      // Развилку убираем целиком: итог поиска придёт отдельным сообщением со своими кнопками-источниками.
      await ctx.deleteMessage().catch(() => {});
      await handleQuery(ctx, text);
      return ctx.answerCallbackQuery();
    }

    // 'save': переиспользуем развилку как ack-сообщение. editMessageText снимает inline-кнопки →
    // защита от двойного тапа; повторное сохранение отсёк бы findDuplicateItem внутри saveItem.
    // detectReminder:true — «напомни …» ловится тем же дешёвым вызовом, как при обычном приёме.
    await ctx.editMessageText('🔖 Принял, обрабатываю…').catch(() => {});
    const ackRef = { chatId, messageId: cbMsg.message_id };
    const { item, duplicate } = await saveItem(ctx.api, ctx.from.id, original, ackRef, {
      detectReminder: true,
    });
    if (duplicate) {
      await ctx
        .editMessageText(duplicateText(item), { reply_markup: duplicateKeyboard(item) })
        .catch(() => {});
    }
    // Не дубль → L2-воркер финализирует это же ack-сообщение в «✅ Принял — «заголовок»» (queue/worker.ts).
    await ctx.answerCallbackQuery();
  });

  // «Повторить» из сообщения о сбое индексации — перезапуск L2 для КОНКРЕТНОЙ записи (это сообщение).
  // notifyOnSuccess: при успехе воркер обновит это же сообщение на «доиндексировал».
  bot.callbackQuery(/^reidx:(.+)$/, async (ctx) => {
    const itemId = ctx.match[1]!;
    const item = await getItem(itemId);
    if (!item || item.userId !== ctx.from.id) {
      return ctx.answerCallbackQuery({ text: 'Запись не найдена', show_alert: true });
    }
    const msg = ctx.callbackQuery.message;
    const ack = msg ? { chatId: msg.chat.id, messageId: msg.message_id } : undefined;
    await enqueueProcess(itemId, ack, true);
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

  // «🪐 Похожие» в карточке: разворачиваем кнопку-свёртку в 1-3 соседа правкой клавиатуры ТОГО ЖЕ
  // сообщения (карточка не пересоздаётся). Соседи пересчитываются на клик — актуальны на момент тапа.
  bot.callbackQuery(/^sim:(.+)$/, async (ctx) => {
    const itemId = ctx.match[1]!;
    const item = await getItem(itemId);
    if (!item || item.userId !== ctx.from.id) {
      return ctx.answerCallbackQuery({ text: 'Запись не найдена', show_alert: true });
    }
    const similar = await listSimilarItems(item.userId, item, tuning.similarLimit);
    if (similar.length === 0) {
      // Соседи исчезли (удалены) с момента показа карточки — честно говорим, клавиатуру не трогаем.
      return ctx.answerCallbackQuery({ text: 'Похожих записей нет' });
    }
    await ctx.editMessageReplyMarkup({ reply_markup: cardKeyboard(item, similar, true) }).catch(() => {});
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

  // «Залить из Избранного» с приветственного экрана → старт сессии заливки (эквивалент /import).
  bot.callbackQuery('import:start', async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId == null) return ctx.answerCallbackQuery();
    const started = await startImport(ctx.api, ctx.from.id, chatId);
    await ctx.answerCallbackQuery(
      started ? { text: 'Режим заливки включён' } : { text: 'Заливка уже идёт — пересылай дальше' },
    );
  });

  // «Отмена» на стартовом сообщении заливки (живёт ТОЛЬКО до первого файла) → гасим пустую сессию.
  // discardEmptyImport не тронет уже начатую заливку (count>0) — её завершит авто-флаш по тишине.
  bot.callbackQuery('import:cancel', async (ctx) => {
    const cancelled = await discardEmptyImport(ctx.from.id);
    await ctx.answerCallbackQuery({ text: cancelled ? 'Заливка отменена' : 'Файлы уже пошли — заканчиваю' });
    if (cancelled) {
      await ctx.editMessageText('Заливка отменена. Набери /import, когда будешь готов.').catch(() => {});
    }
  });

  // Удаление — подтверждение НА МЕСТЕ (правим клавиатуру того же сообщения). delc: — из карточки записи.
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
  // висящий переход «↑ Источник» к этому item. Карточку убираем целиком (без мёртвого тумбстоуна).
  bot.callbackQuery(/^delok:card:(.+)$/, async (ctx) => {
    const itemId = ctx.match[1]!;
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
    } else {
      await ctx.deleteMessage().catch(() => {}); // карточку убираем — без мёртвого тумбстоуна
      // Карточка удалена целиком — освобождаем слот (по msgId), чтобы следующий тап создал свежую.
      const msgId = ctx.callbackQuery.message?.message_id;
      if (chatId != null && lastCard.get(chatId) === msgId) lastCard.delete(chatId);
    }
    await ctx.answerCallbackQuery();
  });

  // Отмена удаления — восстанавливаем кнопки карточки.
  bot.callbackQuery(/^delno:card:(.+)$/, async (ctx) => {
    const itemId = ctx.match[1]!;
    const item = await getItem(itemId);
    // Запись внезапно пропала — оставляем только закрытие, без мёртвых кнопок.
    const similar = item ? await listSimilarItems(item.userId, item, tuning.similarLimit) : [];
    const kb = item ? cardKeyboard(item, similar) : new InlineKeyboard().text('✕', 'close');
    await ctx.editMessageReplyMarkup({ reply_markup: kb });
    await ctx.answerCallbackQuery();
  });
}
