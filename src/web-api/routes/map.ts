import { Hono } from 'hono';
import { listClusters, getCluster } from '../../db/clusters.js';
import { listClusterItems } from '../../retrieval/search.js';
import { listClusterBridges, listBridgePairs, listItemsByIds } from '../../db/items.js';
import { IMAGE_SHELF, LINKS_SHELF } from '../../cluster/assign.js';
import { toItemDTO } from '../serialize.js';
import type { AuthVars } from '../server.js';

export const mapRoutes = new Hono<{ Variables: AuthVars }>();

/** Сколько ближайших соседей на узел оставляем в графе — иначе плотные темы дают «волосяной шар». */
const NEIGHBORS_PER_NODE = 3;
/** Полки-свалки (без темы) связываются со всем подряд — шум; в граф мостов их не пускаем (как в echo). */
const SHELFLESS = new Set([IMAGE_SHELF, LINKS_SHELF]);

interface MapNode {
  id: string;
  name: string;
  size: number;
}
interface MapEdge {
  source: string;
  target: string;
  /** Сила связи [0..1] для рендера (opacity/width). Здесь = крепость самой сильной общей нити. */
  weight: number;
  /** Сколько записей реально перекинуто мостом между темами — сколько общих нитей. */
  bridges: number;
}

/**
 * Карта связей / Созвездие (фича B). Узлы — кластеры (размер ∝ size). Рёбра — РЕАЛЬНЫЕ мосты между
 * записями (item-level kNN), а не близость центроидов: центроид — усреднение, теряет растворённую тему
 * (кот в политическом посте не сближает «Животных» и «Политику» по средним). Ребро = «темы делят нити»;
 * изолят = «общих нитей нет» (честный сигнал, не артефакт порога). Раскладку считает клиент (force-граф).
 */
mapRoutes.get('/map', async (c) => {
  const userId = c.get('userId');
  const all = await listClusters(userId);
  // Узлы — все непустые темы, кроме полок-свалок. Центроид больше не требуется: изолят теперь осмыслен.
  const visible = all.filter((cl) => cl.size > 0 && !SHELFLESS.has(cl.name));
  const allowed = new Set(visible.map((cl) => cl.id));
  const nodes: MapNode[] = visible.map((cl) => ({ id: cl.id, name: cl.name, size: cl.size }));

  // Схлопываем направленные мосты (ca→cb / cb→ca) в неориентированные рёбра: сумма нитей, max крепости.
  const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const merged = new Map<string, { source: string; target: string; bridges: number; weight: number }>();
  for (const br of await listClusterBridges(userId)) {
    if (!allowed.has(br.ca) || !allowed.has(br.cb)) continue; // мосты к полкам-свалкам отбрасываем
    const key = edgeKey(br.ca, br.cb);
    const existing = merged.get(key);
    if (existing) {
      existing.bridges += br.bridges;
      existing.weight = Math.max(existing.weight, br.topSim);
    } else {
      merged.set(key, { source: br.ca, target: br.cb, bridges: br.bridges, weight: br.topSim });
    }
  }

  // Прореживаем до top-N соседей на узел по числу нитей — чистый граф вместо хаоса плотных тем.
  const degree = new Map<string, number>();
  const edges: MapEdge[] = [...merged.values()]
    .sort((x, y) => y.bridges - x.bridges)
    .filter((e) => {
      const ds = degree.get(e.source) ?? 0;
      const dt = degree.get(e.target) ?? 0;
      if (ds >= NEIGHBORS_PER_NODE && dt >= NEIGHBORS_PER_NODE) return false;
      degree.set(e.source, ds + 1);
      degree.set(e.target, dt + 1);
      return true;
    })
    .map((e) => ({ source: e.source, target: e.target, weight: Number(e.weight.toFixed(3)), bridges: e.bridges }));

  return c.json({ nodes, edges });
});

/** Сколько нитей-мостов показываем под ребром — дайджест, а не свалка всех пар. */
const MAX_BRIDGE_PAIRS = 8;

/**
 * Нити под ребром «Созвездия» (тап по связи): какие именно записи связывают две темы. Делает ребро
 * действием, а не декорацией — пользователь видит реальные переклички (кот в политическом посте ↔ пост
 * из «Животных»), а не «темы вообще похожи». Жадный дедуп: каждая запись участвует максимум в одной нити,
 * чтобы один «хаб»-пост не занял весь список — показываем разнообразие мостов, а не один сильный.
 */
mapRoutes.get('/map/bridge', async (c) => {
  const userId = c.get('userId');
  const aId = c.req.query('a');
  const bId = c.req.query('b');
  if (!aId || !bId || aId === bId) return c.json({ error: 'bad-request' }, 400);

  const [ca, cb] = await Promise.all([getCluster(aId), getCluster(bId)]);
  if (!ca || !cb || ca.userId !== userId || cb.userId !== userId) return c.json({ error: 'not-found' }, 404);

  const raw = await listBridgePairs(userId, aId, bId);
  const usedA = new Set<string>();
  const usedB = new Set<string>();
  const picked: typeof raw = [];
  for (const p of raw) {
    if (picked.length >= MAX_BRIDGE_PAIRS) break;
    if (usedA.has(p.aId) || usedB.has(p.bId)) continue;
    usedA.add(p.aId);
    usedB.add(p.bId);
    picked.push(p);
  }

  const ids = [...new Set(picked.flatMap((p) => [p.aId, p.bId]))];
  const byId = new Map((await listItemsByIds(userId, ids)).map((it) => [it.id, it]));
  const pairs = picked.flatMap((p) => {
    const ia = byId.get(p.aId);
    const ib = byId.get(p.bId);
    return ia && ib
      ? [{ itemA: toItemDTO(ia), itemB: toItemDTO(ib), similarity: Number(p.similarity.toFixed(3)) }]
      : [];
  });

  return c.json({
    clusterA: { id: ca.id, name: ca.name },
    clusterB: { id: cb.id, name: cb.name },
    pairs,
  });
});

/** Записи конкретного кластера — для разворота узла в спутники. Проверяем владельца. */
mapRoutes.get('/clusters/:id/items', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const cluster = await getCluster(id);
  if (!cluster || cluster.userId !== userId) return c.json({ error: 'not-found' }, 404);

  const items = await listClusterItems(userId, id, 24);
  return c.json({
    cluster: { id: cluster.id, name: cluster.name, size: cluster.size },
    items: items.map(toItemDTO),
  });
});
