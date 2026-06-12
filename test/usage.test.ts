import { beforeEach, describe, expect, it } from 'vitest';
import {
  __setClockForTest,
  breakerState,
  checkUserBudget,
  costOf,
  enforce,
  formatResetUtc,
  getGlobalSpendToday,
  getUserSpendToday,
  hydrateUsage,
  nextResetUtc,
  recordUsage,
  recordSttSeconds,
  snapshotUsage,
  utcDayKey,
} from '../src/ai/usage.js';
import { QuotaExceededError, BudgetExhaustedError } from '../src/ai/errors.js';
import { tuning } from '../src/config/tuning.js';

const DAY = '2026-06-09';
const FIXED = new Date(`${DAY}T10:00:00Z`);

/** Сколько выходных LLM-токенов нужно, чтобы потратить ровно $usd (по ценам tuning). */
function llmCompletionTokensForUsd(usd: number): number {
  return Math.ceil((usd / tuning.llmPriceCompletionPer1k) * 1000);
}

beforeEach(() => {
  __setClockForTest(() => FIXED);
  hydrateUsage(DAY, []); // чистое состояние на фиксированный день
});

describe('costOf', () => {
  it('эмбеддинги: только промпт-токены', () => {
    expect(costOf('embedding', 1000, 0)).toBeCloseTo(tuning.embeddingPricePer1k, 10);
  });

  it('llm: промпт + выход по своим ценам', () => {
    expect(costOf('llm', 1000, 1000)).toBeCloseTo(
      tuning.llmPricePromptPer1k + tuning.llmPriceCompletionPer1k,
      10,
    );
  });
});

describe('recordUsage / getSpend', () => {
  it('плюсует в per-user и в global', () => {
    recordUsage(42, 'llm', 1000, 1000);
    const expected = tuning.llmPricePromptPer1k + tuning.llmPriceCompletionPer1k;
    expect(getUserSpendToday(42)).toBeCloseTo(expected, 10);
    expect(getGlobalSpendToday()).toBeCloseTo(expected, 10);
  });

  it('userId=null учитывается только в global (анонимный/фоновый расход)', () => {
    recordUsage(null, 'embedding', 1000, 0);
    expect(getGlobalSpendToday()).toBeCloseTo(tuning.embeddingPricePer1k, 10);
    expect(getUserSpendToday(42)).toBe(0);
  });

  it('сбрасывает счётчики при смене UTC-дня', () => {
    recordUsage(7, 'llm', 0, llmCompletionTokensForUsd(1));
    expect(getUserSpendToday(7)).toBeGreaterThan(0);
    __setClockForTest(() => new Date('2026-06-10T00:01:00Z')); // следующий день
    expect(getUserSpendToday(7)).toBe(0);
    expect(getGlobalSpendToday()).toBe(0);
  });
});

describe('recordSttSeconds', () => {
  it('плюсует стоимость по минутам аудио в per-user и global (cost-only, без токенов)', () => {
    recordSttSeconds(42, 120); // 2 минуты
    const expected = 2 * tuning.sttPricePerMinute;
    expect(getUserSpendToday(42)).toBeCloseTo(expected, 10);
    expect(getGlobalSpendToday()).toBeCloseTo(expected, 10);
    // токен-поля не трогаем — в снимке только costUsd
    const row = snapshotUsage().find((r) => r.userId === 42);
    expect(row).toMatchObject({ llmPromptTokens: 0, llmCompletionTokens: 0, embeddingTokens: 0 });
  });

  it('userId=null — только в global', () => {
    recordSttSeconds(null, 60);
    expect(getGlobalSpendToday()).toBeCloseTo(tuning.sttPricePerMinute, 10);
    expect(getUserSpendToday(42)).toBe(0);
  });

  it('расход STT двигает enforce к персональному потолку', () => {
    const seconds = ((tuning.userDailyCostCeilingUsd / tuning.sttPricePerMinute) + 1) * 60;
    recordSttSeconds(7, seconds);
    expect(() => enforce(7)).toThrow(QuotaExceededError);
  });
});

