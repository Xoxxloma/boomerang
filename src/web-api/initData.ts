import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Чистая проверка подписи Telegram Mini App initData (без env/сети — безопасна в юнит-тестах).
 * Доверие держится ТОЛЬКО на HMAC-подписи: ключ выводится из BOT_TOKEN, подделать user_id нельзя
 * (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app).
 * Окно свежести по auth_date НЕ проверяем намеренно: WebView кнопки-меню Telegram держится «тёплым»
 * и переиспользует initData с первого открытия, так что auth_date стареет и любой срок рано или
 * поздно даёт ложный отказ. Подпись уже гарантирует подлинность; replay поверх TLS — приемлемый риск.
 * Middleware и чтение секрета — в auth.ts (он тянет env, поэтому отделён от этого модуля).
 */

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

export function verifyInitData(initData: string, botToken: string): VerifyResult {
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
