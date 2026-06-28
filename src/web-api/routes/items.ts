import { Hono } from 'hono';
import { getItem, listSimilarItems } from '../../db/items.js';
import { tuning } from '../../config/tuning.js';
import { toItemDTO } from '../serialize.js';
import type { AuthVars } from '../server.js';

export const itemsRoutes = new Hono<{ Variables: AuthVars }>();

/**
 * «Похожие записи» (фаза A): семантические соседи записи (item-kNN) для блока «Рядом» в карточке.
 * Та же нить, что в Карте/боте. Запись без вектора или без близких → пустой список (блока нет).
 */
itemsRoutes.get('/items/:id/similar', async (c) => {
  const userId = c.get('userId');
  const item = await getItem(c.req.param('id'));
  if (!item || item.userId !== userId) return c.json({ error: 'not-found' }, 404);
  const similar = await listSimilarItems(userId, item, tuning.similarLimit);
  return c.json({ similar: similar.map(toItemDTO) });
});
