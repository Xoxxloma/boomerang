import { Bot } from 'grammy';
import { sequentialize } from '@grammyjs/runner';
import { apiThrottler } from '@grammyjs/transformer-throttler';
import { autoRetry } from '@grammyjs/auto-retry';
import { env } from '../config/env.js';
import { ensureUser } from '../db/users.js';
import { registerCommands } from './handlers/commands.js';
import { registerSearch } from './handlers/search.js';
import { registerCallbacks } from './handlers/callbacks.js';
import { registerBrowse } from './handlers/browse.js';
import { registerIngest } from './handlers/ingest.js';
import { registerReminders } from './handlers/reminders.js';
import { registerSupport } from './handlers/support.js';
import { registerPlans } from './handlers/plans.js';
import { registerAdmin } from './handlers/admin.js';
import { registerPayments } from './handlers/payments.js';
import { searchReplyKeyboard } from './handlers/search.js';
import { notifyAdmins } from './alerts.js';

export function createBot(): Bot {
  const bot = new Bot(env.BOT_TOKEN);

  // Reply-клавиатура «🔍 Найти» — директива уровня чата (не сообщения), живёт независимо от
  // inline-кнопок. Клиент Telegram может её свернуть/сбросить; ставить только на /start ненадёжно —
  // кнопка пропадает и не возвращается. Поэтому «дошиваем» её к исходящим sendMessage без своей
  // разметки: клавиатура самовосстанавливается на обычных ответах бота («не нашёл», итог поиска и т.п.).
  //
  // НЕ трогаем: (1) сообщения со своей разметкой (force_reply, inline-кнопки, карточки);
  // (2) прямые ответы на контент пользователя (reply_parameters) — это транзитные ack («Принял ✅»),
  // которые ПОТОМ редактируются (→ «Положил в …»). Сообщение, отправленное с reply-клавиатурой,
  // Telegram редактировать запрещает («message can't be edited») — поэтому ack должны уходить без неё.
  bot.api.config.use((prev, method, payload, signal) => {
    if (method === 'sendMessage' && payload) {
      const p = payload as { reply_markup?: unknown; reply_parameters?: unknown };
      if (!p.reply_markup && !p.reply_parameters) p.reply_markup = searchReplyKeyboard;
    }
    return prev(method, payload, signal);
  });

  // Исходящие к Telegram: авторетрай + троттлер на транспортном уровне (один Api обслуживает и
  // пользовательский путь, и фоновых воркеров — см. setBotApi(bot.api) в src/index.ts).
  // Порядок исполнения трансформеров — «снаружи внутрь» в порядке .use(): autoRetry внешний,
  // throttler внутренний → каждая повторная попытка авторетрая заново проходит троттлер (иначе
  // ретраи под флудом обходили бы лимит и снова ловили 429).
  // Капы (3 × 20с ≈ 60с макс. блокировки одного вызова) много меньше pg-boss visibility-timeout
  // (дефолт 900с) → джоба не «протухнет» из-за ожидания ретрая. autoRetry повторяет только при
  // 429/flood (Telegram вызов ОТКЛОНИЛ) → дублей отправленных сообщений нет.
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 20 }));
  bot.api.config.use(apiThrottler());

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
  // Тарифы Pro (/premium) и админ-рефанд — команды, конфликта с приёмом нет.
  registerPlans(bot);
  registerAdmin(bot);
  registerBrowse(bot);
  registerCallbacks(bot);
  // Поиск регистрируем ДО приёма: вопрос-запрос должен перехватываться раньше,
  // чем обычный текст уйдёт в сохранение.
  registerSearch(bot);
  // Напоминания — ПОСЛЕ поиска, ДО приёма: ловит только force_reply «Своё время» (через remind_pending),
  // на остальном message:text делает next() → обычный текст уходит в ingest как раньше.
  registerReminders(bot);
  // Поддержка — ПОСЛЕ поиска/напоминаний, ДО приёма: ловит ответ на /help и реплай админа,
  // на остальном message:text делает next() → обычный текст уходит в ingest как раньше.
  registerSupport(bot);
  // Платежи СТРОГО до приёма: successful_payment — служебное сообщение без текста, иначе упало бы в
  // ingest (catch-all bot.on('message')) и уперлось бы в гейт ёмкости.
  registerPayments(bot);
  registerIngest(bot);

  // Необработанное исключение хендлера: grammY-runner ловит его сюда — процесс НЕ падает, но юзер
  // остаётся с зависшим ack. console.error на зарубежном VPS никто не видит → дублируем в notifyAdmins
  // (троттл по типу апдейта + классу ошибки, чтобы шквал одной поломки не зафлудил чат админов).
  bot.catch((err) => {
    console.error('❌ Bot error:', err.error);
    const cause = err.error;
    const name = cause instanceof Error ? cause.name : typeof cause;
    const detail = cause instanceof Error ? cause.message : String(cause);
    const updType = err.ctx.update.message
      ? 'message'
      : err.ctx.update.callback_query
        ? 'callback'
        : 'update';
    void notifyAdmins(
      `bot-handler:${updType}:${name}`,
      `❌ Сбой обработки ${updType} от ${err.ctx.from?.id ?? '?'}: ${name}: ${detail.slice(0, 300)}`,
    );
  });

  return bot;
}