describe('breakerState', () => {
  it('normal ниже мягкого порога', () => {
    recordUsage(null, 'llm', 0, llmCompletionTokensForUsd(tuning.globalDailySoftLimitUsd - 1));
    expect(breakerState()).toBe('normal');
  });

  it('degraded между мягким и жёстким порогом', () => {
    recordUsage(null, 'llm', 0, llmCompletionTokensForUsd(tuning.globalDailySoftLimitUsd + 0.5));
    expect(breakerState()).toBe('degraded');
  });

  it('paused на жёстком пороге и выше', () => {
    recordUsage(null, 'llm', 0, llmCompletionTokensForUsd(tuning.globalDailyHardLimitUsd + 1));
    expect(breakerState()).toBe('paused');
  });
});

describe('enforce', () => {
  it('не бросает в норме под потолком', () => {
    expect(() => enforce(1)).not.toThrow();
  });

  it('бросает QuotaExceededError при персональном потолке', () => {
    recordUsage(1, 'llm', 0, llmCompletionTokensForUsd(tuning.userDailyCostCeilingUsd + 0.1));
    expect(() => enforce(1)).toThrow(QuotaExceededError);
    // другой юзер под своим потолком — проходит
    expect(() => enforce(2)).not.toThrow();
  });

  it('бросает BudgetExhaustedError в paused (на любой userId, даже null)', () => {
    recordUsage(null, 'llm', 0, llmCompletionTokensForUsd(tuning.globalDailyHardLimitUsd + 1));
    expect(() => enforce(999)).toThrow(BudgetExhaustedError);
    expect(() => enforce(null)).toThrow(BudgetExhaustedError);
  });
});

describe('checkUserBudget', () => {
  it('allowed в норме', () => {
    expect(checkUserBudget(1)).toMatchObject({ allowed: true, reason: null });
  });

  it('reason=user при персональном потолке', () => {
    recordUsage(1, 'llm', 0, llmCompletionTokensForUsd(tuning.userDailyCostCeilingUsd + 0.1));
    expect(checkUserBudget(1)).toMatchObject({ allowed: false, reason: 'user' });
  });

  it('reason=paused при глобальной паузе (даже если юзер сам пустой)', () => {
    recordUsage(null, 'llm', 0, llmCompletionTokensForUsd(tuning.globalDailyHardLimitUsd + 1));
    expect(checkUserBudget(5)).toMatchObject({ allowed: false, reason: 'paused' });
  });

  it('degraded чтение НЕ блокирует', () => {
    recordUsage(null, 'llm', 0, llmCompletionTokensForUsd(tuning.globalDailySoftLimitUsd + 0.5));
    expect(breakerState()).toBe('degraded');
    expect(checkUserBudget(5)).toMatchObject({ allowed: true });
  });
});

describe('nextResetUtc / formatResetUtc', () => {
  it('ближайшая полночь UTC следующего дня', () => {
    expect(nextResetUtc().toISOString()).toBe('2026-06-10T00:00:00.000Z');
    expect(formatResetUtc(nextResetUtc())).toBe('00:00 UTC');
  });
});

describe('snapshot / hydrate', () => {
  it('roundtrip сохраняет суммы (global как userId=0)', () => {
    recordUsage(11, 'llm', 1000, 2000);
    recordUsage(22, 'embedding', 5000, 0);
    const snap = snapshotUsage();
    const globalCost = getGlobalSpendToday();

    hydrateUsage(DAY, []); // «рестарт» — память пустая
    expect(getGlobalSpendToday()).toBe(0);

    hydrateUsage(DAY, snap); // регидрация из снимка
    expect(getGlobalSpendToday()).toBeCloseTo(globalCost, 10);
    expect(getUserSpendToday(11)).toBeGreaterThan(0);
    expect(getUserSpendToday(22)).toBeCloseTo(costOf('embedding', 5000, 0), 10);
    // global-строка присутствует
    expect(snap.some((r) => r.userId === 0)).toBe(true);
  });
});

describe('utcDayKey', () => {
  it('берёт дату по UTC', () => {
    expect(utcDayKey(new Date('2026-06-09T23:59:59Z'))).toBe('2026-06-09');
  });
});
