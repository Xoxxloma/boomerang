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

const NOW = 1_700_000_000_000; // фиксируем «сейчас» для проверки окна свежести
const fresh = { auth_date: String(Math.floor(NOW / 1000)), user: JSON.stringify({ id: 42, first_name: 'Кот' }) };

describe('verifyInitData', () => {
  it('валидная подпись принимается, отдаёт user_id', () => {
    const res = verifyInitData(sign(fresh), TOKEN, NOW);
    expect(res.ok).toBe(true);
    expect(res.userId).toBe(42);
  });

  it('подделанные данные (hash не сходится) отвергаются', () => {
    const tampered = sign(fresh).replace('id%22%3A42', 'id%22%3A999'); // подменили user_id в payload
    const res = verifyInitData(tampered, TOKEN, NOW);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('bad-hash');
  });

  it('чужой токен не проходит', () => {
    const res = verifyInitData(sign(fresh), 'other-token', NOW);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('bad-hash');
  });

  it('просроченный initData (старше окна) отвергается', () => {
    const old = { ...fresh, auth_date: String(Math.floor(NOW / 1000) - 48 * 3600) };
    const res = verifyInitData(sign(old), TOKEN, NOW);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('expired');
  });

  it('отсутствие hash → отказ', () => {
    expect(verifyInitData('user=%7B%7D&auth_date=1', TOKEN, NOW).reason).toBe('no-hash');
  });

  it('пустая строка → отказ', () => {
    expect(verifyInitData('', TOKEN, NOW).ok).toBe(false);
  });
});
