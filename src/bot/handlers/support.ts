import { type Bot, type Context } from 'grammy';
import { env } from '../../config/env.js';

/**
 * Двусторонняя поддержка через /help (без БД, по образцу /find).
 *
 * Юзер: /help <текст> уходит админам сразу; голый /help шлёт force_reply-приглашение, следующий
 * ответ пользователя ловится сравнением с константой HELP_PROMPT (как /find ловит ответ на свой
 * prompt) и уходит админам.
 *
 * Админ: реплаем на пересланное сообщение отвечает пользователю. Кому слать — берём из самого
 * форварда: userId зашит в первую строку (supportHeader) и парсится из reply_to_message.text.
 * uid якорён в НАЧАЛО строки — имя пользователя (строкой ниже) не может его подделать; релей
 * доступен только из ADMIN_IDS. Никаких таблиц/маппингов в БД.
 */

const HELP_PROMPT = 'Опиши проблему одним сообщением — ответь на это сообщение.';

/** Заголовок форварда админу: uid в начале строки — стабильный якорь для обратного парсинга. */
const supportHeader = (uid: number): string => `Поддержка, uid ${uid}`;
/** Достать userId из reply_to_message админа (строго из якоря в начале). null, если не наш форвард. */
function parseSupportUid(text: string): number | null {
  const m = /^Поддержка, uid (\d+)/.exec(text);
  if (!m) return null;
  const uid = Number(m[1]);
  return Number.isInteger(uid) && uid > 0 ? uid : null;
}

/** Переслать обращение пользователя всем админам + подтвердить пользователю. */
async function forwardHelp(ctx: Context, text: string): Promise<void> {
  const user = ctx.from;
  if (!user || !text) return;
  const who = user.username ? `${user.first_name} @${user.username}` : user.first_name;
  const message = [
    supportHeader(user.id),
    `От: ${who}`,
    '',
    text,
    '',
    'Ответь реплаем на это сообщение — отправлю пользователю.',
  ].join('\n');

  // Без parse_mode: текст пользователя произвольный, экранировать markdown не нужно.
  // try/catch на каждого: админ, не нажавший Start, не должен ронять рассылку остальным.
  await Promise.all(
    env.ADMIN_IDS.map((id) => ctx.api.sendMessage(id, message).catch(() => {})),
  );
  await ctx.reply('Передал в поддержку — ответим здесь же.');
}

/** Ответ админа (реплай на форвард) → отправить пользователю. */
async function relayAdminReply(ctx: Context, userId: number, text: string): Promise<void> {
  try {
    await ctx.api.sendMessage(userId, `Ответ поддержки:\n\n${text}`);
    await ctx.reply('Отправлено.');
  } catch {
    await ctx.reply('Не доставлено (юзер заблокировал бота?).');
  }
}

export function registerSupport(bot: Bot): void {
  // /help <текст> — сразу к админам; голый /help — приглашение с фокусом на ввод (как /find).
  bot.command('help', async (ctx) => {
    const text = ctx.match.trim();
    if (text) {
      await forwardHelp(ctx, text);
      return;
    }
    await ctx.reply(HELP_PROMPT, {
      reply_markup: { force_reply: true, input_field_placeholder: 'Что случилось?' },
    });
  });

  // Перехват ответов-реплаев (ДО ingest): и ответ юзера на приглашение, и реплай админа на форвард.
  // На любой чужой reply делаем next() → обычный текст уходит в сохранение как раньше.
  bot.on('message:text', async (ctx, next) => {
    const repliedText = ctx.message.reply_to_message?.text;
    if (!repliedText) return next();

    // Ветка админа: реплай на форвард-поддержки → ответ уходит пользователю.
    if (env.ADMIN_IDS.includes(ctx.from.id)) {
      const userId = parseSupportUid(repliedText);
      if (userId !== null) {
        await relayAdminReply(ctx, userId, ctx.message.text);
        return;
      }
    }

    // Ветка юзера: ответ на приглашение /help → форвард админам.
    if (repliedText === HELP_PROMPT) {
      await forwardHelp(ctx, ctx.message.text.trim());
      return;
    }

    return next();
  });
}
