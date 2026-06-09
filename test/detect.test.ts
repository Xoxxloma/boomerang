import { describe, it, expect } from 'vitest';
import type { Message } from 'grammy/types';
import { detect } from '../src/ingest/detect.js';

function msg(partial: Partial<Message>): Message {
  return { message_id: 1, date: 0, chat: { id: 1, type: 'private' }, ...partial } as Message;
}

describe('detect', () => {
  it('распознаёт ссылку по тексту', () => {
    const d = detect(msg({ text: 'смотри https://example.com/article интересно' }));
    expect(d.type).toBe('link');
    expect(d.url).toBe('https://example.com/article');
  });

  it('берёт url из text_link entity', () => {
    const d = detect(
      msg({
        text: 'тут статья',
        entities: [{ type: 'text_link', offset: 0, length: 3, url: 'https://foo.bar/x' }],
      }),
    );
    expect(d.type).toBe('link');
    expect(d.url).toBe('https://foo.bar/x');
  });

  it('пересланный текст без ссылки — tg_post', () => {
    const d = detect(
      msg({
        text: 'мысль из канала',
        forward_origin: { type: 'channel', chat: { id: -1, type: 'channel', title: 'Канал X' }, message_id: 5, date: 0 },
      }),
    );
    expect(d.type).toBe('tg_post');
    expect(d.sourceChat).toBe('Канал X');
  });

  it('обычный текст — text', () => {
    expect(detect(msg({ text: 'моя заметка' })).type).toBe('text');
  });

  it('фото с тривиальной подписью — image', () => {
    const d = detect(msg({ photo: [{ file_id: 'a', file_unique_id: 'a', width: 1, height: 1 }], caption: 'мем' }));
    expect(d.type).toBe('image');
    expect(d.text).toBe('мем');
  });

  it('фото с содержательной подписью — пост (text), не image', () => {
    const d = detect(
      msg({
        photo: [{ file_id: 'a', file_unique_id: 'a', width: 1, height: 1 }],
        caption: '1win выкупили лучшую команду мира по Доте',
      }),
    );
    expect(d.type).toBe('text');
    expect(d.text).toContain('Доте');
  });

  it('пересланное фото с подписью — tg_post', () => {
    const d = detect(
      msg({
        photo: [{ file_id: 'a', file_unique_id: 'a', width: 1, height: 1 }],
        caption: 'Большой обзор рынка недвижимости за квартал',
        forward_origin: { type: 'channel', chat: { id: -1, type: 'channel', title: 'Канал' }, message_id: 5, date: 0 },
      }),
    );
    expect(d.type).toBe('tg_post');
  });

  it('видео с подписью — пост (text), не video', () => {
    const d = detect(
      msg({
        video: { file_id: 'v', file_unique_id: 'v', width: 1, height: 1, duration: 1 },
        caption: 'Что произошло на концерте вчера вечером',
      }),
    );
    expect(d.type).toBe('text');
  });

  it('видео без подписи — video', () => {
    const d = detect(msg({ video: { file_id: 'v', file_unique_id: 'v', width: 1, height: 1, duration: 1 } }));
    expect(d.type).toBe('video');
  });

  it('документ — document', () => {
    const d = detect(msg({ document: { file_id: 'd', file_unique_id: 'd', file_name: 'spec.pdf' } }));
    expect(d.type).toBe('document');
  });

  it('видео — video', () => {
    const d = detect(msg({ video: { file_id: 'v', file_unique_id: 'v', width: 1, height: 1, duration: 1 } }));
    expect(d.type).toBe('video');
  });
});
