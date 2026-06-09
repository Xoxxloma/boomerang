import { describe, it, expect } from 'vitest';
import type { Message } from 'grammy/types';
import { parseExport, draftFromExport, looksLikeExport, draftsFromMessages } from '../src/import/draft.js';

/** Минимальное фото-сообщение (член альбома, если задан gid) для тестов склейки. */
function photoMsg(id: number, opts: { gid?: string; caption?: string } = {}): Message {
  return {
    message_id: id,
    chat: { id: 1, type: 'private' },
    date: 0,
    photo: [{ file_id: `fid${id}`, file_unique_id: `uid${id}`, width: 1, height: 1 }],
    ...(opts.gid ? { media_group_id: opts.gid } : {}),
    ...(opts.caption ? { caption: opts.caption } : {}),
  } as unknown as Message;
}

function textMsg(id: number, text: string): Message {
  return { message_id: id, chat: { id: 1, type: 'private' }, date: 0, text } as unknown as Message;
}

describe('draftFromExport', () => {
  it('пропускает service-сообщения', () => {
    expect(draftFromExport({ type: 'service', text: 'pinned' })).toBeNull();
  });

  it('текстовый пост', () => {
    const d = draftFromExport({ type: 'message', text: 'мысль про инвестиции на будущее' });
    expect(d?.type).toBe('text');
    expect(d?.rawText).toBe('мысль про инвестиции на будущее');
    expect(d?.url).toBeNull();
  });

  it('ссылка из text_entities (text_link → href)', () => {
    const d = draftFromExport({
      type: 'message',
      text: 'статья тут',
      text_entities: [{ type: 'text_link', text: 'тут', href: 'https://ex.com/a' }],
    });
    expect(d?.type).toBe('link');
    expect(d?.url).toBe('https://ex.com/a');
  });

  it('ссылка из массива-рунов (plain link)', () => {
    const d = draftFromExport({
      type: 'message',
      text: ['смотри ', { type: 'link', text: 'https://foo.bar/x' }],
      text_entities: [{ type: 'link', text: 'https://foo.bar/x' }],
    });
    expect(d?.type).toBe('link');
    expect(d?.url).toBe('https://foo.bar/x');
    expect(d?.rawText).toBe('смотри https://foo.bar/x');
  });

  it('документ → имя файла как title, без telegram file_id', () => {
    const d = draftFromExport({ type: 'message', media_type: 'document', file_name: 'отчёт.pdf', file: 'files/1' });
    expect(d?.type).toBe('document');
    expect(d?.title).toBe('отчёт.pdf');
    expect(d?.tgFileId).toBeNull();
  });

  it('пересланное → sourceChat + tg_post', () => {
    const d = draftFromExport({ type: 'message', text: 'репост новости', forwarded_from: 'Канал Х' });
    expect(d?.type).toBe('tg_post');
    expect(d?.sourceChat).toBe('Канал Х');
  });

  it('фото без подписи → image', () => {
    const d = draftFromExport({ type: 'message', photo: 'photos/1.jpg', text: '' });
    expect(d?.type).toBe('image');
  });
});

describe('parseExport', () => {
  it('разбирает messages, отбрасывает service', () => {
    const json = {
      messages: [
        { type: 'service', text: 'X' },
        { type: 'message', text: 'первая заметка длинная' },
        { type: 'message', text: 'вторая заметка длинная' },
      ],
    };
    const drafts = parseExport(json);
    expect(drafts).toHaveLength(2);
  });

  it('пустой/кривой вход → []', () => {
    expect(parseExport({})).toEqual([]);
    expect(parseExport(null)).toEqual([]);
    expect(parseExport({ messages: 'нет' })).toEqual([]);
  });
});

describe('draftsFromMessages (склейка альбомов)', () => {
  it('альбом с подписью → ОДНА запись-пост с текстом подписи', () => {
    const msgs = [
      photoMsg(1, { gid: 'g1', caption: 'Хороший пост про путешествия и горы' }),
      photoMsg(2, { gid: 'g1' }),
      photoMsg(3, { gid: 'g1' }),
    ];
    const drafts = draftsFromMessages(msgs);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.type).toBe('text');
    expect(drafts[0]!.rawText).toBe('Хороший пост про путешествия и горы');
  });

  it('альбом без подписи → каждая картинка отдельно', () => {
    const msgs = [photoMsg(1, { gid: 'g2' }), photoMsg(2, { gid: 'g2' })];
    const drafts = draftsFromMessages(msgs);
    expect(drafts).toHaveLength(2);
    expect(drafts.every((d) => d.type === 'image')).toBe(true);
  });

  it('смесь одиночных и альбома — порядок сохраняется, группа эмитится один раз', () => {
    const msgs = [
      textMsg(1, 'первая отдельная заметка'),
      photoMsg(2, { gid: 'g3', caption: 'подпись альбома достаточно длинная' }),
      photoMsg(3, { gid: 'g3' }),
      textMsg(4, 'вторая отдельная заметка'),
    ];
    const drafts = draftsFromMessages(msgs);
    expect(drafts.map((d) => d.rawText)).toEqual([
      'первая отдельная заметка',
      'подпись альбома достаточно длинная',
      'вторая отдельная заметка',
    ]);
  });
});

describe('looksLikeExport', () => {
  it('настоящий экспорт (type + messages) → true', () => {
    expect(looksLikeExport({ type: 'saved_messages', id: 777, messages: [] })).toBe(true);
    expect(looksLikeExport({ type: 'personal_chat', messages: [{ id: 1 }] })).toBe(true);
  });

  it('произвольный JSON без type/messages → false', () => {
    expect(looksLikeExport({ foo: 'bar' })).toBe(false);
    expect(looksLikeExport({ messages: [] })).toBe(false); // нет type
    expect(looksLikeExport({ type: 'x' })).toBe(false); // нет messages
    expect(looksLikeExport([{ type: 'message' }])).toBe(false); // массив, не объект
    expect(looksLikeExport('строка')).toBe(false);
    expect(looksLikeExport(null)).toBe(false);
  });
});
