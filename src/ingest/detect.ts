import type { Message, MessageEntity } from 'grammy/types';
import type { itemType } from '../db/schema.js';

export type ItemType = (typeof itemType.enumValues)[number];

export interface Detected {
  type: ItemType;
  url?: string;
  /** Текст из сообщения: text или caption. */
  text: string;
  /** Откуда переслано (имя канала/чата/пользователя), если применимо. */
  sourceChat?: string;
}

const URL_RE = /https?:\/\/[^\s)]+/i;

/** Достаёт первый URL: сначала из entities (надёжно), потом регексом по тексту. */
function extractUrl(text: string, entities?: MessageEntity[]): string | undefined {
  if (entities) {
    for (const e of entities) {
      if (e.type === 'text_link' && e.url) return e.url;
      if (e.type === 'url') return text.slice(e.offset, e.offset + e.length);
    }
  }
  return text.match(URL_RE)?.[0];
}

/**
 * Подпись считается содержательной (это пост, а не голый мем/видео), если в ней есть реальный текст.
 * Порог намеренно низкий: короткие реплики «лол/ор» → нет; фраза из 3+ слов или ≥16 символов → да.
 */
export function hasMeaningfulCaption(text: string | undefined | null): boolean {
  const t = (text ?? '').trim();
  if (t.length >= 16) return true;
  return t.split(/\s+/).filter(Boolean).length >= 3;
}

/** Bot API отдаёт ботам файлы только до 20MB — больше getFile бросает «file is too big». */
export const TG_FILE_LIMIT_BYTES = 20 * 1024 * 1024;

export interface MediaFileRef {
  /** Есть ТОЛЬКО если файл реально скачиваем и транскрибируем (≤20MB, не gif) — это L2-гейт STT. */
  tgFileId?: string;
  /** Стабильный id — всегда, когда есть медиа: нужен для дедупа повторных пересылок. */
  tgFileUniqueId?: string;
  /** Метаданные трека «Исполнитель — Название» (ID3-теги msg.audio) — дешёвый сигнал и заголовок. */
  title?: string;
  /** Файл заведомо не скачать (>20MB) — честно предупредим, что сохранили без расшифровки. */
  tooBig?: boolean;
}

/**
 * Ссылка на файл голосового/аудио/видео для сохранения в item. Отсутствие tgFileId кодирует
 * «транскрибировать нечего/нельзя»: у animation (gif) нет аудиодорожки, файл >20MB Bot API не отдаст
 * (его отличаем флагом tooBig — для честного предупреждения). Чистая функция — тестируется без БД.
 */
export function mediaFileRef(msg: Message): MediaFileRef {
  if (msg.animation) return { tgFileUniqueId: msg.animation.file_unique_id };
  const media = msg.voice ?? msg.audio ?? msg.video ?? msg.video_note;
  if (!media) return {};

  const ref: MediaFileRef = { tgFileUniqueId: media.file_unique_id };
  if (msg.audio) {
    const track = [msg.audio.performer, msg.audio.title].filter(Boolean).join(' — ');
    if (track) ref.title = track;
  }
  if (media.file_size != null && media.file_size > TG_FILE_LIMIT_BYTES) {
    ref.tooBig = true; // tgFileId намеренно не отдаём: getFile всё равно бросит
    return ref;
  }
  ref.tgFileId = media.file_id;
  return ref;
}

/** Человекочитаемый источник пересылки из forward_origin. */
function originName(msg: Message): string | undefined {
  const o = msg.forward_origin;
  if (!o) return undefined;
  switch (o.type) {
    case 'channel':
      return o.chat.title;
    case 'chat':
      return o.sender_chat.title;
    case 'user':
      return [o.sender_user.first_name, o.sender_user.last_name].filter(Boolean).join(' ');
    case 'hidden_user':
      return o.sender_user_name;
    default:
      return undefined;
  }
}

/**
 * Определяет тип контента по самому дешёвому сигналу (§3 спеки), без глубокого чтения.
 */
export function detect(msg: Message): Detected {
  const text = msg.text ?? msg.caption ?? '';
  const entities = msg.entities ?? msg.caption_entities;
  const sourceChat = originName(msg);
  const isForwarded = Boolean(msg.forward_origin);

  // Документы и голос — отдельные ветки (их «тело» читается/транскрибируется, а не подпись).
  if (msg.document) return { type: 'document', text, sourceChat };
  if (msg.voice || msg.audio) return { type: 'voice', text, sourceChat };

  // Фото/видео: ПОДПИСЬ ВАЖНЕЕ МЕДИА. Медиа с содержательной подписью — это в первую очередь пост,
  // классифицируем по подписи (§ продуктовый тезис). Голое медиа без подписи — на медиа-полку.
  const isMedia = Boolean(msg.photo || msg.video || msg.video_note || msg.animation);
  if (isMedia) {
    if (hasMeaningfulCaption(text)) {
      return { type: isForwarded ? 'tg_post' : 'text', text, sourceChat };
    }
    if (msg.photo) return { type: 'image', text, sourceChat };
    return { type: 'video', text, sourceChat }; // video / video_note / animation
  }

  const url = extractUrl(text, entities);
  if (url) return { type: 'link', url, text, sourceChat };

  if (isForwarded) return { type: 'tg_post', text, sourceChat };
  return { type: 'text', text, sourceChat };
}
