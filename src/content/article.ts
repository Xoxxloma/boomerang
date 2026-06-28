import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { isPlaceholderMeta } from './og.js';
import { tuning } from '../config/tuning.js';

/**
 * Домены, у которых «статьи» нет (контент за JS/логином/это лента): дочитывать бессмысленно —
 * fetch отдаст SPA-оболочку или превью. Сразу `null` без сетевого запроса (экономит впустую-fetch).
 * Сравниваем по хосту: сам домен ИЛИ его поддомен (m.youtube.com, mobile.twitter.com).
 */
const SKIP_HOSTS = [
  'youtube.com',
  'youtu.be',
  't.me',
  'telegram.me',
  'twitter.com',
  'x.com',
  'instagram.com',
  'tiktok.com',
  'facebook.com',
];

function isSkippedHost(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return true; // невалидный URL — читать нечего
  }
  return SKIP_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
}

/** Схлопываем пробелы/переводы строк: для индекса/эмбеддинга структура не нужна, важен текст. */
function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Дочитать тело статьи по URL (L3 «по содержанию», вызывается в L2). Чистый текст статьи без навигации
 * через readability (как «режим чтения» в браузере). Возвращает `null`, если читать нечего/нельзя —
 * вызывающий код пометит запись `body_status='unreadable'` (кэш отказа, больше не дёргаем):
 *  - skip-домен (YouTube/t.me/соцсети) — без сетевого запроса;
 *  - сеть/таймаут/не-HTML — `fetch` упал;
 *  - SPA отдал пустую оболочку, либо извлечённого текста < articleMinChars — «не статья»;
 *  - анти-бот заглушка (avito и т.п.) — ловим isPlaceholderMeta по title/siteName статьи.
 * fetch НЕ исполняет JS — клиент-рендер (SPA) сюда не попадёт; headless-браузер отложен (см. план).
 */
export async function fetchArticleBody(url: string): Promise<string | null> {
  if (isSkippedHost(url)) return null;

  let html: string;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), tuning.articleFetchTimeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; BoomerangBot/0.1)' },
        redirect: 'follow',
      });
      // На раннем выходе гасим недослитое тело — иначе сокет undici висит до GC (L2 льёт много fetch'ей).
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return null;
      }
      const ctype = res.headers.get('content-type') ?? '';
      if (!ctype.includes('html')) {
        await res.body?.cancel().catch(() => {}); // PDF/изображение/JSON по ссылке — не статья
        return null;
      }
      // Юзер шлёт произвольные URL → защита от OOM в воркере: гигантскую страницу не буферизим целиком.
      // Таймаут бьёт по времени, этот гард — по размеру (для серверов, отдающих content-length).
      const len = Number(res.headers.get('content-length') ?? 0);
      if (len > tuning.articleMaxBytes) {
        await res.body?.cancel().catch(() => {});
        return null;
      }
      html = await res.text();
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null; // сеть/таймаут/abort
  }

  try {
    // linkedom даёт DOM-документ без браузера; Readability ждёт lib.dom Document — структурно совместимо,
    // но типы из разных деклараций (+ в проекте нет DOM-lib). Локальный каст на границе библиотек к типу,
    // который ждёт сам конструктор Readability (рантайм-объект тот же).
    const { document } = parseHTML(html);
    type ReadabilityDoc = ConstructorParameters<typeof Readability>[0];
    const article = new Readability(document as unknown as ReadabilityDoc).parse();
    if (!article) return null;
    if (isPlaceholderMeta(article.title ?? undefined, undefined, article.siteName ?? undefined)) {
      return null; // заглушка анти-бот сайта (title == имя сайта)
    }
    const body = normalize(article.textContent ?? '');
    if (body.length < tuning.articleMinChars) return null; // SPA-оболочка / тонкое превью
    return body.slice(0, tuning.articleMaxChars);
  } catch {
    return null; // битый HTML / readability упал
  }
}
