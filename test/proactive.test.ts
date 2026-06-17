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

const T = MATURITY_THRESHOLD;

describe('pickTrigger', () => {
  it('новый кластер — ничего не всплывает', () => {
    expect(pickTrigger(res({ isNew: true, size: 1 }), 0, 1)).toBeNull();
  });

  it('содержательных достигло порога, рубеж 0 → maturity', () => {
    expect(pickTrigger(res({ size: T }), 0, T)).toBe('maturity');
  });

  it('размер кластера ≥ порога, но содержательных меньше (пустышки) → резонанс, не maturity', () => {
    expect(pickTrigger(res({ size: T }), 0, T - 2)).toBe('resonance');
  });

  it('содержательных уже выше порога (перепрыг через рубеж) → maturity на достигнутом кратном', () => {
    expect(pickTrigger(res({ size: T + 1 }), 0, T + 1)).toBe('maturity');
  });

  it('порог достигнут, но рубеж уже на этом кратном → резонанс (не дублируем тот же рубеж)', () => {
    expect(pickTrigger(res({ size: T }), T, T)).toBe('resonance');
  });

  it('дорос до СЛЕДУЮЩЕГО кратного (10) сверх отправленного (5) → maturity снова', () => {
    expect(pickTrigger(res({ size: 2 * T }), T, 2 * T)).toBe('maturity');
  });

  it('между кратными (7 при отправленном рубеже 5) → резонанс (новый рубеж не пройден)', () => {
    expect(pickTrigger(res({ size: T + 2 }), T, T + 2)).toBe('resonance');
  });

  it('скачок 5→15 при отправленном рубеже 5 → maturity (объявим 15, не дублируем 10)', () => {
    expect(pickTrigger(res({ size: 3 * T }), T, 3 * T)).toBe('maturity');
  });

  it('дополнили существующий кластер ниже порога → резонанс', () => {
    expect(pickTrigger(res({ size: 2 }), 0, 2)).toBe('resonance');
  });
});
