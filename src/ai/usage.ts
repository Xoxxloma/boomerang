import { tuning } from '../config/tuning.js';
import { QuotaExceededError, BudgetExhaustedError } from './errors.js';

/**
 * Учёт LLM/эмбеддинг-расхода и состояние circuit breaker (§ бюджет-ядро). Счётчики живут в памяти
 * (горячий путь без БД), сбрасываются по UTC-дню; персистентность (флаш/регидрация) — снаружи, в
 * db/usage.ts, через чистые snapshot/hydrate ниже. Модуль НЕ тянет БД/env — безопасен в юнит-тестах.
 */

export type UsageKind = 'llm' | 'embedding';
export type BreakerState = 'normal' | 'degraded' | 'paused';

/** Строка дневного учёта (userId === 0 — глобальный агрегат). */
export interface UsageRow {
  userId: number;
  llmPromptTokens: number;
  llmCompletionTokens: number;
  embeddingTokens: number;
  costUsd: number;
}

interface Bucket {
  llmPromptTokens: number;
  llmCompletionTokens: number;
  embeddingTokens: number;
  costUsd: number;
}

function emptyBucket(): Bucket {
  return { llmPromptTokens: 0, llmCompletionTokens: 0, embeddingTokens: 0, costUsd: 0 };
}

/**
 * Тестовый сеам для времени. Прод всегда на реальных часах; тесты подменяют, чтобы детерминированно
 * проверить ролловер по UTC-дню. Math.random здесь не нужен.
 */
let clock: () => Date = () => new Date();
/** @internal только для тестов. */
export function __setClockForTest(fn: () => Date): void {
  clock = fn;
}

/** Ключ суток в UTC (YYYY-MM-DD) — граница сброса дневных счётчиков. */
export function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

let day = utcDayKey(clock());
let globalBucket = emptyBucket();
let perUser = new Map<number, Bucket>();

/** Сброс счётчиков при смене UTC-дня (ленивый, на каждом обращении). */
function rollIfNeeded(): void {
  const today = utcDayKey(clock());
  if (today !== day) {
    day = today;
    globalBucket = emptyBucket();
    perUser = new Map();
  }
}

/** Стоимость одного вызова в долларах по ценам из tuning. */
export function costOf(kind: UsageKind, promptTokens: number, completionTokens: number): number {
  if (kind === 'embedding') return (promptTokens / 1000) * tuning.embeddingPricePer1k;
  return (
    (promptTokens / 1000) * tuning.llmPricePromptPer1k +
    (completionTokens / 1000) * tuning.llmPriceCompletionPer1k
  );
}

function addToBucket(b: Bucket, kind: UsageKind, prompt: number, completion: number, cost: number): void {
  if (kind === 'embedding') b.embeddingTokens += prompt;
  else {
    b.llmPromptTokens += prompt;
    b.llmCompletionTokens += completion;
  }
  b.costUsd += cost;
}

/** Учесть платный вызов: плюсует токены и стоимость в дневные бакеты (global + per-user). */
export function recordUsage(
  userId: number | null,
  kind: UsageKind,
  promptTokens: number,
  completionTokens: number,
): void {
  rollIfNeeded();
  const cost = costOf(kind, promptTokens, completionTokens);
  addToBucket(globalBucket, kind, promptTokens, completionTokens, cost);
  if (userId != null && userId !== 0) {
    const b = perUser.get(userId) ?? emptyBucket();
    addToBucket(b, kind, promptTokens, completionTokens, cost);
    perUser.set(userId, b);
  }
}

/**
 * Учесть STT-вызов (транскрипция): биллинг по секундам аудио, не по токенам — плюсуем ТОЛЬКО
 * стоимость (cost-only) в дневные бакеты. Токен-поля не трогаем, поэтому персистентность
 * (snapshot/hydrate → usage_daily.cost_usd) и потолки/breaker работают без изменений схемы.
 */
export function recordSttSeconds(userId: number | null, seconds: number): void {
  rollIfNeeded();
  const cost = (seconds / 60) * tuning.sttPricePerMinute;
  globalBucket.costUsd += cost;
  if (userId != null && userId !== 0) {
    const b = perUser.get(userId) ?? emptyBucket();
    b.costUsd += cost;
    perUser.set(userId, b);
  }
}

