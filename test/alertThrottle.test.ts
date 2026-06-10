import { describe, it, expect, beforeEach } from 'vitest';
import {
  shouldAlert,
  ALERT_THROTTLE_MS,
  __resetAlertThrottleForTest,
} from '../src/bot/alertThrottle.js';

// Чистая политика троттлинга алертов админам: один сбой (по ключу) не чаще раза в окно — чтобы «прокси
// без usage» / флап БД не слали сообщение на каждый вызов и не упёрлись в лимиты Telegram.
describe('shouldAlert (троттлинг алертов)', () => {
  beforeEach(() => __resetAlertThrottleForTest());

  it('первый алерт по ключу проходит', () => {
    expect(shouldAlert('k', 1000)).toBe(true);
  });

  it('повтор в пределах окна — глушится', () => {
    expect(shouldAlert('k', 1000)).toBe(true);
    expect(shouldAlert('k', 1000 + ALERT_THROTTLE_MS - 1)).toBe(false);
  });

  it('ровно на границе окна — снова проходит', () => {
    expect(shouldAlert('k', 1000)).toBe(true);
    expect(shouldAlert('k', 1000 + ALERT_THROTTLE_MS)).toBe(true);
  });

  it('разные ключи независимы (usage-missing:llm vs :embedding)', () => {
    expect(shouldAlert('usage-missing:llm', 1000)).toBe(true);
    expect(shouldAlert('usage-missing:embedding', 1000)).toBe(true);
    // повтор каждого — глушится по своему окну
    expect(shouldAlert('usage-missing:llm', 1500)).toBe(false);
  });

  it('кастомное окно троттлинга соблюдается', () => {
    expect(shouldAlert('k', 0, 100)).toBe(true);
    expect(shouldAlert('k', 50, 100)).toBe(false);
    expect(shouldAlert('k', 100, 100)).toBe(true);
  });
});
