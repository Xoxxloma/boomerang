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
