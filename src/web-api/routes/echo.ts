import { Hono } from 'hono';
import { computeEcho } from '../../retrieval/echo.js';
import { listClusterItems } from '../../retrieval/search.js';
import { getCluster } from '../../db/clusters.js';
import { tuning } from '../../config/tuning.js';
import { checkUserBudget, formatResetUtc } from '../../ai/usage.js';
import { toItemDTO } from '../serialize.js';
import { buildSynthResponse } from '../synthResponse.js';
import type { AuthVars } from '../server.js';

export const echoRoutes = new Hono<{ Variables: AuthVars }>();

/** Лента возврата (фича C): «само возвращается» — перекличка, годовщины, созревшие темы. Без LLM. */
echoRoutes.get('/echo', async (c) => {
  const userId = c.get('userId');
  const cards = await computeEcho(userId);
  return c.json({
    cards: cards.map((card) => ({
      kind: card.kind,
      clusterId: card.clusterId ?? null,
      clusterName: card.clusterName ?? null,
      count: card.count ?? null,
      item: card.item ? toItemDTO(card.item) : null,
      relatedItem: card.relatedItem ? toItemDTO(card.relatedItem) : null,
    })),
  });
});

/**
 * Свести тему в связный ответ (кнопка «Свести» из Эха/Карты, режим 1). Синтез по реальным записям
 * кластера, а не перезапрос по имени. Бюджет-гард → 429.
 */
echoRoutes.post('/synthesize', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<{ clusterId?: string }>().catch(() => ({}) as { clusterId?: string });
  const clusterId = body.clusterId;
  if (!clusterId) return c.json({ error: 'no-cluster' }, 400);

  const cluster = await getCluster(clusterId);
  if (!cluster || cluster.userId !== userId) return c.json({ error: 'not-found' }, 404);
  // Незрелую тему не сводим: список и так на виду, свод лишь жжёт бюджет. Клиент прячет кнопку,
  // но защищаемся и тут — на случай устаревшего фронта.
  if (cluster.size < tuning.maturityThreshold) return c.json({ error: 'immature' }, 422);

  const budget = checkUserBudget(userId);
  if (!budget.allowed) {
    return c.json(
      { error: 'budget', reason: budget.reason, resetsAt: formatResetUtc(budget.resetsAt) },
      429,
    );
  }

  const items = await listClusterItems(userId, clusterId, 8);
  if (items.length === 0) return c.json({ mode: 'empty', answer: null, sources: [], cited: [] });

  const hits = items.map((item) => ({ item, similarity: 1 }));
  const res = await buildSynthResponse(cluster.name, hits, userId);
  return c.json({ mode: 'synthesis', clusterName: cluster.name, ...res });
});
