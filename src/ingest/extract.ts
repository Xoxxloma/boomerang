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
 * Слова из URL (хост + сегменты пути, де-слаг) как сигнал для классификации. Многие сайты кодируют
 * тему прямо в адресе (avito: /moskva/odezhda_obuv_aksessuary/maison_margiela_…), а тело нам недоступно
 * (анти-бот блок отдаёт заглушку вместо OG). Чисто-числовые токены (id объявления) и query отбрасываем.
 * Пусто → null. Для youtube даёт «youtube.com watch» (безвредный шум), для маркетплейсов — реальную тему.
 */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function urlSlugText(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    const pathWords = decodeURIComponent(u.pathname)
      .split(/[/_-]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 1 && !/^\d+$/.test(s));
    const words = [host, ...pathWords].join(' ').trim();
    return words || null;
  } catch {
    return null;
  }
}

function nonEmpty(s: string | null | undefined): boolean {
  return Boolean(s && s.trim());
}

/**
 * Есть ли у записи НАСТОЯЩЕЕ содержимое, а не только имя/адрес. title намеренно НЕ считается
 * содержимым: у документа это имя файла, у ссылки — фолбэк-хост, и выводить из них факты нельзя
 * (инцидент: сводка сочинила «ДДУ зарегистрирован…» из имени файла). Подпись юзера — содержимое
 * (авторский текст), но у голой ссылки rawText = сам URL — вырезаем URL и смотрим остаток.
 * Единый предикат для сводки/созревания/классификации: слои не должны расходиться в понимании «пусто».
 */
export function hasRealContent(it: Indexable): boolean {
  if (nonEmpty(it.description) || nonEmpty(it.ocrText) || nonEmpty(it.transcript)) return true;
  const raw = it.rawText?.trim() ?? '';
  if (!raw) return false;
  if (it.type === 'link') return raw.replace(/https?:\/\/\S+/g, ' ').trim().length > 0;
  return true;
}

/**
 * Ссылка-пустышка: ни подписи, ни OG-меты (title пуст или фолбэк-хост), а из URL извлекается только
 * хост (нет слов пути). Темы у такой записи нет — гадать её LLM по домену нельзя (avito → «Недвижимость»),
 * место такой записи — нейтральная полка «Ссылки» (см. classify).
 */
export function isContentlessLink(it: Indexable): boolean {
  if (it.type !== 'link' || !it.url) return false;
  if (hasRealContent(it)) return false;
  const host = hostOf(it.url);
  if (it.title?.trim() && it.title.trim() !== host) return false; // настоящий OG-title — не пустышка
  const slug = urlSlugText(it.url);
  return !slug || slug === host;
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
    // Подпись юзера ведёт сигнал, но сырой URL из текста вырезаем (это шум: длинный адрес с id/параметрами).
    // Тему из URL даёт чистый де-слаг ниже. Голая ссылка без подписи → caption пуст.
    const caption = it.rawText ? it.rawText.replace(/https?:\/\/\S+/g, ' ').trim() || null : null;
    // Слаг (слова из URL) подмешиваем ТОЛЬКО когда настоящего OG-заголовка нет — title скатился в фолбэк
    // (= хост): анти-бот заглушка / пустой OG. Для нормальных ссылок с хорошим OG слаг не нужен (title
    // его перевешивает) и не добавляется — никакого влияния на их классификацию.
    const noRealTitle = !it.title?.trim() || (it.url != null && it.title.trim() === hostOf(it.url));
    const slug = noRealTitle && it.url ? urlSlugText(it.url) : null;
    parts = [caption, it.title, it.description, slug];
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
