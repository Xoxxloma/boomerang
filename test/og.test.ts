import { describe, it, expect } from 'vitest';
import { isPlaceholderMeta, hostnameOf } from '../src/content/og.js';

describe('isPlaceholderMeta', () => {
  it('H1: title === description (анти-бот заглушка) → junk', () => {
    const junk = 'Авито — Объявления на сайте Авито';
    expect(isPlaceholderMeta(junk, junk, 'Авито')).toBe(true);
  });

  it('H1: совпадение нечувствительно к регистру/пробелам', () => {
    expect(isPlaceholderMeta('  Заглушка ', 'заглушка', undefined)).toBe(true);
  });

  it('H2: title === имя сайта → junk', () => {
    expect(isPlaceholderMeta('Авито', undefined, 'Авито')).toBe(true);
  });

  it('H2: title начинается с «{сайт} — » → junk', () => {
    expect(isPlaceholderMeta('Авито — Объявления на сайте Авито', undefined, 'Авито')).toBe(true);
  });

  it('легитимная статья (разные title/description) → не junk', () => {
    expect(
      isPlaceholderMeta('Как работают эмбеддинги', 'Разбираем векторный поиск на пальцах', 'Хабр'),
    ).toBe(false);
  });

  it('статья без og:title (title из <title>, описания нет) → не junk', () => {
    expect(isPlaceholderMeta('Интересный пост про котов', undefined, undefined)).toBe(false);
  });

  it('пустой title → не junk', () => {
    expect(isPlaceholderMeta(undefined, 'описание', 'Сайт')).toBe(false);
  });
});

describe('hostnameOf', () => {
  it('возвращает хост без www', () => {
    expect(hostnameOf('https://www.avito.ru/moskva/item_123')).toBe('avito.ru');
  });

  it('хост без www оставляет как есть', () => {
    expect(hostnameOf('https://habr.com/ru/articles/1')).toBe('habr.com');
  });

  it('невалидный URL → undefined', () => {
    expect(hostnameOf('не-урл')).toBeUndefined();
  });
});
