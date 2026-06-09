import { InlineKeyboard, type Bot, type Context } from 'grammy';
import { listClustersWithCounts, getCluster } from '../../db/clusters.js';
import { listChannels, itemsByClusterPage, itemsBySourcePage, type ItemsPage } from '../../db/items.js';
import { sourceName } from '../../retrieval/synthesize.js';
import type { Item } from '../../db/schema.js';

const PAGE_SIZE = 8; // папок на страницу раздела
const ITEM_PAGE_SIZE = 8; // записей на страницу внутри папки

/** Корневой экран /folders: выбор раздела (категории / каналы). */
function rootKeyboard(catCount: number, chanCount: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (catCount > 0) kb.text(`🗂 Категории (${catCount})`, 'nav:cat:0').row();
  if (chanCount > 0) kb.text(`📡 Каналы (${chanCount})`, 'nav:chan:0').row();
  return kb;
}

/**
 * Клавиатура страницы раздела: кнопки папок (срез по странице) + строка навигации.
 * sec — 'cat' | 'chan'. data[i] — callback кнопки папки (cat:<id>:0 / chan:<idx>:0, сразу первая страница).
 */
function pageKeyboard(
  sec: 'cat' | 'chan',
  page: number,
  pageCount: number,
  buttons: { label: string; data: string }[],
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const b of buttons) kb.text(b.label, b.data).row();
  if (page > 0) kb.text('◀', `nav:${sec}:${page - 1}`);
  kb.text('⬅ Разделы', 'nav:root');
  if (page < pageCount - 1) kb.text('▶', `nav:${sec}:${page + 1}`);
  kb.row();
  return kb;
}

/**
 * Клавиатура содержимого папки: записи (глобальная нумерация) + строка навигации
 * `◀ | ⬅ назад в раздел | ▶`. Тот же паттерн, что у страниц раздела — единый вид.
 */
function contentKeyboard(
  list: Item[],
  page: number,
  pageCount: number,
  offset: number,
  pagePrefix: string, // `cat:<id>:` | `chan:<idx>:`
  backData: string, // `nav:cat:0` | `nav:chan:0`
  backLabel: string, // '⬅ Категории' | '⬅ Каналы'
): InlineKeyboard {
  const kb = new InlineKeyboard();
  list.forEach((it, i) => {
    kb.text(`${offset + i + 1} · ${sourceName(it)}`, `card:${it.id}`).row();
  });
  if (page > 0) kb.text('◀', `${pagePrefix}${page - 1}`);
  kb.text(backLabel, backData);
  if (page < pageCount - 1) kb.text('▶', `${pagePrefix}${page + 1}`);
  kb.row();
  return kb;
}

/** Показать страницу содержимого папки правкой текущего сообщения (как страницы раздела). */
async function editContentPage(
  ctx: Context,
  data: ItemsPage,
  page: number,
  title: string,
  pagePrefix: string,
  backData: string,
  backLabel: string,
): Promise<void> {
  if (data.total === 0) {
    await ctx.editMessageText(`${title}\n\nПока пусто.`, {
      reply_markup: new InlineKeyboard().text(backLabel, backData),
    });
    return;
  }
  const pageCount = Math.max(1, Math.ceil(data.total / ITEM_PAGE_SIZE));
  const offset = page * ITEM_PAGE_SIZE;
  await ctx.editMessageText(`${title} — стр. ${page + 1}/${pageCount}`, {
    reply_markup: contentKeyboard(data.items, page, pageCount, offset, pagePrefix, backData, backLabel),
  });
}

export function registerBrowse(bot: Bot): void {
  // /folders — корневой экран с разделами.
  bot.command('folders', async (ctx) => {
    const userId = ctx.from!.id;
    const [clusters, channels] = await Promise.all([listClustersWithCounts(userId), listChannels(userId)]);
    if (clusters.length === 0 && channels.length === 0) {
      await ctx.reply('Пока пусто — перешли что-нибудь, и здесь появятся папки.');
      return;
    }
    await ctx.reply('📂 Папки — выбери раздел:', {
      reply_markup: rootKeyboard(clusters.length, channels.length),
    });
  });

  // Назад к разделам.
  bot.callbackQuery('nav:root', async (ctx) => {
    const userId = ctx.from.id;
    const [clusters, channels] = await Promise.all([listClustersWithCounts(userId), listChannels(userId)]);
    await ctx.editMessageText('📂 Папки — выбери раздел:', {
      reply_markup: rootKeyboard(clusters.length, channels.length),
    });
    await ctx.answerCallbackQuery();
  });

  // Страница раздела (постранично, правим то же сообщение).
  bot.callbackQuery(/^nav:(cat|chan):(\d+)$/, async (ctx) => {
    const sec = ctx.match[1] as 'cat' | 'chan';
    const page = Number(ctx.match[2]);
    const userId = ctx.from.id;

    let buttons: { label: string; data: string }[];
    let total: number;
    let title: string;
    if (sec === 'cat') {
      const clusters = await listClustersWithCounts(userId);
      total = clusters.length;
      const start = page * PAGE_SIZE;
      buttons = clusters
        .slice(start, start + PAGE_SIZE)
        .map((c) => ({ label: `🗂 ${c.name} · ${c.count}`, data: `cat:${c.id}:0` }));
      title = '🗂 Категории';
    } else {
      const channels = await listChannels(userId);
      total = channels.length;
      const start = page * PAGE_SIZE;
      // Канал адресуем ГЛОБАЛЬНЫМ индексом (chan:<idx> пере-вычисляет полный список).
      buttons = channels
        .slice(start, start + PAGE_SIZE)
        .map((ch, j) => ({ label: `📡 ${ch.sourceChat} · ${ch.count}`, data: `chan:${start + j}:0` }));
      title = '📡 Каналы';
    }

    const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
    await ctx.editMessageText(`${title} — стр. ${page + 1}/${pageCount}`, {
      reply_markup: pageKeyboard(sec, page, pageCount, buttons),
    });
    await ctx.answerCallbackQuery();
  });

  // Открыть/листать категорию: cat:<clusterId>:<page>. clusterId — uuid (без двоеточий).
  bot.callbackQuery(/^cat:([^:]+):(\d+)$/, async (ctx) => {
    const clusterId = ctx.match[1]!;
    const page = Number(ctx.match[2]);
    const userId = ctx.from.id;
    const cluster = await getCluster(clusterId);
    if (!cluster || cluster.userId !== userId) {
      return ctx.answerCallbackQuery({ text: 'Категория не найдена', show_alert: true });
    }
    const data = await itemsByClusterPage(userId, clusterId, ITEM_PAGE_SIZE, page * ITEM_PAGE_SIZE);
    await editContentPage(ctx, data, page, `🗂 «${cluster.name}»`, `cat:${clusterId}:`, 'nav:cat:0', '⬅ Категории');
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
      return ctx.answerCallbackQuery({ text: 'Канал не найден', show_alert: true });
    }
    const data = await itemsBySourcePage(userId, channel.sourceChat, ITEM_PAGE_SIZE, page * ITEM_PAGE_SIZE);
    await editContentPage(ctx, data, page, `📡 «${channel.sourceChat}»`, `chan:${idx}:`, 'nav:chan:0', '⬅ Каналы');
    await ctx.answerCallbackQuery();
  });
}
