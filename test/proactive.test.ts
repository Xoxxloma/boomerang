import { describe, expect, it } from 'vitest';
import { pickTrigger, MATURITY_THRESHOLD } from '../src/retrieval/proactive.js';
import type { AssignResult } from '../src/cluster/assign.js';

const res = (over: Partial<AssignResult>): AssignResult => ({
  clusterId: 'c1',
  name: 'Тема',
  isNew: false,
  size: 2,
  ...over,
});

describe('pickTrigger', () => {
  it('новый кластер — ничего не всплывает', () => {
    expect(pickTrigger(res({ isNew: true, size: 1 }), null, 1)).toBeNull();
  });

  it('содержательных достигло порога и maturity ещё не слали → maturity', () => {
    expect(pickTrigger(res({ size: MATURITY_THRESHOLD }), null, MATURITY_THRESHOLD)).toBe('maturity');
  });

  it('размер кластера ≥ порога, но содержательных меньше (пустышки) → резонанс, не maturity', () => {
    expect(pickTrigger(res({ size: MATURITY_THRESHOLD }), null, MATURITY_THRESHOLD - 2)).toBe('resonance');
  });

  it('содержательных уже выше порога (перепрыг) и maturity не слали → maturity (>=, не ===)', () => {
    expect(pickTrigger(res({ size: MATURITY_THRESHOLD + 1 }), null, MATURITY_THRESHOLD + 1)).toBe('maturity');
  });

  it('порог достигнут, но maturity уже слали (maturedAt) → резонанс (не дублируем)', () => {
    expect(pickTrigger(res({ size: MATURITY_THRESHOLD }), new Date(), MATURITY_THRESHOLD)).toBe('resonance');
  });

  it('дополнили существующий кластер ниже порога → резонанс', () => {
    expect(pickTrigger(res({ size: 2 }), null, 2)).toBe('resonance');
  });
});
