import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyInitData } from '../src/web-api/initData.js';

const TOKEN = '123456:TEST-bot-token';

/** Подписать набор полей как настоящий Telegram (secret = HMAC("WebAppData", token)). */
function sign(params: Record<string, string>): string {
  const dcs = Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  const hash = createHmac('sha256', secret).update(dcs).digest('hex');
  const usp = new URLSearchParams(params);
  usp.set('hash', hash);
  return usp.toString();
}

// auth_date оставляем валидным числом, но свежесть больше не проверяется — см. initData.ts.
const fresh = { auth_date: '1700000000', user: JSON.stringify({ id: 42, first_name: 'Кот' }) };

describe('verifyInitData', () => {
  it('валидная подпись принимается, отдаёт user_id', () => {
    const res = verifyInitData(sign(fresh), TOKEN);
    expect(res.ok).toBe(true);
    expect(res.userId).toBe(42);
  });

  it('подделанные данные (hash не сходится) отвергаются', () => {
    const tampered = sign(fresh).replace('id%22%3A42', 'id%22%3A999'); // подменили user_id в payload
    const res = verifyInitData(tampered, TOKEN);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('bad-hash');
  });

  it('чужой токен не проходит', () => {
    const res = verifyInitData(sign(fresh), 'other-token');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('bad-hash');
  });

  it('старый auth_date всё равно принимается (свежесть не проверяем — кейс кнопки-меню)', () => {
    const old = { ...fresh, auth_date: String(Math.floor(1700000000 - 48 * 3600)) };
    const res = verifyInitData(sign(old), TOKEN);
    expect(res.ok).toBe(true);
    expect(res.userId).toBe(42);
  });

  it('отсутствие hash → отказ', () => {
    expect(verifyInitData('user=%7B%7D&auth_date=1', TOKEN).reason).toBe('no-hash');
  });

  it('пустая строка → отказ', () => {
    expect(verifyInitData('', TOKEN).ok).toBe(false);
  });
});
