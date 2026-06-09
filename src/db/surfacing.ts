import { and, eq, gt, sql } from 'drizzle-orm';
import { db } from './client.js';
import { surfacingLog } from './schema.js';

export type SurfacingKind = 'resonance' | 'maturity';

export interface LogSurfacingInput {
  userId: number;
  kind: SurfacingKind;
  itemId?: string | null; // показанный старый item (resonance)
  clusterId?: string | null;
  triggerItemId?: string | null; // новое сообщение-повод
}

/** Записать факт проактивного всплытия (для дедупа и будущей аналитики). */
export async function logSurfacing(input: LogSurfacingInput): Promise<void> {
  await db.insert(surfacingLog).values({
    userId: input.userId,
    kind: input.kind,
    itemId: input.itemId ?? null,
    clusterId: input.clusterId ?? null,
    triggerItemId: input.triggerItemId ?? null,
  });
}

/** Показывали ли этот item проактивно за последние `days` дней (дедуп резонанса). */
export async function wasItemSurfacedRecently(
  userId: number,
  itemId: string,
  days: number,
): Promise<boolean> {
  const [row] = await db
    .select({ id: surfacingLog.id })
    .from(surfacingLog)
    .where(
      and(
        eq(surfacingLog.userId, userId),
        eq(surfacingLog.itemId, itemId),
        gt(surfacingLog.createdAt, sql`now() - (${days} || ' days')::interval`),
      ),
    )
    .limit(1);
  return Boolean(row);
}
