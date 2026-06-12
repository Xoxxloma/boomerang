import { describe, it, expect } from 'vitest';
import { extractCitedIndices, snippet } from '../src/retrieval/synthesize.js';
import type { Item } from '../src/db/schema.js';

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

describe('snippet', () => {
  const doc = {
    type: 'document',
    title: 'ДДУ № М-НА-632 Лосев К.В.pdf',
    description: null,
    rawText: null,
    ocrText: null,
    transcript: null,
    url: null,
  } as Item;

  it('пустышка (только имя файла) получает пометку «содержимое не прочитано»', () => {
    expect(snippet(doc)).toContain('содержимое не прочитано');
  });

  it('документ с телом пометку не получает', () => {
    const s = snippet({ ...doc, rawText: 'Договор долевого участия, зарегистрирован 01.02.2026' });
    expect(s).not.toContain('содержимое не прочитано');
    expect(s).toContain('зарегистрирован 01.02.2026');
  });

  it('url-хвост сохраняется после пометки', () => {
    const s = snippet({ ...doc, type: 'link', title: 'avito.ru', rawText: null, url: 'https://avito.ru/x' } as Item);
    expect(s).toContain('содержимое не прочитано');
    expect(s.endsWith('(https://avito.ru/x)')).toBe(true);
  });

  it('голосовое с транскриптом получает документный потолок (длинный войс не режется до 600)', () => {
    const transcript = 'а'.repeat(1500) + ' МАРКЕР_ХВОСТА';
    const s = snippet({ ...doc, type: 'voice', title: 'Про повышение', transcript } as Item);
    expect(s).toContain('МАРКЕР_ХВОСТА'); // при коротком cap (600) хвост бы отрезало
    expect(s).not.toContain('содержимое не прочитано'); // транскрипт = настоящее содержимое
  });
});
