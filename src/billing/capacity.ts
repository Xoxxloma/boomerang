import { countUserItems } from '../db/items.js';
import { isPro } from './entitlement.js';
import { tuning } from '../config/tuning.js';

/**
 * Гейт добавления — единственная платная стена (§ монетизация по ёмкости). Free держит до
 * freeArchiveCap записей, Pro — безлимит. Считаем фактический COUNT(items): источник правды — сами
 * записи (удаление освобождает место). Гонок нет — приём сериализован per-user (bot sequentialize),
 * web записей не создаёт. Арифметика вынесена в чистый computeCapacity для юнит-тестов.
 */
/** Бросается на попытке сохранить запись сверх потолка free-тарифа (единая точка — saveItem). */
export class CapacityError extends Error {
  constructor(
    readonly used: number,
    readonly limit: number,
  ) {
    super(`capacity exceeded: ${used}/${limit}`);
    this.name = 'CapacityError';
  }
}

export interface Capacity {
  used: number;
  /** Потолок; Infinity для Pro. */
  limit: number;
  /** Сколько ещё влезет; Infinity для Pro, не отрицательное. */
  remaining: number;
  canAdd: boolean;
  pro: boolean;
}

/** Чистый расчёт ёмкости — для тестов (без БД). */
export function computeCapacity(pro: boolean, used: number, cap: number): Capacity {
  if (pro) return { used, limit: Infinity, remaining: Infinity, canAdd: true, pro: true };
  const remaining = Math.max(0, cap - used);
  return { used, limit: cap, remaining, canAdd: used < cap, pro: false };
}

export async function getCapacity(userId: number, now: Date = new Date()): Promise<Capacity> {
  const [pro, used] = await Promise.all([isPro(userId, now), countUserItems(userId)]);
  return computeCapacity(pro, used, tuning.freeArchiveCap);
}

/** Можно ли сохранить ещё одну запись прямо сейчас. */
export async function canAdd(userId: number, now: Date = new Date()): Promise<boolean> {
  return (await getCapacity(userId, now)).canAdd;
}

/** Сколько записей ещё влезет (Infinity для Pro) — для батч-импорта: режем пачку под остаток. */
export async function remainingSlots(userId: number, now: Date = new Date()): Promise<number> {
  return (await getCapacity(userId, now)).remaining;
}