/**
 * Учесть vision-вызов (аннотация картинки): токены плюсуем в llm-поля бакета (отдельных полей под
 * vision в usage_daily нет и не нужно — модель та же семья), стоимость — по vision-ценам из tuning.
 * prompt_tokens ответа OpenAI уже включает image-токены — ничего не пересчитываем.
 */
export function recordVisionUsage(userId: number | null, promptTokens: number, completionTokens: number): void {
  rollIfNeeded();
  const cost =
    (promptTokens / 1000) * tuning.visionPricePromptPer1k +
    (completionTokens / 1000) * tuning.visionPriceCompletionPer1k;
  addToBucket(globalBucket, 'llm', promptTokens, completionTokens, cost);
  if (userId != null && userId !== 0) {
    const b = perUser.get(userId) ?? emptyBucket();
    addToBucket(b, 'llm', promptTokens, completionTokens, cost);
    perUser.set(userId, b);
  }
}

export function getUserSpendToday(userId: number): number {
  rollIfNeeded();
  return perUser.get(userId)?.costUsd ?? 0;
}

export function getGlobalSpendToday(): number {
  rollIfNeeded();
  return globalBucket.costUsd;
}

/** Состояние глобального breaker по общему дневному расходу. */
export function breakerState(): BreakerState {
  const spend = getGlobalSpendToday();
  if (spend >= tuning.globalDailyHardLimitUsd) return 'paused';
  if (spend >= tuning.globalDailySoftLimitUsd) return 'degraded';
  return 'normal';
}

/** Ближайшая полночь UTC — когда обнулятся дневные счётчики. */
export function nextResetUtc(): Date {
  const next = new Date(clock());
  next.setUTCHours(24, 0, 0, 0);
  return next;
}

/** «HH:MM UTC» для пользовательских сообщений о сбросе лимита. */
export function formatResetUtc(d: Date): string {
  return `${d.toISOString().slice(11, 16)} UTC`;
}

export interface BudgetCheck {
  allowed: boolean;
  reason: 'user' | 'paused' | null;
  resetsAt: Date;
}

/**
 * Пре-чек для read-хендлеров (поиск, /digest): даёт чистое сообщение, не тратя эмбеддинг.
 * Блокирует ТОЛЬКО на персональном потолке ('user') или paused. degraded чтение не трогает.
 */
export function checkUserBudget(userId: number): BudgetCheck {
  const resetsAt = nextResetUtc();
  if (breakerState() === 'paused') return { allowed: false, reason: 'paused', resetsAt };
  if (getUserSpendToday(userId) >= tuning.userDailyCostCeilingUsd) {
    return { allowed: false, reason: 'user', resetsAt };
  }
  return { allowed: true, reason: null, resetsAt };
}

/**
 * Жёсткий гард на обёртках LLM/эмбеддингов — зовётся ДО обращения к API. Бросает на:
 *  - paused (общий бюджет исчерпан) → стоп всему;
 *  - персональный потолок → стоп этому юзеру.
 * degraded тут НЕ участвует — его решают сами места дорогой генерации через breakerState().
 */
export function enforce(userId: number | null): void {
  if (breakerState() === 'paused') throw new BudgetExhaustedError();
  if (userId != null && getUserSpendToday(userId) >= tuning.userDailyCostCeilingUsd) {
    throw new QuotaExceededError(nextResetUtc());
  }
}

// --- Персистентность: чистые snapshot/hydrate (DB-ввод/вывод — в db/usage.ts) ---

/** Текущий UTC-день учёта (для флаша под правильной датой). */
export function getUsageDay(): string {
  rollIfNeeded();
  return day;
}

/** Снимок дневных бакетов для флаша в БД (global как userId=0). */
export function snapshotUsage(): UsageRow[] {
  rollIfNeeded();
  const rows: UsageRow[] = [{ userId: 0, ...globalBucket }];
  for (const [userId, b] of perUser) rows.push({ userId, ...b });
  return rows;
}

/** Регидрация дневных бакетов из БД на старте (перезаписывает текущее состояние под dayKey). */
export function hydrateUsage(dayKey: string, rows: UsageRow[]): void {
  day = dayKey;
  globalBucket = emptyBucket();
  perUser = new Map();
  for (const r of rows) {
    const b: Bucket = {
      llmPromptTokens: r.llmPromptTokens,
      llmCompletionTokens: r.llmCompletionTokens,
      embeddingTokens: r.embeddingTokens,
      costUsd: r.costUsd,
    };
    if (r.userId === 0) globalBucket = b;
    else perUser.set(r.userId, b);
  }
}
