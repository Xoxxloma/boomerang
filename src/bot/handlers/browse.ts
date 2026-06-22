import { InlineKeyboard, type Bot, type Context } from 'grammy';
import {
  listChannels,
  countSelfUploaded,
  itemsBySourcePage,
  itemsBySelfUploadPage,
  type ItemsPage,
} from '../../db/items.js';
import { sourceName } from '../../retrieval/synthesize.js';
import type { Item } from '../../db/schema.js';

const PAGE_SIZE = 8; // источников на страницу
const ITEM_PAGE_SIZE = 8; // записей на страницу внутри папки
/** Маркер псевдо-папки «Загружено вручную» (sourceChat IS NULL). */
const SELF = 'self';

/**
 * Клавиатура страницы источников: «📥 Загружено вручную» (на первой странице, если есть) + каналы
 * (срез по странице) + строка навигации. Категорий больше нет — организация по источнику.
 */
function sourcesKeyboard(
  page: number,
  pageCount: number,
  channels: { sourceChat: string; count: number }[],
  selfCount: number,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (page === 0 && selfCount > 0) {
    kb.text(`📥 Загружено вручную · ${selfCount}`, `self:0`).row();
  }
  const start = page * PAGE_SIZE;
  channels.slice(start, start + PAGE_SIZE).forEach((ch, j) => {
    // Канал адресуем ГЛОБАЛЬНЫМ индексом (chan:<idx> пере-вычисляет полный список).
    kb.text(`📡 ${ch.sourceChat} · ${ch.count}`, `chan:${start + j}:0`).row();
  });
  if (page > 0) kb.text('◀', `nav:src:${page - 1}`);
  if (page < pageCount - 1) kb.text('▶', `nav:src:${page + 1}`);
  if (page > 0 || page < pageCount - 1) kb.row();
  return kb;
}

/**
 * Клавиатура содержимого папки: записи (глобальная нумерация) + строка навигации
 * `◀ | ⬅ Папки | ▶`.
 */
function contentKeyboard(
  list: Item[],
  page: number,
  pageCount: number,
  offset: number,
  pagePrefix: string, // `chan:<idx>:` | `self:`
): InlineKeyboard {
  const kb = new InlineKeyboard();
  list.forEach((it, i) => {
    kb.text(`${offset + i + 1} · ${sourceName(it)}`, `card:${it.id}`).row();
  });
  if (page > 0) kb.text('◀', `${pagePrefix}${page - 1}`);
  kb.text('⬅ Папки', 'nav:src:0');
  if (page < pageCount - 1) kb.text('▶', `${pagePrefix}${page + 1}`);
  kb.row();
  return kb;
}

/** Показать страницу содержимого папки правкой текущего сообщения. */
async function editContentPage(
  ctx: Context,
  data: ItemsPage,
  page: number,
  title: string,
  pagePrefix: string,
): Promise<void> {
  if (data.total === 0) {
    await ctx.editMessageText(`${title}\n\nПока пусто.`, {
      reply_markup: new InlineKeyboard().text('⬅ Папки', 'nav:src:0'),
    });
    return;
  }
  const pageCount = Math.max(1, Math.ceil(data.total / ITEM_PAGE_SIZE));
  const offset = page * ITEM_PAGE_SIZE;
  await ctx.editMessageText(`${title} — стр. ${page + 1}/${pageCount}`, {
    reply_markup: contentKeyboard(data.items, page, pageCount, offset, pagePrefix),
  });
}

/** Заголовок + клавиатура корневого экрана источников (общий для /folders и nav:src). */
async function sourcesScreen(userId: number, page: number): Promise<{ text: string; kb: InlineKeyboard } | null> {
  const [channels, selfCount] = await Promise.all([listChannels(userId), countSelfUploaded(userId)]);
  if (channels.length === 0 && selfCount === 0) return null;
  const pageCount = Math.max(1, Math.ceil(channels.length / PAGE_SIZE));
  const text = `📂 Источники — стр. ${page + 1}/${pageCount}`;
  return { text, kb: sourcesKeyboard(page, pageCount, channels, selfCount) };
}

export function registerBrowse(bot: Bot): void {
  // /folders — список источников (каналы + «Загружено вручную»). Категорий нет.
  bot.command('folders', async (ctx) => {
    const screen = await sourcesScreen(ctx.from!.id, 0);
    if (!screen) {
      await ctx.reply('Пока пусто — перешли что-нибудь, и здесь появятся источники.');
      return;
    }
    await ctx.reply(screen.text, { reply_markup: screen.kb });
  });

  // Страница источников (постранично, правим то же сообщение).
  bot.callbackQuery(/^nav:src:(\d+)$/, async (ctx) => {
    const page = Number(ctx.match[1]);
    const screen = await sourcesScreen(ctx.from.id, page);
    if (screen) {
      await ctx.editMessageText(screen.text, { reply_markup: screen.kb });
    }
    await ctx.answerCallbackQuery();
  });

  // Открыть/листать канал: chan:<idx>:<page>. Пере-вычисляем список каналов и берём по индексу.
  bot.callbackQuery(/^chan:(\d+):(\d+)$/, async (ctx) => {
    const idx = Number(ctx.match[1]);
    const page = Number(ctx.match[2]);
    const userId = ctx.from.id;
    const channels = await listChannels(userId);
    const channel = channels[idx];
    if (!channel) {
      return ctx.answerCallbackQuery({ text: 'Источник не найден', show_alert: true });
    }
    const data = await itemsBySourcePage(userId, channel.sourceChat, ITEM_PAGE_SIZE, page * ITEM_PAGE_SIZE);
    await editContentPage(ctx, data, page, `📡 «${channel.sourceChat}»`, `chan:${idx}:`);
    await ctx.answerCallbackQuery();
  });

  // Открыть/листать «Загружено вручную»: self:<page>.
  bot.callbackQuery(new RegExp(`^${SELF}:(\\d+)$`), async (ctx) => {
    const page = Number(ctx.match[1]);
    const userId = ctx.from.id;
    const data = await itemsBySelfUploadPage(userId, ITEM_PAGE_SIZE, page * ITEM_PAGE_SIZE);
    await editContentPage(ctx, data, page, '📥 «Загружено вручную»', `${SELF}:`);
    await ctx.answerCallbackQuery();
  });
}
