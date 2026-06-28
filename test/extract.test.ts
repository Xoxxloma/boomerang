import { describe, it, expect } from 'vitest';
import {
  buildIndexText,
  buildClassifySignal,
  hasRealContent,
  isContentlessLink,
  type Indexable,
} from '../src/ingest/extract.js';

const base: Indexable = {
  type: 'link',
  url: 'https://example.com',
  title: 'Заголовок',
  description: 'Описание',
  rawText: 'Текст поста',
  ocrText: null,
  transcript: null,
  bodyText: null,
  sourceChat: null,
};

describe('buildIndexText', () => {
  it('склеивает все содержательные поля, включая ocr_text', () => {
    const text = buildIndexText({ ...base, ocrText: 'распознанный текст' });
    expect(text).toContain('Заголовок');
    expect(text).toContain('распознанный текст');
    expect(text).toContain('https://example.com');
  });

  it('НЕ включает имя источника (бренд/ирония смещает вектор не по смыслу — источник отдельный фасет)', () => {
    const text = buildIndexText({ ...base, sourceChat: 'печеньки' });
    expect(text).not.toContain('печеньки');
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

  it('голосовое: transcript входит в сигнал (для него это главный контент)', () => {
    const s = buildClassifySignal({
      ...base,
      type: 'voice',
      url: null,
      title: null,
      description: null,
      rawText: null,
      transcript: 'приходил Иванов спрашивал про повышение',
    });
    expect(s).toContain('приходил Иванов');
  });

  it('у ссылок transcript в сигнал не подмешивается (link-ветка не менялась)', () => {
    const s = buildClassifySignal({ ...base, transcript: 'НЕ ДОЛЖНО ПОПАСТЬ' });
    expect(s).not.toContain('НЕ ДОЛЖНО ПОПАСТЬ');
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

  it('для ссылки без текста — сигнал из слов URL (де-слаг хоста/пути)', () => {
    const s = buildClassifySignal({ ...base, title: null, description: null, rawText: null });
    expect(s).toBe('Содержание: example.com');
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

  it('голая ссылка (rawText === url) → сырой URL не ведёт сигнал, ведёт title', () => {
    const s = buildClassifySignal({
      ...base,
      type: 'link',
      url: 'https://youtube.com/watch?v=abc',
      rawText: 'https://youtube.com/watch?v=abc',
      title: 'Никонов х Старшинов | Киберстихи',
      description: null,
    });
    expect(s.startsWith('Содержание: Никонов х Старшинов | Киберстихи')).toBe(true);
    expect(s).not.toContain('https://'); // сырой URL в сигнал не попал (вместо него — де-слаг)
  });

  it('тему ссылки берём из пути URL, когда OG-заглушка (avito → одежда/обувь)', () => {
    const s = buildClassifySignal({
      ...base,
      type: 'link',
      url: 'https://www.avito.ru/moskva/odezhda_obuv_aksessuary/maison_margiela_8102862059?utm_source=x',
      rawText: 'https://www.avito.ru/moskva/odezhda_obuv_aksessuary/maison_margiela_8102862059',
      title: 'avito.ru',
      description: null,
    });
    expect(s).toContain('odezhda obuv aksessuary');
    expect(s).toContain('maison margiela');
    expect(s).not.toContain('8102862059'); // чисто-числовой id отброшен
    expect(s).not.toContain('utm'); // query отброшен
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

describe('hasRealContent', () => {
  const empty: Indexable = {
    type: 'text',
    url: null,
    title: null,
    description: null,
    rawText: null,
    ocrText: null,
    transcript: null,
    bodyText: null,
    sourceChat: null,
  };

  it('голая ссылка (rawText = сам URL) → false', () => {
    expect(
      hasRealContent({ ...empty, type: 'link', url: 'https://avito.ru/x', rawText: 'https://avito.ru/x' }),
    ).toBe(false);
  });

  it('ссылка с подписью → true', () => {
    expect(
      hasRealContent({ ...empty, type: 'link', url: 'https://a.ru/x', rawText: 'кеды оригинал https://a.ru/x' }),
    ).toBe(true);
  });

  it('документ только с именем файла (title) → false', () => {
    expect(hasRealContent({ ...empty, type: 'document', title: 'ДДУ № М-НА-632 Лосев К.В.pdf' })).toBe(false);
  });

  it('документ с подписью юзера → true', () => {
    expect(
      hasRealContent({ ...empty, type: 'document', title: 'scan.pdf', rawText: 'это договор по квартире' }),
    ).toBe(true);
  });

  it('voice без транскрипции и подписи → false, с транскрипцией → true', () => {
    expect(hasRealContent({ ...empty, type: 'voice' })).toBe(false);
    expect(hasRealContent({ ...empty, type: 'voice', transcript: 'напомни про оплату' })).toBe(true);
  });

  it('description (OG) или ocrText считаются содержимым', () => {
    expect(hasRealContent({ ...empty, type: 'link', url: 'https://a.ru', description: 'статья про X' })).toBe(true);
    expect(hasRealContent({ ...empty, type: 'image', ocrText: 'текст с картинки' })).toBe(true);
  });
});

describe('isContentlessLink', () => {
  const bare: Indexable = {
    type: 'link',
    url: 'https://www.avito.ru/',
    title: 'avito.ru',
    description: null,
    rawText: 'https://www.avito.ru/',
    ocrText: null,
    transcript: null,
    bodyText: null,
    sourceChat: null,
  };

  it('хост-title без OG/подписи/слов пути → true', () => {
    expect(isContentlessLink(bare)).toBe(true);
  });

  it('слаг со словами пути → false (тему понесёт слаг)', () => {
    expect(
      isContentlessLink({ ...bare, url: 'https://www.avito.ru/moskva/odezhda_obuv/maison_123' }),
    ).toBe(false);
  });

  it('настоящий OG-title → false', () => {
    expect(isContentlessLink({ ...bare, title: 'Maison Margiela кеды — объявление' })).toBe(false);
  });

  it('есть OG-description → false', () => {
    expect(isContentlessLink({ ...bare, description: 'объявление о продаже' })).toBe(false);
  });

  it('не-ссылка → false', () => {
    expect(isContentlessLink({ ...bare, type: 'document' })).toBe(false);
  });
});
