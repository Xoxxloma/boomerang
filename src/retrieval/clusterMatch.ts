import type { Cluster } from '../db/schema.js';

/**
 * Нечёткое сопоставление запроса с названиями категорий (гибридный поиск, §6 + §4).
 * Семантика по эмбеддингам слабо ловит запросы «по названию категории» («что по животным» ↛ пост
 * про кота, где доминирует политика). Поэтому в дополнение к вектору подтягиваем записи из кластера,
 * чьё имя похоже на слово из запроса. Сравнение — триграммная близость, чтобы переживать русскую
 * морфологию («животным» ≈ «Животные»). Это вспомогательный recall-путь, не замена семантики.
 */

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function trigrams(word: string): Set<string> {
  const s = `  ${word} `;
  const out = new Set<string>();
  for (let i = 0; i < s.length - 2; i++) out.add(s.slice(i, i + 3));
  return out;
}

/** Жаккар по символьным триграммам: [0..1], выше = слова похожи (терпимо к окончаниям). */
export function wordSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const ta = trigrams(a);
  const tb = trigrams(b);
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  const union = ta.size + tb.size - inter;
  return union ? inter / union : 0;
}

/**
 * Категории, чьё имя достаточно похоже на какое-либо слово запроса (≥ threshold).
 * Слова короче 3 символов из запроса игнорируем (предлоги/шум).
 */
export function matchClustersByName(
  clusters: Cluster[],
  query: string,
  threshold = 0.45,
): Cluster[] {
  const qWords = norm(query).split(' ').filter((w) => w.length >= 3);
  if (qWords.length === 0) return [];

  const out: Cluster[] = [];
  for (const c of clusters) {
    const cWords = norm(c.name).split(' ').filter(Boolean);
    let best = 0;
    for (const cw of cWords) {
      for (const qw of qWords) {
        best = Math.max(best, wordSimilarity(cw, qw));
      }
    }
    if (best >= threshold) out.push(c);
  }
  return out;
}
