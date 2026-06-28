import { InlineKeyboard, Keyboard, type Bot, type Context } from 'grammy';
import { env } from '../../config/env.js';
import { search, listByFilter, type SearchHit } from '../../retrieval/search.js';
import { parseQuery } from '../../retrieval/parseQuery.js';
import { synthesize, extractCitedIndices, sourceName } from '../../retrieval/synthesize.js';
import { checkUserBudget, breakerState, formatResetUtc } from '../../ai/usage.js';
import { tuning } from '../../config/tuning.js';
import type { Item } from '../../db/schema.js';

/** Текст приглашения к поиску — по нему же ловим ответ (эту строку шлёт только бот). */
const SEARCH_PROMPT = '🔍 Что ищем? Напиши запрос ответом на это сообщение.';
/** Подпись постоянной кнопки поиска (reply-клавиатура). */
const SEARCH_BUTTON = '🔍 Найти';
/** Подпись кнопки запуска Mini App на той же reply-клавиатуре. */
const WEBAPP_BUTTON = '🪃 Приложение';
/** Постоянная клавиатура: поиск + вход в Mini App. Web-app-кнопка открывает вебапп прямо из клиента
 *  (команды при этом остаются на кнопке-меню — они не конкурируют). Самовосстанавливается через
 *  трансформер в bot/index.ts, поэтому вход в приложение всегда под рукой. */
export const searchReplyKeyboard = new Keyboard()
  .text(SEARCH_BUTTON)
  .webApp(WEBAPP_BUTTON, env.WEBAPP_URL)
  .resized()
  .persistent();

/** Лимит длины сообщения Telegram. Запас под перевод строк/заголовок при сборке итогового текста. */
const TG_MSG_LIMIT = 4096;
/** Потолок длины URL в строке списка: длинные ссылки (трекеры, токены) раздувают сообщение за лимит. */
const URL_MAX = 120;

/** Строка списка-источника: номер + имя + усечённый URL. Длинные URL рвут лимит Telegram (4096). */
function listLine(it: Item, i: number): string {
  if (!it.url) return `${i + 1}. ${sourceName(it)}`;
  const url = it.url.length > URL_MAX ? `${it.url.slice(0, URL_MAX - 1)}…` : it.url;
  return `${i + 1}. ${sourceName(it)} — ${url}`;
}

/** Собрать список строк в тело сообщения с префиксом, не превышая лимит Telegram. */
function listBody(prefix: string, lines: string[]): string {
  return `${prefix}\n${lines.join('\n')}`.slice(0, TG_MSG_LIMIT);
}

/** Приглашение ввести запрос: force_reply фокусирует поле ответа — пользователь сразу печатает. */
async function promptSearch(ctx: Context): Promise<void> {
  await ctx.reply(SEARCH_PROMPT, {
    reply_markup: { force_reply: true, input_field_placeholder: 'Например: ипотека и ставки' },
  });
}

/** Нумерованный список записей + кнопка-карточка на каждую (метаданные-режим, без синтеза). */
async function replyWithList(ctx: Context, list: Item[], query: string): Promise<void> {
  const lines = list.map((it, i) => listLine(it, i));
  const keyboard = new InlineKeyboard();
  list.forEach((it, i) => keyboard.text(`${i + 1} · ${sourceName(it)}`, `card:${it.id}`).row());
  await ctx.reply(listBody(`Вот что нашёл по «${query}»:`, lines), {
    link_preview_options: { is_disabled: true },
    reply_markup: keyboard,
  });
}

export async function handleQuery(ctx: Context, query: string): Promise<void> {
  await ctx.replyWithChatAction('typing').catch(() => {});
  const userId = ctx.from?.id;
  if (!userId) return;

  // Бюджет-гард (пре-чек): персональный потолок или глобальный paused — чистое сообщение,
  // не тратя даже эмбеддинг. degraded чтение пропускает (синтез ниже сам уйдёт в список).
  const budget = checkUserBudget(userId);
  if (!budget.allowed) {
    await ctx.reply(
      budget.reason === 'user'
        ? `Ты исчерпал дневной лимит запросов. Обновится в ${formatResetUtc(budget.resetsAt)}.`
        : 'Поиск временно недоступен из-за нагрузки — попробуй позже.',
    );
    return;
  }

  // Разбор запроса: фильтры (тип/время) + синонимы. Сам fail-safe, но подстрахуемся.
  let parsed;
  try {
    parsed = await parseQuery(userId, query);
  } catch {
    parsed = { query, types: [], sinceDays: null, expansions: [] };
  }
  const hasFilter = parsed.types.length > 0 || parsed.sinceDays !== null;

  // Метаданные-режим: фильтр есть, смысловой темы нет («документы за две недели») →
  // список по свежести, без LLM-синтеза (нечего связывать в ответ).
  if (hasFilter && !parsed.query) {
    let list: Item[];
    try {
      list = await listByFilter(userId, { types: parsed.types, sinceDays: parsed.sinceDays });
    } catch (err) {
      console.error('listByFilter error:', err);
      await ctx.reply('Поиск сейчас недоступен — попробуй ещё раз через минуту.');
      return;
    }
    if (list.length === 0) {
      await ctx.reply(
        `Пока ничего не нашёл по «${query}». Перешли что-нибудь по этой теме — и спроси снова.`,
      );
      return;
    }
    await replyWithList(ctx, list, query);
    return;
  }

  let hits;
  try {
    const opts = { types: parsed.types, sinceDays: parsed.sinceDays, expansions: parsed.expansions };
    hits = await search(userId, parsed.query || query, opts);
    // Пустая выдача ≠ «нет в архиве»: релевантное могло не пройти обычный порог из-за разрыва
    // формулировок (спросили «не теми словами»). Второй проход с recall-порогом (ниже) поднимает
    // близкое; шум сдерживают лимит выдачи + сортировка по убыванию похожести. Один дешёвый доп-embed
    // ТОЛЬКО на пустой выдаче.
    if (hits.length === 0) {
      hits = await search(userId, parsed.query || query, {
        ...opts,
        minSimilarity: tuning.searchRecallMinSimilarity,
      });
    }
  } catch (err) {
    // Эмбеддинг/БД отвалились (напр. OpenAI через VPN) — поиск это главный сценарий, нельзя молчать.
    console.error('search error:', err);
    await ctx.reply('Поиск сейчас недоступен — попробуй ещё раз через минуту.');
    return;
  }

  if (hits.length === 0) {
    await ctx.reply(
      `Пока ничего не нашёл по «${query}». Перешли что-нибудь по этой теме — и спроси снова.`,
    );
    return;
  }

  await respondWithSynthesis(ctx, query, hits, userId);
}

