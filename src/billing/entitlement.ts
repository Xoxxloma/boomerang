import { eq, sql } from 'drizzle-orm';
import { db, type Executor } from '../db/client.js';
import { entitlements, type Entitlement } from '../db/schema.js';
import { tuning } from '../config/tuning.js';
import type { PlanSource } from './plans.js';

/**
 * Источник истины «Pro» (§ монетизация по ёмкости). Эффективный тариф ВЫВОДИТСЯ из activeUntil > now()
 * — без крона, лениво при чтении. Гранты атомарны (UPSERT с GREATEST, без read-modify-write — правило
 * concurrency). Чистые helpers (effectiveTier/computeNextWindow) вынесены для юнит-тестов с инъекцией now.
 */
export type Tier = 'free' | 'pro';

export interface EntitlementView {
  tier: Tier;
  activeUntil: Date | null;
  /** Чем выдан доступ. Тип — от схемы (включает legacy 'subscription' у старых строк). */
  source: Entitlement['source'];
}

// --- Чистые функции (без БД) — для тестов ---

/** Эффективный тариф: pro ТОЛЬКО пока окно строго в будущем (граница == → free). */
export function effectiveTier(activeUntil: Date | null, now: Date): Tier {
  return activeUntil !== null && activeUntil.getTime() > now.getTime() ? 'pro' : 'free';
}

/** Новое окно доступа при гранте: старт = max(now, текущий конец), конец = старт + срок. */
export function computeNextWindow(
  activeUntil: Date | null,
  now: Date,
  durationSec: number,
): { from: Date; until: Date } {
  const fromMs = Math.max(now.getTime(), activeUntil?.getTime() ?? 0);
  return { from: new Date(fromMs), until: new Date(fromMs + durationSec * 1000) };
}

// --- БД-ввод/вывод ---

/** Текущий доступ юзера. Нет строки → free. */
export async function getEntitlement(userId: number, now: Date = new Date()): Promise<EntitlementView> {
  const [row] = await db.select().from(entitlements).where(eq(entitlements.userId, userId)).limit(1);
  if (!row) {
    return { tier: 'free', activeUntil: null, source: null };
  }
  return {
    tier: effectiveTier(row.activeUntil, now),
    activeUntil: row.activeUntil,
    source: row.source,
  };
}

export async function isPro(userId: number, now: Date = new Date()): Promise<boolean> {
  return (await getEntitlement(userId, now)).tier === 'pro';
}

/**
 * Выдать приветственный триал — ТОЛЬКО если строки ещё нет (ON CONFLICT DO NOTHING): существующим
 * (платившим или уже оттриаленным) повторно не выдаём. Окно считаем от now() БД.
 */
export async function grantTrial(userId: number): Promise<void> {
  await db
    .insert(entitlements)
    .values({
      userId,
      tier: 'pro',
      activeUntil: sql`now() + (${tuning.trialDurationSec})::int * interval '1 second'`,
      source: 'trial',
    })
    .onConflictDoNothing({ target: entitlements.userId });
}

export interface GrantInput {
  userId: number;
  source: PlanSource;
  durationSec: number;
}

/**
 * Выдать/продлить Pro атомарным UPSERT: activeUntil = GREATEST(текущий конец, now()) + срок — продление
 * сохраняет недоиспользованное время и складывается поверх триала. Никакого read-modify-write.
 */
export async function grantEntitlement(input: GrantInput, exec: Executor = db): Promise<void> {
  const { userId, source, durationSec } = input;
  await exec
    .insert(entitlements)
    .values({
      userId,
      tier: 'pro',
      activeUntil: sql`now() + (${durationSec})::int * interval '1 second'`,
      source,
    })
    .onConflictDoUpdate({
      target: entitlements.userId,
      set: {
        tier: 'pro',
        source,
        activeUntil: sql`GREATEST(COALESCE(${entitlements.activeUntil}, now()), now()) + (${durationSec})::int * interval '1 second'`,
        updatedAt: sql`now()`,
      },
    });
}

/** Рефанд: немедленно гасим доступ (activeUntil = now() → effectiveTier=free). */
export async function revokeForRefund(userId: number): Promise<void> {
  await db
    .update(entitlements)
    .set({ tier: 'free', activeUntil: sql`now()`, updatedAt: sql`now()` })
    .where(eq(entitlements.userId, userId));
}
