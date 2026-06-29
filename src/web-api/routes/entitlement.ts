import { Hono } from 'hono';
import { getEntitlement } from '../../billing/entitlement.js';
import { getCapacity } from '../../billing/capacity.js';
import type { AuthVars } from '../server.js';

export const entitlementRoutes = new Hono<{ Variables: AuthVars }>();

/**
 * Текущий доступ + ёмкость базы для Mini App: индикатор «база used/limit» и CTA на апгрейд. Гейтинга
 * роутов нет (единственная стена — приём, на стороне бота) — это только данные для UI. limit=null = безлимит.
 */
entitlementRoutes.get('/entitlement', async (c) => {
  const userId = c.get('userId');
  const [ent, cap] = await Promise.all([getEntitlement(userId), getCapacity(userId)]);
  return c.json({
    tier: ent.tier,
    activeUntil: ent.activeUntil ? ent.activeUntil.toISOString() : null,
    source: ent.source,
    capacity: {
      used: cap.used,
      limit: Number.isFinite(cap.limit) ? cap.limit : null,
    },
  });
});
