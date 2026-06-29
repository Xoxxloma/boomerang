import { describe, it, expect } from 'vitest';
import { effectiveTier, computeNextWindow } from '../src/billing/entitlement.js';

const NOW = new Date('2026-06-28T12:00:00.000Z');

describe('effectiveTier', () => {
  it('будущее activeUntil → pro', () => {
    expect(effectiveTier(new Date(NOW.getTime() + 1000), NOW)).toBe('pro');
  });
  it('прошлое activeUntil → free', () => {
    expect(effectiveTier(new Date(NOW.getTime() - 1000), NOW)).toBe('free');
  });
  it('null → free', () => {
    expect(effectiveTier(null, NOW)).toBe('free');
  });
  it('граница (activeUntil == now) → free (строго >)', () => {
    expect(effectiveTier(new Date(NOW.getTime()), NOW)).toBe('free');
  });
});

describe('computeNextWindow', () => {
  const DAY = 86400;

  it('нет активного окна (null) → от now', () => {
    const { from, until } = computeNextWindow(null, NOW, DAY);
    expect(from.getTime()).toBe(NOW.getTime());
    expect(until.getTime()).toBe(NOW.getTime() + DAY * 1000);
  });

  it('истёкшее окно (в прошлом) → от now', () => {
    const past = new Date(NOW.getTime() - 5 * DAY * 1000);
    const { from } = computeNextWindow(past, NOW, DAY);
    expect(from.getTime()).toBe(NOW.getTime());
  });

  it('активное окно (в будущем) → продление от конца, время не теряется', () => {
    const future = new Date(NOW.getTime() + 10 * DAY * 1000);
    const { from, until } = computeNextWindow(future, NOW, DAY);
    expect(from.getTime()).toBe(future.getTime());
    expect(until.getTime()).toBe(future.getTime() + DAY * 1000);
  });
});
