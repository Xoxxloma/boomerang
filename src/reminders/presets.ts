import { DateTime } from 'luxon';
import { tuning } from '../config/tuning.js';

/**
 * Быстрые пресеты времени для кнопки «Напомнить» — детерминированно, БЕЗ LLM. Все считаются в поясе
 * пользователя (Luxon корректно учитывает DST) и возвращают UTC `Date` (в БД храним в UTC).
 * Час вечера фиксирован, дефолтный/недельный — из tuning.
 */
const EVENING_HOUR = 19;

/** Базовый момент «сейчас» в поясе юзера. Вынесен параметром ради тестируемости (детерминизм). */
function nowInTz(tz: string, now?: Date): DateTime {
  return (now ? DateTime.fromJSDate(now) : DateTime.now()).setZone(tz);
}

function atHour(dt: DateTime, hour: number): DateTime {
  return dt.set({ hour, minute: 0, second: 0, millisecond: 0 });
}

/** Завтра в дефолтный час (по умолчанию 9:00) пояса юзера. */
export function tomorrowAtDefault(tz: string, now?: Date): Date {
  return atHour(nowInTz(tz, now).plus({ days: 1 }), tuning.remindDefaultHour).toUTC().toJSDate();
}

/** Сегодня в 19:00; если этот час уже прошёл — завтра в 19:00. */
export function thisEvening(tz: string, now?: Date): Date {
  const base = nowInTz(tz, now);
  let target = atHour(base, EVENING_HOUR);
  if (target <= base) target = target.plus({ days: 1 });
  return target.toUTC().toJSDate();
}

/** Через неделю (7 дней) в дефолтный час пояса юзера. */
export function inAWeek(tz: string, now?: Date): Date {
  return atHour(nowInTz(tz, now).plus({ days: 7 }), tuning.remindDefaultHour).toUTC().toJSDate();
}

/** Ключи пресетов в callback-данных (`remset:<itemId>:<key>`). */
export type PresetKey = 'tomorrow' | 'evening' | 'week';

/** Посчитать UTC-время по ключу пресета (для бот-коллбэков). */
export function presetTime(key: PresetKey, tz: string, now?: Date): Date {
  switch (key) {
    case 'tomorrow':
      return tomorrowAtDefault(tz, now);
    case 'evening':
      return thisEvening(tz, now);
    case 'week':
      return inAWeek(tz, now);
  }
}
