import { InlineKeyboard, type Bot } from 'grammy';
import { buildDigest } from '../../retrieval/digest.js';
import { getProactiveMode } from '../../db/users.js';
import { searchReplyKeyboard } from './search.js';
import { startImport } from '../../import/burst.js';

const START_TEXT = [
  '🪃 *Boomerang* — как «Избранное», только умное.',
  '',
  'Пересылай мне статьи, посты, картинки и документы — ничего не нужно тегировать.',
  'Сам разложу их по полкам, а когда понадобится — нажми «🔍 Найти» (или `/find`): не отдам списком, ' +
    'а соберу связный ответ со ссылками.',
  '',
  'Команды:',
  '• /find — поиск по сохранённому (или кнопка «🔍 Найти»)',
  '• /import — залить старое из «Избранного» одной пачкой',
  '• /folders — папки: категории и каналы',
  '• /digest — темы за последнее время',
  '• /settings — напоминания из архива',
].join('\n');

export function registerCommands(bot: Bot): void {
  bot.command('start', async (ctx) => {
    await ctx.reply(START_TEXT, { parse_mode: 'Markdown', reply_markup: searchReplyKeyboard });
  });

  // Режим массовой заливки: открыть сессию, в которую копятся все пересылки (см. import/burst.ts).
  bot.command('import', async (ctx) => {
    const started = await startImport(ctx.api, ctx.from!.id, ctx.chat.id);
    if (!started) {
      await ctx.reply('Заливка уже идёт — пересылай дальше или нажми «Готово».');
    }
  });

  bot.command('digest', async (ctx) => {
    await ctx.replyWithChatAction('typing').catch(() => {});
    const text = await buildDigest(ctx.from!.id);
    await ctx.reply(text.slice(0, 4096), { link_preview_options: { is_disabled: true } });
  });

  // Управление проактивными напоминаниями из архива (режим 2).
  bot.command('settings', async (ctx) => {
    const mode = await getProactiveMode(ctx.from!.id);
    const on = mode === 'on';
    const status = on
      ? '🪃 Напоминания из архива: *включены*.\nИногда буду сам показывать связанное с тем, что ты пересылаешь.'
      : '🪃 Напоминания из архива: *выключены*.\nМогу сам напоминать о похожем из сохранённого, когда это к месту.';
    const kb = new InlineKeyboard().text(
      on ? 'Выключить' : 'Включить',
      on ? 'optin:off' : 'optin:on',
    );
    await ctx.reply(status, { parse_mode: 'Markdown', reply_markup: kb });
  });
}
