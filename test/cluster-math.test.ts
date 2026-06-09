import { describe, it, expect } from 'vitest';
import { cosineSimilarity, updatedCentroid } from '../src/cluster/math.js';

describe('cosineSimilarity', () => {
  it('идентичные векторы → 1', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
  });
  it('ортогональные → 0', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });
  it('противоположные → −1', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 6);
  });
  it('нулевой вектор → 0 (без NaN)', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe('updatedCentroid', () => {
  it('инкрементальное среднее', () => {
    // центроид [0,0] из 1 точки + новая [2,4] → [1,2]
    expect(updatedCentroid([0, 0], 1, [2, 4])).toEqual([1, 2]);
  });
  it('сходится к среднему при росте size', () => {
    // центроид [10] из 9 точек + [0] → (90+0)/10 = 9
    expect(updatedCentroid([10], 9, [0])).toEqual([9]);
  });
});
