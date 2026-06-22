import { Hono } from 'hono';
import { listIndexedItems, listItemNeighbors } from '../../db/items.js';
import { toItemDTO } from '../serialize.js';
import type { ItemDTO } from '../serialize.js';
import type { AuthVars } from '../server.js';

export const mapRoutes = new Hono<{ Variables: AuthVars }>();

/** Сколько записей-звёзд берём в карту (свежие). Бьём «волосяной шар» прорежением рёбер ниже. */
const MAX_NODES = 300;
/** Сколько соседей на узел оставляем — иначе плотные кучки дают месиво. */
const NEIGHBORS_PER_NODE = 3;

/** Узел = запись целиком (тап → карточка) + степень связности (на размер звезды). */
type MapNode = ItemDTO & { size: number };
interface MapEdge {
  source: string;
  target: string;
  /** Сила связи [0..1] (косинус) — на прозрачность/толщину. */
  weight: number;
}

/**
 * Карта связей / Созвездие (фича B). Узлы — САМИ записи (звёзды), рёбра — семантическая близость
 * между записями (item-level kNN), без имён-категорий. Темы видны как визуальные сгущения: force-граф
 * стягивает близкие записи в кучки, но ярлык на них не вешается (нет ошибочной «Выпечки»). Тап по
 * звезде открывает запись. Раскладку считает клиент (force-граф).
 */
mapRoutes.get('/map', async (c) => {
  const userId = c.get('userId');
  const nodeItems = await listIndexedItems(userId, MAX_NODES);
  const allowed = new Set(nodeItems.map((it) => it.id));

  // Схлопываем направленные пары (a→b / b→a) в неориентированные рёбра (max близости). Оба конца
  // должны быть в наборе узлов (соседи за пределами MAX_NODES отбрасываем — их звезды на карте нет).
  const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const merged = new Map<string, { source: string; target: string; weight: number }>();
  for (const n of await listItemNeighbors(userId)) {
    if (!allowed.has(n.aId) || !allowed.has(n.bId)) continue;
    const key = edgeKey(n.aId, n.bId);
    const existing = merged.get(key);
    if (existing) existing.weight = Math.max(existing.weight, n.sim);
    else merged.set(key, { source: n.aId, target: n.bId, weight: n.sim });
  }

  // Прореживаем до top-N соседей на узел по крепости — чистый граф вместо хаоса.
  const degree = new Map<string, number>();
  const edges: MapEdge[] = [...merged.values()]
    .sort((x, y) => y.weight - x.weight)
    .filter((e) => {
      const ds = degree.get(e.source) ?? 0;
      const dt = degree.get(e.target) ?? 0;
      if (ds >= NEIGHBORS_PER_NODE && dt >= NEIGHBORS_PER_NODE) return false;
      degree.set(e.source, ds + 1);
      degree.set(e.target, dt + 1);
      return true;
    })
    .map((e) => ({ source: e.source, target: e.target, weight: Number(e.weight.toFixed(3)) }));

  const nodes: MapNode[] = nodeItems.map((it) => ({ ...toItemDTO(it), size: degree.get(it.id) ?? 0 }));

  return c.json({ nodes, edges });
});
