import { InlineKeyboard, type Bot, type Context } from 'grammy';
import { getItem, deleteItem, itemDisplayName, listClusterContentFields } from '../../db/items.js';
import { hasRealContent } from '../../ingest/extract.js';
import { enqueueProcess } from '../../queue/index.js';
import { IMAGE_SHELF } from '../../cluster/assign.js';
import { classify } from '../../ingest/classify.js';
import { respondWithSynthesis } from './search.js';
import { listClusterItems } from '../../retrieval/search.js';
import { checkUserBudget, formatResetUtc } from '../../ai/usage.js';
import { tuning } from '../../config/tuning.js';
import {
  assignItemCluster,
  createCluster,
  findClusterByNameCI,
  getCluster,
  listClusters,
  recomputeClusterStats,
} from '../../db/clusters.js';
import { setEditPending, getEditPending, delEditPending } from '../../db/sessions.js';
import { setProactiveMode } from '../../db/users.js';
import { flushBurst, doneKeyboard, startImport } from '../../import/burst.js';
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
async function showPhotoCard(ctx: Context, chatId: number, item: Item): Promise<void> {
  const existing = lastCard.get(chatId);
  if (existing != null) {
    await ctx.api.deleteMessage(chatId, existing).catch(() => {});
    lastCard.delete(chatId);
  }
  try {
    const sent = await ctx.replyWithPhoto(item.tgFileId!, {
      caption: imageCaption(item),
      reply_markup: cardKeyboard(item),
    });
    lastCard.set(chatId, sent.message_id);
  } catch {
    // file_id мог протухнуть (фото не отдаётся) — не оставляем юзера без карточки: шлём текстовый фолбэк.
    const sent = await ctx.reply(renderCard(item), {
      reply_markup: cardKeyboard(item),
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
  // Картинку показываем как фото (видно содержимое), остальное — текстовой карточкой.
  if (item.type === 'image' && item.tgFileId) {
    await showPhotoCard(ctx, chatId, item);
    return;
  }
  const opts = {
    reply_markup: cardKeyboard(item),
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

/** Клавиатура под L1-сообщением: поправить категорию + удалить из архива. */
export function fixKeyboard(itemId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('🔀 Не та категория', `fix:${itemId}`)
    .row()
    .text('🗑 Удалить', `del:${itemId}`);
}

/**
 * Клавиатура под сообщением о дубле: «↑ Источник» (реплай к оригиналу — единственный нативный
 * способ «дать ссылку» в личке) + удаление. 🔗 Открыть — если у записи есть внешний url.
 * Колбэки src:/del: уже зарегистрированы.
 */
export function sourceKeyboard(item: Item): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (item.url) kb.url('🔗 Открыть', item.url);
  if (item.tgMessageId) kb.text('↑ Источник', `src:${item.id}`);
  kb.text('🗑 Удалить', `del:${item.id}`);
  return kb;
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
    kb.text('➕ Новая категория', `newcat:${itemId}`).row();
    kb.text('⬅ Назад', `unfix:${itemId}`);
    await ctx.editMessageReplyMarkup({ reply_markup: kb });
    await ctx.answerCallbackQuery();
  });

  // Выход из режима выбора категории обратно к L1-клавиатуре (🔀/🗑) — чтобы не было дедлока.
  bot.callbackQuery(/^unfix:(.+)$/, async (ctx) => {
    const itemId = ctx.match[1]!;
    await ctx.editMessageReplyMarkup({ reply_markup: fixKeyboard(itemId) }).catch(() => {});
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
    if (!item || item.userId !== ctx.from.id) {
      await delEditPending(msg.chat.id, msg.message_id);
      return ctx.answerCallbackQuery({ text: 'Запись не найдена', show_alert: true });
    }

    // Ручная правка учит систему: фиксируем и пересчитываем центроид/size кластера от истины.
    const prevClusterId = item.clusterId;
    await assignItemCluster(itemId, clusterId, true);
    await recomputeClusterStats(clusterId);
    // Запись ушла из прежнего кластера — его статистику тоже пересчитываем (иначе центроид/size «помнят» её).
    if (prevClusterId && prevClusterId !== clusterId) await recomputeClusterStats(prevClusterId);

    await delEditPending(msg.chat.id, msg.message_id);
    await ctx.editMessageText(`✅ Перенёс в «${cluster.name}»`);
    await ctx.answerCallbackQuery({ text: 'Готово' });
  });

  // Opt-in проактивных всплытий (режим 2): ответ на первый образец / переключатель из /settings.
  bot.callbackQuery('optin:on', async (ctx) => {
    await setProactiveMode(ctx.from.id, 'on');
    await ctx.editMessageReplyMarkup({}).catch(() => {});
    await ctx.answerCallbackQuery({ text: 'Включил напоминания' });
  });
  bot.callbackQuery('optin:off', async (ctx) => {
    await setProactiveMode(ctx.from.id, 'off');
    await ctx.editMessageReplyMarkup({}).catch(() => {});
    await ctx.answerCallbackQuery({ text: 'Ок, не буду напоминать' });
  });

  // «📋 Свести «тему»» → связный синтез по РЕАЛЬНЫМ записям кластера (clusterId у нас есть). НЕ гоним
  // имя темы через handleQuery/parseQuery: иначе имя-как-вид-материала («Документы») распознаётся как
  // фильтр-тип и уводит в плоский список без синтеза. respondWithSynthesis сам уважает degraded-фоллбэк.
  bot.callbackQuery(/^synth:(.+)$/, async (ctx) => {
    const clusterId = ctx.match[1]!;
    const userId = ctx.from.id;
    const cluster = await getCluster(clusterId);
    if (!cluster || cluster.userId !== userId) {
      return ctx.answerCallbackQuery({ text: 'Тема не найдена', show_alert: true });
    }

    // Изображения не сводятся (нет текста, §3.4). Кнопку для полки не даём, но старая (stale) могла
    // остаться в прежнем сообщении — отвечаем честно, а не гоним LLM на «отказ».
    if (cluster.name === IMAGE_SHELF) {
      return ctx.answerCallbackQuery({
        text: 'По изображениям сводка не строится — у них нет текста.',
        show_alert: true,
      });
    }

    // Бюджет-гард (как в handleQuery): не тратим синтез сверх персонального/глобального потолка.
    const budget = checkUserBudget(userId);
    if (!budget.allowed) {
      return ctx.answerCallbackQuery({
        text:
          budget.reason === 'user'
            ? `Дневной лимит запросов исчерпан. Обновится в ${formatResetUtc(budget.resetsAt)}.`
            : 'Синтез временно недоступен из-за нагрузки — попробуй позже.',
        show_alert: true,
      });
    }

    const clusterItems = await listClusterItems(userId, clusterId, tuning.synthMaxSources);
    if (clusterItems.length === 0) {
      return ctx.answerCallbackQuery({ text: 'В этой теме пока нечего сводить', show_alert: true });
    }

    await ctx.answerCallbackQuery({ text: 'Свожу…' });
    const hits = clusterItems.map((item) => ({ item, similarity: 1 }));
    // Честность сводки: пустышки (только имя файла/URL) фактов не дадут и могут не процитироваться —
    // молчаливое «исчезновение» источников выглядит багом. Считаем по ПОЛНОМУ кластеру (лёгкий селект,
    // listClusterItems обрезан synthMaxSources) и говорим прямо.
    const fields = await listClusterContentFields(userId, clusterId);
    const empty = fields.filter((f) => !hasRealContent(f)).length;
    const footnote =
      empty > 0
        ? `ℹ️ Ещё ${empty} матер. в теме не прочитаны (только имя файла/ссылка) — фактов из них в сводке нет.`
        : undefined;
    await respondWithSynthesis(ctx, cluster.name, hits, userId, { footnote });
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

  // «Залить из Избранного» с приветственного экрана → старт сессии заливки (эквивалент /import).
  bot.callbackQuery('import:start', async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId == null) return ctx.answerCallbackQuery();
    const started = await startImport(ctx.api, ctx.from.id, chatId);
    await ctx.answerCallbackQuery(
      started ? { text: 'Режим заливки включён' } : { text: 'Заливка уже идёт — пересылай дальше' },
    );
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
    // Пока ждём имя — у исходного сообщения оставляем только выход назад к списку категорий
    // (на самом force_reply кнопок быть не может — это и создавало дедлок). fix: пересоберёт список.
    await ctx
      .editMessageReplyMarkup({ reply_markup: new InlineKeyboard().text('⬅ Назад', `fix:${itemId}`) })
      .catch(() => {});
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
    const prevClusterId = item.clusterId;
    const existing = await findClusterByNameCI(ctx.from.id, name);
    if (existing) {
      // Категория уже есть (в любом регистре) — переносим, не плодим дубль. Ручная правка → lock.
      await assignItemCluster(itemId, existing.id, true);
      await recomputeClusterStats(existing.id);
      await ctx.reply(`✅ Перенёс в «${existing.name}».`);
    } else {
      // Новый кластер: создаём с эмбеддингом записи как стартовым центроидом (единственный член).
      // При гонке createCluster вернёт существующий одноимённый — пересчёт stats обязателен.
      const created = await createCluster(ctx.from.id, name, emb);
      await assignItemCluster(itemId, created.id, true);
      await recomputeClusterStats(created.id);
      await ctx.reply(`✅ Создал категорию «${name}» и положил туда.`);
    }
    // Запись ушла из прежнего кластера — пересчитываем его статистику от истины.
    if (prevClusterId) await recomputeClusterStats(prevClusterId);

    await delEditPending(ctx.chat.id, replyTo.message_id);
  });
}
