import { describe, expect, it } from 'vitest';
import { pickTrigger, MATURITY_THRESHOLD } from '../src/retrieval/proactive.js';
import type { AssignResult } from '../src/cluster/assign.js';

const res = (over: Partial<AssignResult>): AssignResult => ({
  clusterId: 'c1',
  isNew: false,
  size: 2,
  ...over,
});

describe('pickTrigger', () => {
  it('новый кластер — ничего не всплывает', () => {
    expect(pickTrigger(res({ isNew: true, size: 1 }), null)).toBeNull();
  });

  it('размер достиг порога и maturity ещё не слали → maturity', () => {
    expect(pickTrigger(res({ size: MATURITY_THRESHOLD }), null)).toBe('maturity');
  });

  it('размер достиг порога, но maturity уже слали → резонанс (не дублируем)', () => {
    expect(pickTrigger(res({ size: MATURITY_THRESHOLD }), new Date())).toBe('resonance');
  });

  it('дополнили существующий кластер ниже порога → резонанс', () => {
    expect(pickTrigger(res({ size: 2 }), null)).toBe('resonance');
  });

  it('размер выше порога (порог уже пройден ранее) → резонанс, не maturity', () => {
    expect(pickTrigger(res({ size: MATURITY_THRESHOLD + 1 }), null)).toBe('resonance');
  });
});