/**
 * Связный синтез по уже найденным источникам (§6, режим 1) + кнопки процитированных источников.
 * Общий хвост для /find (после search) и «Свести «тему»» (по записям кластера напрямую).
 * degraded (breaker не normal) → список источников; падение LLM → список как запасной вариант.
 * opts.footnote — строка-приписка после ответа (кластерная сводка честно сообщает о невошедших
 * пустышках); обычный поиск её не передаёт — там скрытие нерелевантного корректно.
 */
export async function respondWithSynthesis(
  ctx: Context,
  query: string,
  hits: SearchHit[],
  userId: number,
  opts?: { footnote?: string },
): Promise<void> {
  // degraded: дорогой синтез на паузе — отдаём список источников (чтение продолжает работать).
  if (breakerState() !== 'normal') {
    await replyWithList(ctx, hits.map((h) => h.item), query);
    return;
  }

  let answer: string;
  let sources;
  try {
    ({ answer, sources } = await synthesize(query, hits, userId));
  } catch (err) {
    // Синтез (LLM) упал — нашли, но не свели. Покажем хотя бы источники, а не пустоту.
    console.error('synthesize error:', err);
    const lines = hits.slice(0, 8).map((h, i) => listLine(h.item, i));
    await ctx.reply(listBody(`Свести в ответ не вышло, но вот что нашёл по «${query}»:`, lines), {
      link_preview_options: { is_disabled: true },
    });
    return;
  }

  // Кнопки извлекаем из УЖЕ обрезанного текста (Telegram-лимит 4096): иначе появились бы кнопки
  // источников, цитаты которых отрезаны и пользователю не видны. Под футер резервируем место.
  const reserve = opts?.footnote ? opts.footnote.length + 2 : 0;
  const shown = answer.slice(0, 4096 - reserve);
  // Показываем кнопки ТОЛЬКО реально процитированных источников.
  // Один пункт на источник во всю ширину; тап открывает карточку (переход/удаление).
  const cited = extractCitedIndices(shown, sources.length);
  let keyboard: InlineKeyboard | undefined;
  if (cited.length > 0) {
    keyboard = new InlineKeyboard();
    for (const n of cited) {
      const it = sources[n - 1]!;
      keyboard.text(`${n} · ${sourceName(it)}`, `card:${it.id}`).row();
    }
  }

  await ctx.reply(opts?.footnote ? `${shown}\n\n${opts.footnote}` : shown, {
    link_preview_options: { is_disabled: true },
    ...(keyboard ? { reply_markup: keyboard } : {}),
  });
}

export function registerSearch(bot: Bot): void {
  // Поиск ТОЛЬКО по явной команде /find <запрос> или кнопке — прозрачно, без угадывания.
  // Любой обычный текст уходит в ingest (сохраняется как контент).
  bot.command('find', async (ctx) => {
    const query = ctx.match.trim();
    if (!query) {
      await promptSearch(ctx); // голый /find → приглашение с фокусом на ввод
      return;
    }
    await handleQuery(ctx, query);
  });

  // Тап по постоянной кнопке «🔍 Найти» → то же приглашение.
  bot.hears(SEARCH_BUTTON, promptSearch);

  // Перехват ответа на приглашение поиска (ДО ingest): этот текст — запрос, не контент.
  bot.on('message:text', async (ctx, next) => {
    if (ctx.message.reply_to_message?.text !== SEARCH_PROMPT) return next();
    const query = ctx.message.text.trim();
    if (!query || query.startsWith('/')) return next();
    await handleQuery(ctx, query);
  });
}
