import { describe, it, expect } from 'vitest';
import { buildIndexText, buildClassifySignal, type Indexable } from '../src/ingest/extract.js';

const base: Indexable = {
  type: 'link',
  url: 'https://example.com',
  title: 'Заголовок',
  description: 'Описание',
  rawText: 'Текст поста',
  ocrText: null,
  transcript: null,
  sourceChat: null,
};

describe('buildIndexText', () => {
  it('склеивает все содержательные поля, включая ocr_text', () => {
    const text = buildIndexText({ ...base, ocrText: 'распознанный текст' });
    expect(text).toContain('Заголовок');
    expect(text).toContain('распознанный текст');
    expect(text).toContain('https://example.com');
  });

  it('включает имя источника (для поиска по теме канала)', () => {
    const text = buildIndexText({ ...base, sourceChat: 'SL4M & Counter-Strike' });
    expect(text).toContain('SL4M & Counter-Strike');
  });

  it('пропускает пустые поля', () => {
    const text = buildIndexText({ ...base, description: null, rawText: null });
    expect(text).toBe('Заголовок\nhttps://example.com');
  });
});

describe('buildClassifySignal', () => {
  it('использует title/description/rawText, без OCR', () => {
    const s = buildClassifySignal({ ...base, ocrText: 'ШУМ OCR' });
    expect(s).toContain('Заголовок');
    expect(s).not.toContain('ШУМ OCR');
  });

  it('добавляет имя источника первым, помечая его явно', () => {
    const s = buildClassifySignal({ ...base, sourceChat: 'SL4M & Counter-Strike' });
    expect(s).toContain('Источник (канал/автор): SL4M & Counter-Strike');
    expect(s.indexOf('Источник')).toBeLessThan(s.indexOf('Содержание'));
  });

  it('классифицирует по одному источнику, даже если текста нет', () => {
    const s = buildClassifySignal({
      ...base,
      title: null,
      description: null,
      rawText: null,
      url: null,
      sourceChat: 'Канал про недвижимость',
    });
    expect(s).toBe('Источник (канал/автор): Канал про недвижимость');
  });

  it('режет содержание до 500 символов', () => {
    const s = buildClassifySignal({ ...base, title: 'a'.repeat(1000), description: null, rawText: null });
    expect(s).toBe('Содержание: ' + 'a'.repeat(500));
  });

  it('падает на url, если текста нет', () => {
    const s = buildClassifySignal({ ...base, title: null, description: null, rawText: null });
    expect(s).toBe('Содержание: https://example.com');
  });

  it('для ссылки подпись юзера (rawText) идёт первой — title анти-бот сайта это шум', () => {
    const s = buildClassifySignal({
      ...base,
      type: 'link',
      title: 'Авито — Объявления на сайте Авито',
      description: null,
      rawText: 'Maison Margiela x HM кеды оригинал',
    });
    expect(s.indexOf('Maison Margiela')).toBeLessThan(s.indexOf('Авито'));
  });

  it('голая ссылка (rawText === url) → URL не ведёт сигнал, ведёт title', () => {
    const s = buildClassifySignal({
      ...base,
      type: 'link',
      url: 'https://youtube.com/watch?v=abc',
      rawText: 'https://youtube.com/watch?v=abc',
      title: 'Никонов х Старшинов | Киберстихи',
      description: null,
    });
    expect(s).toBe('Содержание: Никонов х Старшинов | Киберстихи');
  });

  it('для документа имя файла (title) остаётся первым — подпись может быть шумом', () => {
    const s = buildClassifySignal({
      ...base,
      type: 'document',
      title: 'договор_аренды_2024.pdf',
      description: null,
      rawText: 'лол смотри что нашёл',
    });
    expect(s.indexOf('договор_аренды')).toBeLessThan(s.indexOf('лол'));
  });
});
