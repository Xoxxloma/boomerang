import { and, gt, lte } from 'drizzle-orm';
import { db } from './client.js';
import { accessReminders, entitlements, type Entitlement } from './schema.js';
import type { AccessReminderKind } from '../reminders/access-window.js';

/**
 * БД-слой напоминаний об окончании Pro-доступа. Источник истины «когда кончается» — entitlements.activeUntil
 * (без отдельного расписания на покупке): свип берёт истекающие окна отсюда. Дедуп отправок — таблица
 * access_reminders (claim через INSERT ... ON CONFLICT), ключ включает activeUntil → продление = свежее окно.
 */

export interface DueWindow {
  userId: number;
  activeUntil: Date;
  source: Entitlement['source'];
}

/**
 * Окна доступа, истекающие в (now − 1д, now + 3д] — кандидаты на напоминания d3/d1/d0. Узкий диапазон =
 * дешёвый запрос; какие именно kind созрели для строки, решает чистая dueKinds (reminders/access-window).
 */
export async function dueAccessWindows(now: Date, limit: number): Promise<DueWindow[]> {
  const lo = new Date(now.getTime() - 86_400_000);
  const hi = new Date(now.getTime() + 3 * 86_400_000);
  const rows = await db
    .select({
      userId: entitlements.userId,
      activeUntil: entitlements.activeUntil,
      source: entitlements.source,
    })
    .from(entitlements)
    .where(and(gt(entitlements.activeUntil, lo), lte(entitlements.activeUntil, hi)))
    .limit(limit);
  // activeUntil гарантированно не NULL (NULL не проходит сравнения в WHERE) — сужаем тип для DueWindow.
  return rows.filter((r): r is DueWindow => r.activeUntil !== null);
}

/**
 * Атомарно застолбить отправку (user, activeUntil, kind): true — застолбили (можно слать); false —
 * уже отправляли (дубль/повторный тик свипа). INSERT ... ON CONFLICT DO NOTHING — no check-then-act.
 */
export async function claimAccessReminder(
  userId: number,
  activeUntil: Date,
  kind: AccessReminderKind,
): Promise<boolean> {
  const rows = await db
    .insert(accessReminders)
    .values({ userId, activeUntil, kind })
    .onConflictDoNothing({
      target: [accessReminders.userId, accessReminders.activeUntil, accessReminders.kind],
    })
    .returning({ userId: accessReminders.userId });
  return rows.length > 0;
}
