import { DateTime } from 'luxon';

/**
 * Человекочитаемое время возврата в поясе юзера, на русском: «сегодня в 15:00» / «завтра в 9:00» /
 * «24 июня в 15:00». Используется и в ack создания, и в финальном сообщении L2, и при доставке.
 */
export function formatRemindAt(at: Date, tz: string, now: Date = new Date()): string {
  const target = DateTime.fromJSDate(at).setZone(tz).setLocale('ru');
  const today = DateTime.fromJSDate(now).setZone(tz).startOf('day');
  const dayDiff = Math.round(target.startOf('day').diff(today, 'days').days);
  const time = target.toFormat('H:mm');
  if (dayDiff === 0) return `сегодня в ${time}`;
  if (dayDiff === 1) return `завтра в ${time}`;
  return `${target.toFormat('d MMMM')} в ${time}`;
}
