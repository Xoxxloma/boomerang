import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Чистая проверка подписи Telegram Mini App initData (без env/сети — безопасна в юнит-тестах).
 * Доверять можно ТОЛЬКО подписанному initData: HMAC выводится из BOT_TOKEN, подделать user_id нельзя
 * (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app).
 * Middleware и чтение секрета — в auth.ts (он тянет env, поэтому отделён от этого модуля).
 */

/** Окно свежести initData (сек). Старее — отвергаем: защита от воспроизведения перехваченной строки. */
export const MAX_AGE_SECONDS = 24 * 60 * 60;

export interface InitDataUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface VerifyResult {
  ok: boolean;
  userId?: number;
  user?: InitDataUser;
  reason?: string;
}

/** `now` инъектируется для детерминированной проверки окна свежести в юнит-тестах. */
export function verifyInitData(
  initData: string,
  botToken: string,
  now: number = Date.now(),
  maxAgeSeconds: number = MAX_AGE_SECONDS,
): VerifyResult {
  if (!initData) return { ok: false, reason: 'empty' };

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'no-hash' };

  // data-check-string: все поля КРОМЕ hash, отсортированы по ключу, склеены "key=value" через \n.
  const pairs: string[] = [];
  for (const [key, value] of params) {
    if (key === 'hash') continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  // secret = HMAC_SHA256(bot_token) с ключом-литералом "WebAppData".
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computed = createHmac('sha256', secret).update(dataCheckString).digest('hex');

  const a = Buffer.from(computed, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad-hash' };

  // Свежесть: auth_date в секундах эпохи.
  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate)) return { ok: false, reason: 'no-auth-date' };
  if (now / 1000 - authDate > maxAgeSeconds) return { ok: false, reason: 'expired' };

  // Личность.
  let user: InitDataUser;
  try {
    user = JSON.parse(params.get('user') ?? '');
  } catch {
    return { ok: false, reason: 'no-user' };
  }
  if (typeof user?.id !== 'number') return { ok: false, reason: 'no-user-id' };

  return { ok: true, userId: user.id, user };
}
