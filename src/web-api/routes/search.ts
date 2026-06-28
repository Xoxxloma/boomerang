import { Hono } from 'hono';
import { search, listByFilter } from '../../retrieval/search.js';
import { parseQuery } from '../../retrieval/parseQuery.js';
import { checkUserBudget, formatResetUtc } from '../../ai/usage.js';
import { tuning } from '../../config/tuning.js';
import { toItemDTO } from '../serialize.js';
import { buildSynthResponse } from '../synthResponse.js';
import type { AuthVars } from '../server.js';

export const searchRoutes = new Hono<{ Variables: AuthVars }>();

/**
 * Поиск с синтезом (режим 1) — зеркало handleQuery из бота, но JSON для Mini App.
 * Бюджет-гард → 429; метаданные-режим (фильтр без темы) → список; иначе семантика + связный синтез.
 */
searchRoutes.post('/search', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<{ query?: string }>().catch(() => ({}) as { query?: string });
  const query = (body.query ?? '').trim();
  if (!query) return c.json({ error: 'empty-query' }, 400);

  const budget = checkUserBudget(userId);
  if (!budget.allowed) {
    return c.json(
      { error: 'budget', reason: budget.reason, resetsAt: formatResetUtc(budget.resetsAt) },
      429,
    );
  }

  let parsed;
  try {
    parsed = await parseQuery(userId, query);
  } catch {
    parsed = { query, types: [], sinceDays: null, expansions: [] };
  }
  const hasFilter = parsed.types.length > 0 || parsed.sinceDays !== null;

  // Метаданные-режим: фильтр есть, темы нет («документы за две недели») → список по свежести, без LLM.
  if (hasFilter && !parsed.query) {
    const list = await listByFilter(userId, { types: parsed.types, sinceDays: parsed.sinceDays });
    return c.json({
      mode: 'list',
      answer: null,
      cited: [],
      sources: list.map((it, i) => ({ index: i + 1, ...toItemDTO(it) })),
    });
  }

  const opts = { types: parsed.types, sinceDays: parsed.sinceDays, expansions: parsed.expansions };
  let hits = await search(userId, parsed.query || query, opts);
  // Пустая выдача ≠ «нет в архиве»: второй проход с recall-порогом (ниже обычного) поднимает близкое,
  // что не прошло из-за разрыва формулировок. Зеркало handleQuery — иначе бот и Mini App расходились бы.
  if (hits.length === 0) {
    hits = await search(userId, parsed.query || query, {
      ...opts,
      minSimilarity: tuning.searchRecallMinSimilarity,
    });
  }

  if (hits.length === 0) return c.json({ mode: 'empty', answer: null, sources: [], cited: [] });

  const res = await buildSynthResponse(parsed.query || query, hits, userId);
  return c.json({ mode: 'synthesis', ...res });
});
