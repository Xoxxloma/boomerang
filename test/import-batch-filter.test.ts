import { describe, it, expect } from 'vitest';
import { dedupeDrafts, isNoise, dropPostedStragglers } from '../src/import/batch.js';
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
    mediaGroupId: null,
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
  it('схлопывает дубли по url, повтор уходит в dupes', () => {
    const out = dedupeDrafts([
      draft({ type: 'link', url: 'https://x.io/a', rawText: 'раз' }),
      draft({ type: 'link', url: 'https://x.io/a', rawText: 'два' }),
    ]);
    expect(out.kept).toHaveLength(1);
    expect(out.dupes).toHaveLength(1);
  });
  it('схлопывает дубли по file_unique_id', () => {
    const out = dedupeDrafts([
      draft({ type: 'image', tgFileUniqueId: 'AQAD' }),
      draft({ type: 'image', tgFileUniqueId: 'AQAD' }),
    ]);
    expect(out.kept).toHaveLength(1);
    expect(out.dupes).toHaveLength(1);
  });
  it('схлопывает дубли по нормализованному тексту, выкидывает пустые (не как дубли)', () => {
    const out = dedupeDrafts([
      draft({ rawText: 'Привет   мир' }),
      draft({ rawText: 'привет мир' }),
      draft({ rawText: null }),
    ]);
    expect(out.kept).toHaveLength(1);
    expect(out.dupes).toHaveLength(1); // только текстовый повтор; пустой — не дубль
  });
});

describe('dropPostedStragglers', () => {
  it('выкидывает image-осколок уже-постнутого альбома', () => {
    const out = dropPostedStragglers(
      [draft({ type: 'image', tgFileUniqueId: 'u1', mediaGroupId: 'g1' })],
      new Set(['g1']),
    );
    expect(out).toHaveLength(0);
  });

  it('оставляет картинки альбома без подписи (gid не постнут)', () => {
    const out = dropPostedStragglers(
      [
        draft({ type: 'image', tgFileUniqueId: 'u1', mediaGroupId: 'g2' }),
        draft({ type: 'image', tgFileUniqueId: 'u2', mediaGroupId: 'g2' }),
      ],
      new Set(['g1']),
    );
    expect(out).toHaveLength(2);
  });

  it('не трогает не-image записи того же gid (повторно присланный пост-член)', () => {
    const out = dropPostedStragglers(
      [draft({ type: 'tg_post', rawText: 'подпись', mediaGroupId: 'g1' })],
      new Set(['g1']),
    );
    expect(out).toHaveLength(1);
  });

  it('не трогает одиночные картинки без gid', () => {
    const out = dropPostedStragglers([draft({ type: 'image', tgFileUniqueId: 'u1' })], new Set(['g1']));
    expect(out).toHaveLength(1);
  });
});
