import { describe, it, expect } from 'vitest';
import { dueKinds, accessReminderText } from '../src/reminders/access-window.js';

const DAY = 86_400_000;
const AU = new Date('2026-07-01T12:00:00.000Z'); // конец окна доступа

/** now со сдвигом от конца окна (мс). */
const at = (offsetMs: number): Date => new Date(AU.getTime() + offsetMs);

describe('dueKinds', () => {
  it('задолго до конца (−5 дней) → ничего', () => {
    expect(dueKinds(AU, at(-5 * DAY))).toEqual([]);
  });

  it('ровно −3 дня → d3 (граница включительно)', () => {
    expect(dueKinds(AU, at(-3 * DAY))).toEqual(['d3']);
  });

  it('−2 дня → только d3', () => {
    expect(dueKinds(AU, at(-2 * DAY))).toEqual(['d3']);
  });

  it('ровно −1 день → d3 и d1 (оба окна открыты)', () => {
    expect(dueKinds(AU, at(-DAY))).toEqual(['d3', 'd1']);
  });

  it('за минуту до конца → d3 и d1, но не d0', () => {
    expect(dueKinds(AU, at(-60_000))).toEqual(['d3', 'd1']);
  });

  it('ровно в момент конца → только d0 (activeUntil уже не в будущем)', () => {
    expect(dueKinds(AU, at(0))).toEqual(['d0']);
  });

  it('через час после конца → d0 (в пределах суточного grace)', () => {
    expect(dueKinds(AU, at(3_600_000))).toEqual(['d0']);
  });

  it('через 2 дня после конца → ничего (grace истёк)', () => {
    expect(dueKinds(AU, at(2 * DAY))).toEqual([]);
  });
});

describe('accessReminderText', () => {
  it('пробный и купленный различаются формулировкой', () => {
    expect(accessReminderText('d0', true)).toContain('Пробный');
    expect(accessReminderText('d0', false)).not.toContain('Пробный');
  });

  it('каждый kind даёт непустой текст', () => {
    for (const k of ['d3', 'd1', 'd0'] as const) {
      expect(accessReminderText(k, false).length).toBeGreaterThan(0);
    }
  });
});
