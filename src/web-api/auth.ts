import type { Context, MiddlewareHandler } from 'hono';
import { env } from '../config/env.js';
import { verifyInitData, type InitDataUser } from './initData.js';

/**
 * Авторизация Mini App: middleware поверх чистой verifyInitData (initData.ts). Читает секрет из env,
 * поэтому отделён от самой проверки подписи — чтобы юнит-тесты verifyInitData не тянули валидацию env.
 */
export type { InitDataUser } from './initData.js';

/** Контекст Hono с гарантированным user_id после telegramAuth. */
export type AuthedContext = Context<{ Variables: { userId: number; tgUser: InitDataUser } }>;

/**
 * Middleware: достаёт initData из заголовка `X-Telegram-Init-Data`, проверяет подпись секретом
 * BOT_TOKEN, кладёт user_id в контекст. Невалидный/просроченный/отсутствующий → 401.
 */
export const telegramAuth: MiddlewareHandler<{ Variables: { userId: number; tgUser: InitDataUser } }> = async (
  c,
  next,
) => {
  const initData = c.req.header('X-Telegram-Init-Data') ?? '';
  const res = verifyInitData(initData, env.BOT_TOKEN);
  if (!res.ok || res.userId === undefined || !res.user) {
    return c.json({ error: 'unauthorized', reason: res.reason }, 401);
  }
  c.set('userId', res.userId);
  c.set('tgUser', res.user);
  await next();
};
