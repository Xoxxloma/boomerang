import { describe, it, expect } from 'vitest';
import { computeCapacity } from '../src/billing/capacity.js';

const CAP = 100;

describe('computeCapacity (free)', () => {
  it('used < limit → можно добавлять, остаток корректен', () => {
    const c = computeCapacity(false, 40, CAP);
    expect(c).toMatchObject({ used: 40, limit: CAP, remaining: 60, canAdd: true, pro: false });
  });

  it('used == limit → нельзя, остаток 0', () => {
    const c = computeCapacity(false, CAP, CAP);
    expect(c.canAdd).toBe(false);
    expect(c.remaining).toBe(0);
  });

  it('used > limit (после триала) → нельзя, остаток не отрицательный', () => {
    const c = computeCapacity(false, 800, CAP);
    expect(c.canAdd).toBe(false);
    expect(c.remaining).toBe(0);
  });
});

describe('computeCapacity (pro)', () => {
  it('безлимит: canAdd, remaining/limit = Infinity', () => {
    const c = computeCapacity(true, 800, CAP);
    expect(c.canAdd).toBe(true);
    expect(c.pro).toBe(true);
    expect(c.limit).toBe(Infinity);
    expect(c.remaining).toBe(Infinity);
  });
});
