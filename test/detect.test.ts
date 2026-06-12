import { describe, it, expect } from 'vitest';
import type { Message } from 'grammy/types';
import { detect, mediaFileRef, TG_FILE_LIMIT_BYTES } from '../src/ingest/detect.js';

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

  it('голосовое — voice', () => {
    const d = detect(msg({ voice: { file_id: 'v', file_unique_id: 'vu', duration: 30 } }));
    expect(d.type).toBe('voice');
  });

  it('аудиофайл — voice', () => {
    const d = detect(msg({ audio: { file_id: 'a', file_unique_id: 'au', duration: 180 } }));
    expect(d.type).toBe('voice');
  });
});

describe('mediaFileRef', () => {
  it('голосовое: fileId + uid (транскрибируемо)', () => {
    const ref = mediaFileRef(msg({ voice: { file_id: 'v1', file_unique_id: 'vu1', duration: 30, file_size: 100_000 } }));
    expect(ref).toEqual({ tgFileId: 'v1', tgFileUniqueId: 'vu1' });
  });

  it('аудио с тегами трека: title = «Исполнитель — Название»', () => {
    const ref = mediaFileRef(
      msg({ audio: { file_id: 'a1', file_unique_id: 'au1', duration: 180, performer: 'Miyagi', title: 'Captain' } }),
    );
    expect(ref.tgFileId).toBe('a1');
    expect(ref.title).toBe('Miyagi — Captain');
  });

  it('аудио без тегов: title нет', () => {
    const ref = mediaFileRef(msg({ audio: { file_id: 'a1', file_unique_id: 'au1', duration: 180 } }));
    expect(ref.title).toBeUndefined();
  });

  it('файл >20MB: uid для дедупа есть, fileId нет (Bot API не отдаст), tooBig для предупреждения', () => {
    const ref = mediaFileRef(
      msg({
        video: { file_id: 'v1', file_unique_id: 'vu1', width: 1, height: 1, duration: 600, file_size: TG_FILE_LIMIT_BYTES + 1 },
      }),
    );
    expect(ref).toEqual({ tgFileUniqueId: 'vu1', tooBig: true });
  });

  it('видео ровно на лимите — ещё скачиваемо', () => {
    const ref = mediaFileRef(
      msg({
        video: { file_id: 'v1', file_unique_id: 'vu1', width: 1, height: 1, duration: 60, file_size: TG_FILE_LIMIT_BYTES },
      }),
    );
    expect(ref.tgFileId).toBe('v1');
    expect(ref.tooBig).toBeUndefined();
  });

  it('кружок (video_note) транскрибируем', () => {
    const ref = mediaFileRef(msg({ video_note: { file_id: 'n1', file_unique_id: 'nu1', length: 1, duration: 30 } }));
    expect(ref.tgFileId).toBe('n1');
  });

  it('gif (animation): только uid — аудиодорожки нет, транскрибировать нечего', () => {
    const ref = mediaFileRef(
      msg({ animation: { file_id: 'g1', file_unique_id: 'gu1', width: 1, height: 1, duration: 3 } }),
    );
    expect(ref).toEqual({ tgFileUniqueId: 'gu1' });
  });

  it('сообщение без медиа — пусто', () => {
    expect(mediaFileRef(msg({ text: 'просто текст' }))).toEqual({});
  });
});
