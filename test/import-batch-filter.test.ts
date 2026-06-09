import { describe, it, expect } from 'vitest';
import { dedupeDrafts, isNoise } from '../src/import/batch.js';
import type { Draft } from '../src/import/draft.js';

function draft(p: Partial<Draft>): Draft {
  return {
    type: 'text',
    tgMessageId: null,
    sourceChat: null,
    rawText: null,
    url: null,
    title: null,
    tgFileId: null,
    tgFileUniqueId: null,
    ...p,
  };
}

describe('isNoise', () => {
  it('ссылка — не мусор даже без текста', () => {
    expect(isNoise(draft({ type: 'link', url: 'https://x.io', rawText: 'ok' }))).toBe(false);
  });
  it('файл — не мусор', () => {
    expect(isNoise(draft({ type: 'image', tgFileUniqueId: 'AQAD' }))).toBe(false);
  });
  it('короткая заметка без url/файла — мусор', () => {
    expect(isNoise(draft({ rawText: 'ок' }))).toBe(true);
  });
  it('одни эмодзи — мусор', () => {
    expect(isNoise(draft({ rawText: '🔥🔥🔥' }))).toBe(true);
  });
  it('содержательный текст — не мусор', () => {
    expect(isNoise(draft({ rawText: 'важная мысль про переезд и визу' }))).toBe(false);
  });
});

describe('dedupeDrafts', () => {
  it('схлопывает дубли по url', () => {
    const out = dedupeDrafts([
      draft({ type: 'link', url: 'https://x.io/a', rawText: 'раз' }),
      draft({ type: 'link', url: 'https://x.io/a', rawText: 'два' }),
    ]);
    expect(out).toHaveLength(1);
  });
  it('схлопывает дубли по file_unique_id', () => {
    const out = dedupeDrafts([
      draft({ type: 'image', tgFileUniqueId: 'AQAD' }),
      draft({ type: 'image', tgFileUniqueId: 'AQAD' }),
    ]);
    expect(out).toHaveLength(1);
  });
  it('схлопывает дубли по нормализованному тексту, выкидывает пустые', () => {
    const out = dedupeDrafts([
      draft({ rawText: 'Привет   мир' }),
      draft({ rawText: 'привет мир' }),
      draft({ rawText: null }),
    ]);
    expect(out).toHaveLength(1);
  });
});
