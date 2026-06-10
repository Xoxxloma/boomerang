import type { Item } from '../db/schema.js';

/** Поля, из которых собираем индексируемый текст и сигнал для классификации. */
export type Indexable = Pick<
  Item,
  'type' | 'url' | 'title' | 'description' | 'rawText' | 'ocrText' | 'transcript' | 'sourceChat'
>;

/**
 * Текст для эмбеддинга: всё содержательное, что есть под рукой.
 * Включает ocr_text, transcript и имя источника (§10) — они невидимо улучшают поиск
 * (напр. «киберспорт» найдёт пост из канала про Counter-Strike, даже если в подписи этого слова нет).
 */
export function buildIndexText(it: Indexable): string {
  return [it.title, it.description, it.rawText, it.ocrText, it.transcript, it.sourceChat, it.url]
    .filter((s): s is string => Boolean(s && s.trim()))
    .join('\n')
    .trim();
}

/**
 * Самый дешёвый информативный сигнал для L1-классификации (§2.2): имя источника (канал/автор) +
 * заголовок/описание/первые ~500 символов текста. Имя канала часто решает тему сильнее короткой
 * подписи (канал «… Counter-Strike» + реплика про игрока → киберспорт), поэтому даём его явно и первым.
 * Сырой OCR сюда не тащим — он шумный и не для классификации.
 */
export function buildClassifySignal(it: Indexable): string {
  // Для ссылок подпись юзера (rawText) ведёт сигнал: scraped-title анти-бот сайта — шум (даже после
  // junk-фильтра — подстраховка, если мусор проскочит), а подпись — настоящий сигнал. Но если «подпись»
  // это сам URL (голая ссылка без текста) — она бесполезна как сигнал, ведут title/description.
  // Для остальных типов порядок прежний: у документа имя файла (title) информативнее случайной подписи (§2.2).
  let parts: (string | null | undefined)[];
  if (it.type === 'link') {
    const caption = it.rawText && it.rawText.trim() !== (it.url ?? '').trim() ? it.rawText : null;
    parts = [caption, it.title, it.description];
  } else {
    parts = [it.title, it.description, it.rawText];
  }
  const body =
    parts
      .filter((s): s is string => Boolean(s && s.trim()))
      .join('\n')
      .trim() || it.url || '';
  const lines: string[] = [];
  const source = it.sourceChat?.trim();
  if (source) lines.push(`Источник (канал/автор): ${source}`);
  if (body) lines.push(`Содержание: ${body.slice(0, 500)}`);
  return lines.join('\n').trim();
}
