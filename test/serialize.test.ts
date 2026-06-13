import { describe, it, expect } from 'vitest';
import { toItemDTO } from '../src/web-api/serialize.js';
import type { Item } from '../src/db/schema.js';

const base = {
  id: 'it-1',
  userId: 1,
  tgMessageId: null,
  sourceChat: 'РБК',
  type: 'link',
  rawText: 'Моя заметка к ссылке',
  url: 'https://example.com',
  title: 'Заголовок статьи',
  description: 'OG-описание (машинное)',
  ocrText: 'секретный распознанный текст',
  transcript: 'секретный транскрипт',
  tgFileId: null,
  tgFileUniqueId: null,
  mediaGroupId: null,
  embedding: [0.1, 0.2],
  clusterId: 'c1',
  clusterLocked: false,
  createdAt: new Date('2026-05-20T10:00:00Z'),
  indexedAt: new Date('2026-05-20T10:01:00Z'),
} as unknown as Item;

describe('toItemDTO', () => {
  it('НЕ отдаёт сырьё в индекс: ocrText / transcript / description / embedding отсутствуют', () => {
    const dto = toItemDTO(base);
    const json = JSON.stringify(dto);
    expect(json).not.toContain('распознанный'); // ocrText не утекает
    expect(json).not.toContain('секретный транскрипт');
    expect(json).not.toContain('OG-описание');
    expect('embedding' in dto).toBe(false);
    expect('ocrText' in dto).toBe(false);
    expect('transcript' in dto).toBe(false);
    expect('description' in dto).toBe(false);
  });

  it('отдаёт видимые поля: title, url, sourceChat, свой текст, ISO-дату', () => {
    const dto = toItemDTO(base);
    expect(dto).toMatchObject({
      id: 'it-1',
      type: 'link',
      title: 'Заголовок статьи',
      url: 'https://example.com',
      sourceChat: 'РБК',
      text: 'Моя заметка к ссылке',
      clusterId: 'c1',
    });
    expect(dto.createdAt).toBe('2026-05-20T10:00:00.000Z');
  });

  it('name берётся из title; при отсутствии — из текста/url', () => {
    expect(toItemDTO({ ...base, title: null }).name).toBe('Моя заметка к ссылке');
    expect(toItemDTO({ ...base, title: null, rawText: null }).name).toBe('https://example.com');
  });

  it('длинный rawText усекается (тело документа не раздувает ответ)', () => {
    const long = 'я'.repeat(5000);
    const dto = toItemDTO({ ...base, rawText: long } as Item);
    expect(dto.text!.length).toBeLessThanOrEqual(1200);
  });
});
