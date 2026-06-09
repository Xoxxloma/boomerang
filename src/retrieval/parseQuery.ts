import { chatJson } from '../ai/llm.js';
import { PARSE_QUERY_SYSTEM, parseQueryPrompt } from '../ai/prompts.js';
import { listClusters } from '../db/clusters.js';
import { itemType, type Item } from '../db/schema.js';

/** Тип единицы контента (выведен из enum схемы, без дублей). */
export type ItemType = Item['type'];

export interface ParsedQuery {
  /** Смысловая тема для вектора (запрос без слов-фильтров); может быть пустой. */
  query: string;
  /** Ограничение по виду материала; пусто — не фильтруем. */
  types: ItemType[];
  /** Относительный период в днях («за две недели» → 14); null — без фильтра времени. */
  sinceDays: number | null;
  /** Синонимы/расшифровки темы — подмешиваются в текст для эмбеддинга (ловят сленг). */
  expansions: string[];
  /** id существующих кластеров, на которые ссылается запрос (прямой recall-путь). */
  clusterIds: string[];
}

/** Допустимые значения типа из схемы (для валидации ответа LLM). */
const VALID_TYPES = new Set<string>(itemType.enumValues);
/** Какие типы вообще разрешаем как фильтр (tg_post/text — слишком общие, не фильтруем). */
const FILTERABLE: ReadonlySet<string> = new Set(['document', 'image', 'video', 'link', 'voice']);
/** Сколько имён категорий максимум отдаём модели — чтобы не раздувать промпт у «тяжёлых» юзеров. */
const MAX_CLUSTER_NAMES = 80;

const PASSTHROUGH = (raw: string): ParsedQuery => ({
  query: raw,
  types: [],
  sinceDays: null,
  expansions: [],
  clusterIds: [],
});

interface RawParse {
  query?: string;
  types?: unknown;
  sinceDays?: unknown;
  expansions?: unknown;
  categories?: unknown;
}

function asStringArray(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v)]
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    .map((s) => s.trim())
    .slice(0, max);
}

/**
 * Разбор запроса в фильтры + синонимы + категории (один дешёвый LLM-вызов на каждый поиск).
 * Модель видит список категорий пользователя как кандидатов — так ловим сленг/неточности
 * («контра» → Counter-Strike → кластер «Киберспорт»), которые вектор и триграммы не перекидывают.
 * Никогда не бросает: при любой ошибке/мусоре возвращает passthrough (обычный семантический поиск).
 */
export async function parseQuery(userId: number, raw: string): Promise<ParsedQuery> {
  const query = raw.trim();
  if (!query) return PASSTHROUGH(query);

  try {
    const clusters = await listClusters(userId);
    const names = clusters.slice(0, MAX_CLUSTER_NAMES).map((c) => c.name);

    const res = await chatJson<RawParse>(parseQueryPrompt(query, names), {
      system: PARSE_QUERY_SYSTEM,
      temperature: 0,
    });

    const types = asStringArray(res.types, 8).filter(
      (t): t is ItemType => VALID_TYPES.has(t) && FILTERABLE.has(t),
    );

    const rawDays = typeof res.sinceDays === 'number' ? res.sinceDays : null;
    const sinceDays = rawDays && rawDays > 0 ? Math.floor(rawDays) : null;

    const expansions = asStringArray(res.expansions, 8);

    // Имена категорий из ответа → реальные id (без учёта регистра). Чужие/выдуманные имена отсекаются.
    const byName = new Map(clusters.map((c) => [c.name.toLowerCase(), c.id]));
    const clusterIds = asStringArray(res.categories, 16)
      .map((n) => byName.get(n.toLowerCase()))
      .filter((id): id is string => Boolean(id));

    const cleaned = typeof res.query === 'string' ? res.query.trim() : '';
    // Тема пуста только когда есть фильтр (метаданные-режим). Иначе — исходный запрос.
    const hasFilter = types.length > 0 || sinceDays !== null;
    const themeQuery = cleaned || (hasFilter ? '' : query);

    return { query: themeQuery, types, sinceDays, expansions, clusterIds };
  } catch (err) {
    console.error('parseQuery error:', err);
    return PASSTHROUGH(query);
  }
}
