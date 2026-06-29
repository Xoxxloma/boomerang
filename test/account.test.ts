import { describe, it, expect } from 'vitest';
import { progressBar } from '../src/billing/account.js';

describe('progressBar', () => {
  it('0% — пустой бар', () => {
    expect(progressBar(0, 100)).toBe('░░░░░░░░░░ 0%');
  });
  it('50% — половина', () => {
    expect(progressBar(50, 100)).toBe('▓▓▓▓▓░░░░░ 50%');
  });
  it('100% — полный', () => {
    expect(progressBar(100, 100)).toBe('▓▓▓▓▓▓▓▓▓▓ 100%');
  });
  it('переполнение (после триала) — клампится до 100%, 10 ячеек', () => {
    const bar = progressBar(800, 100);
    expect(bar).toBe('▓▓▓▓▓▓▓▓▓▓ 100%');
    expect(bar.replace(/[^▓░]/g, '')).toHaveLength(10);
  });
  it('limit=0 — без деления на ноль', () => {
    expect(progressBar(5, 0)).toBe('░░░░░░░░░░ 0%');
  });
});
