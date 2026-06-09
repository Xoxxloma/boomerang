import { describe, it, expect } from 'vitest';
import { extractCitedIndices } from '../src/retrieval/synthesize.js';

describe('extractCitedIndices', () => {
  it('вытаскивает процитированные номера по порядку, без дублей', () => {
    expect(extractCitedIndices('Вот это [2], а ещё [1] и снова [2].', 3)).toEqual([1, 2]);
  });

  it('игнорирует номера вне диапазона 1..count', () => {
    expect(extractCitedIndices('есть [1] и [5]', 3)).toEqual([1]);
  });

  it('пусто, если синтез ничего не процитировал', () => {
    expect(extractCitedIndices('других данных о концертах нет', 4)).toEqual([]);
  });
});
