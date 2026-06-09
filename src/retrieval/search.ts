import { and, cosineDistance, desc, eq, gt, inArray, isNotNull, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { items, type Item } from '../db/schema.js';
import { embed } from '../ai/embeddings.js';
import { listClusters } from '../db/clusters.js';
import { matchClustersByName } from './clusterMatch.js';
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
  /** id кластеров из разбора запроса — добавляются к recall наравне с триграммным совпадением. */
  clusterIds?: string[];
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
 * Гибридный поиск (§6, режим 1): семантика по эмбеддингам + recall по названию категории.
 * Основа — вектор. Дополнительно: если запрос похож на имя кластера («животные» → «Животные»),
 * подтягиваем записи из этого кластера, даже если их косинус ниже порога — иначе запрос «по
 * названию категории» не находит пост, где тема растворена (кот в политическом посте).
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
  // Сколько слотов в выдаче ГАРАНТИРУЕМ под recall по имени категории (§4). Без квоты их топит
  // сортировка по косинусу: «растворённая» тема (кот в политическом посте) имеет низкий косинус и
  // вылетает при slice. Резерв заставляет её всплыть, потеснив наименее релевантную семантику.
  const recallQuota = Math.min(3, limit);
  const filters = filterConditions(opts.types, opts.sinceDays);

  // Эмбеддим тему + синонимы: «контра» один в один не ляжет на пост про Counter-Strike,
  // а с расширениями вектор подтягивается к нужным записям.
  const embedText = [query, ...(opts.expansions ?? [])].filter(Boolean).join(' ');
  const queryVec = await embed(embedText);
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

  const semantic: SearchHit[] = semanticRows.map((r) => ({ item: r.item, similarity: Number(r.similarity) }));

  // Recall-путь по категории: записи из кластеров, на которые указывает запрос. Два источника —
  // прямое попадание от LLM-разбора (ловит сленг: «контра» → «Киберспорт») и триграммное совпадение
  // имени (бэкап, работает даже если разбор отвалился).
  const trigramIds = matchClustersByName(await listClusters(userId), query).map((c) => c.id);
  const clusterIds = [...new Set([...(opts.clusterIds ?? []), ...trigramIds])];
  if (clusterIds.length === 0) return semantic;

  const seen = new Set(semantic.map((h) => h.item.id));
  // Берём с запасом (limit + quota): часть совпадёт с семантикой и отсеется — нам нужно НОВОЕ,
  // чтобы recall реально что-то добавил, а не вернул уже найденное вектором.
  const clusterRows = await db
    .select({ item: items, similarity })
    .from(items)
    .where(
      and(
        eq(items.userId, userId),
        isNotNull(items.embedding),
        inArray(items.clusterId, clusterIds),
        ...filters,
      ),
    )
    .orderBy(desc(similarity))
    .limit(limit + recallQuota);

  const recall: SearchHit[] = [];
  for (const r of clusterRows) {
    if (seen.has(r.item.id)) continue;
    recall.push({ item: r.item, similarity: Number(r.similarity) });
    if (recall.length >= recallQuota) break;
  }
  if (recall.length === 0) return semantic;

  // Резервируем место под recall: оставляем топ семантики, добиваем категорийными записями.
  const keep = semantic.slice(0, Math.max(0, limit - recall.length));
  return [...keep, ...recall];
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
