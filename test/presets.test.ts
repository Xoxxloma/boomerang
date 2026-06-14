import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import { tomorrowAtDefault, thisEvening, inAWeek, presetTime } from '../src/reminders/presets.js';
import { formatRemindAt } from '../src/reminders/format.js';

const MSK = 'Europe/Moscow'; // UTC+3 круглый год (без DST) — удобно для проверок

/** Локальные поля UTC-инстанта в поясе tz. */
function local(at: Date, tz: string) {
  const dt = DateTime.fromJSDate(at).setZone(tz);
  return { y: dt.year, mo: dt.month, d: dt.day, h: dt.hour, mi: dt.minute };
}

describe('presets (пресеты времени)', () => {
  it('tomorrowAtDefault — завтра в 9:00 по поясу юзера', () => {
    const now = new Date('2026-06-14T12:00:00Z'); // 15:00 МСК
    const at = tomorrowAtDefault(MSK, now);
    const l = local(at, MSK);
    expect(l).toMatchObject({ y: 2026, mo: 6, d: 15, h: 9, mi: 0 });
    // 9:00 МСК = 06:00 UTC
    expect(at.toISOString()).toBe('2026-06-15T06:00:00.000Z');
  });

  it('thisEvening — сегодня 19:00, если вечер ещё впереди', () => {
    const now = new Date('2026-06-14T12:00:00Z'); // 15:00 МСК — до 19:00
    const at = thisEvening(MSK, now);
    expect(local(at, MSK)).toMatchObject({ d: 14, h: 19, mi: 0 });
  });

  it('thisEvening — завтра 19:00, если 19:00 уже прошло', () => {
    const now = new Date('2026-06-14T17:00:00Z'); // 20:00 МСК — после 19:00
    const at = thisEvening(MSK, now);
    expect(local(at, MSK)).toMatchObject({ d: 15, h: 19, mi: 0 });
  });

  it('inAWeek — +7 дней в 9:00', () => {
    const now = new Date('2026-06-14T12:00:00Z');
    const at = inAWeek(MSK, now);
    expect(local(at, MSK)).toMatchObject({ d: 21, h: 9, mi: 0 });
  });

  it('presetTime диспетчеризует по ключу', () => {
    const now = new Date('2026-06-14T12:00:00Z');
    expect(presetTime('tomorrow', MSK, now).getTime()).toBe(tomorrowAtDefault(MSK, now).getTime());
    expect(presetTime('evening', MSK, now).getTime()).toBe(thisEvening(MSK, now).getTime());
    expect(presetTime('week', MSK, now).getTime()).toBe(inAWeek(MSK, now).getTime());
  });

  it('переход месяца корректен (31 → 1 число)', () => {
    const now = new Date('2026-05-31T12:00:00Z'); // 15:00 МСК 31 мая
    const at = tomorrowAtDefault(MSK, now);
    expect(local(at, MSK)).toMatchObject({ mo: 6, d: 1, h: 9 });
  });
});

describe('formatRemindAt', () => {
  const now = new Date('2026-06-14T12:00:00Z'); // 15:00 МСК, 14 июня

  it('сегодня', () => {
    const at = DateTime.fromObject({ year: 2026, month: 6, day: 14, hour: 18 }, { zone: MSK }).toJSDate();
    expect(formatRemindAt(at, MSK, now)).toBe('сегодня в 18:00');
  });

  it('завтра', () => {
    const at = DateTime.fromObject({ year: 2026, month: 6, day: 15, hour: 9 }, { zone: MSK }).toJSDate();
    expect(formatRemindAt(at, MSK, now)).toBe('завтра в 9:00');
  });

  it('дальняя дата — число и месяц', () => {
    const at = DateTime.fromObject({ year: 2026, month: 6, day: 24, hour: 15 }, { zone: MSK }).toJSDate();
    expect(formatRemindAt(at, MSK, now)).toBe('24 июня в 15:00');
  });
});
