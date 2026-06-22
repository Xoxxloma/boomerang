import { and, cosineDistance, desc, eq, gt, inArray, isNotNull, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { items, type Item } from '../db/schema.js';
import { embed } from '../ai/embeddings.js';
import type { ItemType } from './parseQuery.js';
import { tuning } from '../config/tuning.js';

export interface SearchHit {
  item: Item;
  similarity: number; // 1 - cosine distance, [−1..1], выше = ближе
}

export interface SearchOptions {
  limit?: number;
  /** Порог похожести: ниже — отсекаем как нерелевантное. */
  minSimilarity?: number;
  /** Фильтр по виду материала (из разбора запроса); пусто — все типы. */
  types?: ItemType[];
  /** Фильтр по свежести: только записи за последние N дней; null — без ограничения. */
  sinceDays?: number | null;
  /** Синонимы темы — подмешиваются в текст эмбеддинга, чтобы вектор ловил сленг/неточности. */
  expansions?: string[];
}

/** Доп-условия фильтра тип/время — общие для семантики, recall и метаданных-листинга. */
function filterConditions(types?: ItemType[], sinceDays?: number | null): SQL[] {
  const out: SQL[] = [];
  if (types && types.length > 0) out.push(inArray(items.type, types));
  if (sinceDays && sinceDays > 0) {
    out.push(gt(items.createdAt, sql`now() - (${sinceDays} || ' days')::interval`));
  }
  return out;
}

/**
 * Семантический поиск (§6, режим 1): по эмбеддингам записей. Категорий/кластеров нет — фундамент
 * извлечения это вектор; сленг/неточности ловит query-expansion (синонимы в parseQuery), а не recall
 * по имени категории. Тема + синонимы эмбеддятся одной строкой.
 */
export async function search(
  userId: number,
  query: string,
  opts: SearchOptions = {},
): Promise<SearchHit[]> {
  const limit = opts.limit ?? 8;
  // Порог похожести (§12, настраивается через SEARCH_MIN_SIMILARITY). Низкий: text-embedding-3-small
  // даёт малые косинусы на русском, 0.28 резал релевантное. Шум отсекаем порядком (desc) + лимитом.
  const minSimilarity = opts.minSimilarity ?? tuning.searchMinSimilarity;
  const filters = filterConditions(opts.types, opts.sinceDays);

  // Эмбеддим тему + синонимы: «контра» один в один не ляжет на пост про Counter-Strike,
  // а с расширениями вектор подтягивается к нужным записям.
  const embedText = [query, ...(opts.expansions ?? [])].filter(Boolean).join(' ');
  const queryVec = await embed(embedText, userId);
  const similarity = sql<number>`1 - (${cosineDistance(items.embedding, queryVec)})`;

  const semanticRows = await db
    .select({ item: items, similarity })
    .from(items)
    .where(
      and(
        eq(items.userId, userId),
        isNotNull(items.embedding),
        gt(similarity, minSimilarity),
        ...filters,
      ),
    )
    .orderBy(desc(similarity))
    .limit(limit);

  return semanticRows.map((r) => ({ item: r.item, similarity: Number(r.similarity) }));
}

export interface ListFilter {
  types?: ItemType[];
  sinceDays?: number | null;
  limit?: number;
}

/**
 * Чисто-метаданные выборка по тип/время, по убыванию даты, без вектора и порога.
 * Для запросов «какие документы за две недели», где темы нет — отдаём список по свежести,
 * а не гоним LLM-синтез (§приоритет извлечения, но «список» здесь честнее «связного ответа»).
 */
export async function listByFilter(userId: number, opts: ListFilter = {}): Promise<Item[]> {
  const limit = opts.limit ?? 20;
  const filters = filterConditions(opts.types, opts.sinceDays);
  return db
    .select()
    .from(items)
    .where(and(eq(items.userId, userId), ...filters))
    .orderBy(desc(items.createdAt))
    .limit(limit);
}
