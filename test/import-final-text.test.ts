import { describe, it, expect } from 'vitest';
import { finalText } from '../src/import/progress.js';
import type { BatchResult } from '../src/import/batch.js';

function res(p: Partial<BatchResult>): BatchResult {
  return {
    saved: 0,
    images: 0,
    skipped: 0,
    existingDupes: [],
    inBatchDupes: [],
    existingDupeCount: 0,
    inBatchDupeCount: 0,
    ...p,
  };
}

describe('finalText', () => {
  it('пусто — ни сохранённого, ни пропущенного', () => {
    expect(finalText(res({}))).toBe('Не нашёл, что обработать. Перешли что-нибудь — и спроси.');
  });

  it('показывает секцию «уже были в Бумеранге» с именами', () => {
    const t = finalText(
      res({ saved: 2, skipped: 1, existingDupeCount: 1, existingDupes: ['Как оформить ВНЖ'] }),
    );
    expect(t).toContain('✅ Разобрал 2.');
    expect(t).toContain('Эти посты уже были в Бумеранге, не добавил повторно:');
    expect(t).toContain('• Как оформить ВНЖ');
    expect(t).not.toContain('Убрал повторы внутри заливки');
  });

  it('показывает секцию «повторы внутри заливки» отдельно', () => {
    const t = finalText(res({ saved: 1, skipped: 1, inBatchDupeCount: 1, inBatchDupes: ['Рецепт том-яма'] }));
    expect(t).toContain('Убрал повторы внутри заливки:');
    expect(t).toContain('• Рецепт том-яма');
  });

  it('сворачивает длинный список в «…и ещё N»', () => {
    const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const t = finalText(res({ saved: 1, skipped: 7, existingDupeCount: 7, existingDupes: names }));
    expect(t).toContain('• a');
    expect(t).toContain('• e');
    expect(t).not.toContain('• f');
    expect(t).toContain('…и ещё 2');
  });

  it('saved===0 при наличии дублей — «Ничего нового не добавил» + список', () => {
    const t = finalText(res({ saved: 0, skipped: 1, existingDupeCount: 1, existingDupes: ['Старый пост'] }));
    expect(t).toContain('Ничего нового не добавил.');
    expect(t).toContain('• Старый пост');
    expect(t).not.toContain('Не нашёл, что обработать');
  });

  it('остаток пропуска сверх дублей — мелочь числом', () => {
    const t = finalText(res({ saved: 1, skipped: 3, existingDupeCount: 1, existingDupes: ['x'] }));
    expect(t).toContain('Пропустил мелочь без текста: 2.');
  });
});
