import { InlineKeyboard, type Bot } from 'grammy';
import { buildDigest } from '../../retrieval/digest.js';
import { getProactiveMode } from '../../db/users.js';
import { startImport } from '../../import/burst.js';

const START_TEXT = [
  '*Boomerang* — как «Избранное», только умное.',
  '',
  'Пересылай мне статьи, посты, картинки и документы — без тегов и папок. Сам разложу по полкам, ' +
    'а когда понадобится — соберу связный ответ со ссылками («🔍 Найти» или `/find`).',
  '',
  '*С чего начать — закинь то, что уже накопилось:*',
  '• Нажми «Залить из Избранного» ниже и пересылай сохранённое пачками (до 100 за раз).',
  '• Или выгрузи переписку в JSON: в Telegram Desktop открой «Избранное» → ⋮ → «Экспорт истории чата» → ' +
    'формат *JSON*, без медиа → пришли мне готовый файл `result.json`, разберу всё разом.',
  '',
  'Команды:',
  '• /find — поиск по сохранённому (или кнопка «🔍 Найти»)',
  '• /import — залить старое из «Избранного» одной пачкой',
  '• /folders — папки: категории и каналы',
  '• /digest — темы за последнее время',
  '• /settings — напоминания из архива',
].join('\n');

/** Кнопка-CTA на приветственном экране: новичку искать нечего — предлагаем сразу залить старое. */
const startKeyboard = new InlineKeyboard().text('Залить из Избранного', 'import:start');

export function registerCommands(bot: Bot): void {
  bot.command('start', async (ctx) => {
    await ctx.reply(START_TEXT, { parse_mode: 'Markdown', reply_markup: startKeyboard });
  });

  // Режим массовой заливки: открыть сессию, в которую копятся все пересылки (см. import/burst.ts).
  bot.command('import', async (ctx) => {
    const started = await startImport(ctx.api, ctx.from!.id, ctx.chat.id);
    if (!started) {
      await ctx.reply('Заливка уже идёт — пересылай дальше или нажми «Готово».');
    }
  });

  bot.command('digest', async (ctx) => {
    // Дайджест детерминированный (без LLM) — бюджет-гард не нужен. Синтез по кнопке «Свести»
    // уважает лимиты сам внутри handleQuery.
    const { text, keyboard } = await buildDigest(ctx.from!.id);
    await ctx.reply(text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
  });

  // Управление проактивными напоминаниями из архива (режим 2).
  bot.command('settings', async (ctx) => {
    const mode = await getProactiveMode(ctx.from!.id);
    const on = mode === 'on';
    const status = on
      ? 'Напоминания из архива: *включены*.\nИногда буду сам показывать связанное с тем, что ты пересылаешь.'
      : 'Напоминания из архива: *выключены*.\nМогу сам напоминать о похожем из сохранённого, когда это к месту.';
    const kb = new InlineKeyboard().text(
      on ? 'Выключить' : 'Включить',
      on ? 'optin:off' : 'optin:on',
    );
    await ctx.reply(status, { parse_mode: 'Markdown', reply_markup: kb });
  });
}
