import type { ItemType } from './types.js';

/** Глиф вида материала для ведущей иконки строки. */
export const TYPE_GLYPH: Record<ItemType, string> = {
  link: '🔗',
  tg_post: '📣',
  document: '📄',
  image: '🖼',
  video: '🎬',
  text: '✎',
  voice: '🎙',
};

/** Короткое имя вида материала (моно-meta). */
export const TYPE_LABEL: Record<ItemType, string> = {
  link: 'ссылка',
  tg_post: 'пост',
  document: 'документ',
  image: 'картинка',
  video: 'видео',
  text: 'заметка',
  voice: 'голос',
};

const MS_DAY = 86_400_000;

/** Компактная дата для meta: «сегодня» / «вчера» / «N дн» / «дд.мм.гг». */
export function relDate(iso: string): string {
  const then = new Date(iso);
  const days = Math.floor((Date.now() - then.getTime()) / MS_DAY);
  if (days <= 0) return 'сегодня';
  if (days === 1) return 'вчера';
  if (days < 30) return `${days} дн`;
  const dd = String(then.getDate()).padStart(2, '0');
  const mm = String(then.getMonth() + 1).padStart(2, '0');
  const yy = String(then.getFullYear()).slice(2);
  return `${dd}.${mm}.${yy}`;
}

/** Полная дата для годовщин Эха: «5 марта 2024». */
const MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];
export function longDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

// --- Напоминания: всё в локальной (= пользовательской) tz браузера. ---

/** «9:00» из ISO (часы:минуты, локальная tz). */
export function timeHM(iso: string): string {
  const d = new Date(iso);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** В какую группу таймлайна «Скоро» попадает момент: сегодня / завтра / позже. */
export function dayBucket(iso: string): 'today' | 'tomorrow' | 'later' {
  const d = new Date(iso);
  const now = new Date();
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(d) - start(now)) / MS_DAY);
  if (diff <= 0) return 'today';
  if (diff === 1) return 'tomorrow';
  return 'later';
}

/** «24 июня» — для дальних строк таймлайна. */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** Человекочитаемое «когда вернётся»: «сегодня в 9:00» / «завтра в 15:00» / «24 июня в 9:00». */
export function remindWhen(iso: string): string {
  const bucket = dayBucket(iso);
  const time = timeHM(iso);
  if (bucket === 'today') return `сегодня в ${time}`;
  if (bucket === 'tomorrow') return `завтра в ${time}`;
  return `${shortDate(iso)} в ${time}`;
}

// --- Пресеты времени (локальная tz браузера) → абсолютный ISO для отправки на сервер. ---
const DEFAULT_HOUR = 9;
const EVENING_HOUR = 19;

export function presetTomorrow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(DEFAULT_HOUR, 0, 0, 0);
  return d.toISOString();
}
export function presetEvening(): string {
  const d = new Date();
  d.setHours(EVENING_HOUR, 0, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.toISOString();
}
export function presetWeek(): string {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  d.setHours(DEFAULT_HOUR, 0, 0, 0);
  return d.toISOString();
}

/** value из <input type="datetime-local"> (локальное настенное время) → абсолютный ISO, если в будущем. */
export function localInputToIso(value: string): string | null {
  if (!value) return null;
  const at = new Date(value); // трактуется как локальное время
  if (Number.isNaN(at.getTime()) || at.getTime() <= Date.now()) return null;
  return at.toISOString();
}
