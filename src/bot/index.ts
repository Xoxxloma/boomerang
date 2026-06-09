import { Bot } from 'grammy';
import { sequentialize } from '@grammyjs/runner';
import { env } from '../config/env.js';
import { ensureUser } from '../db/users.js';
import { registerCommands } from './handlers/commands.js';
import { registerSearch } from './handlers/search.js';
import { registerCallbacks } from './handlers/callbacks.js';
import { registerBrowse } from './handlers/browse.js';
import { registerIngest } from './handlers/ingest.js';

export function createBot(): Bot {
  const bot = new Bot(env.BOT_TOKEN);

  // Сериализуем апдейты по пользователю: приём пачкой меняет общее состояние сессии заливки в БД
  // (флаг/счётчик), параллельная обработка апдейтов одного юзера дала бы гонку. Разные юзеры — параллельно.
  bot.use(sequentialize((ctx) => ctx.from?.id.toString()));

  // Любое взаимодействие гарантирует наличие пользователя в БД.
  bot.use(async (ctx, next) => {
    if (ctx.from && !ctx.from.is_bot) {
      await ensureUser(ctx.from.id);
    }
    await next();
  });

  registerCommands(bot);
  registerBrowse(bot);
  registerCallbacks(bot);
  // Поиск регистрируем ДО приёма: вопрос-запрос должен перехватываться раньше,
  // чем обычный текст уйдёт в сохранение.
  registerSearch(bot);
  registerIngest(bot);

  bot.catch((err) => {
    console.error('❌ Bot error:', err.error);
  });

  return bot;
}
