import { Hono } from 'hono';
import { computeEcho } from '../../retrieval/echo.js';
import { toItemDTO } from '../serialize.js';
import type { AuthVars } from '../server.js';

export const echoRoutes = new Hono<{ Variables: AuthVars }>();

/** Лента возврата (фича C): «само возвращается» — перекличка + годовщины. Без LLM. */
echoRoutes.get('/echo', async (c) => {
  const userId = c.get('userId');
  const cards = await computeEcho(userId);
  return c.json({
    cards: cards.map((card) => ({
      kind: card.kind,
      item: card.item ? toItemDTO(card.item) : null,
      relatedItem: card.relatedItem ? toItemDTO(card.relatedItem) : null,
    })),
  });
});
