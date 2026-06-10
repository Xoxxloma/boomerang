import type { Message } from 'grammy/types';
import { detect, hasMeaningfulCaption } from '../ingest/detect.js';
import type { ItemType } from '../ingest/detect.js';

/**
 * Черновик записи для батч-заливки: только ДЕШЁВЫЙ сигнал, уже доступный в сообщении/экспорте.
 * НЕ тянем OG-мету, не качаем файлы, не делаем OCR — это против скорости и стоимости на масштабе.
 */
export interface Draft {
  type: ItemType;
  tgMessageId: number | null;
  sourceChat: string | null;
  rawText: string | null;
  url: string | null;
  title: string | null;
  tgFileId: string | null;
  tgFileUniqueId: string | null;
  /** media_group_id альбома (общий у членов); null у одиночек/экспорта. Для дропа осколков (см. batch). */
  mediaGroupId: string | null;
}

/** Черновик из пересланного сообщения (всплеск). Зеркало saveItem, но без OG-фетча и скачивания. */
function draftFromMessage(msg: Message): Draft {
  const det = detect(msg);
  let title: string | null = null;
  let tgFileId: string | null = null;
  let tgFileUniqueId: string | null = null;

  if (det.type === 'image') {
    const photo = msg.photo?.[msg.photo.length - 1];
    tgFileId = photo?.file_id ?? null;
    tgFileUniqueId = photo?.file_unique_id ?? null;
  } else if (det.type === 'document' && msg.document) {
    tgFileId = msg.document.file_id;
    tgFileUniqueId = msg.document.file_unique_id;
    title = msg.document.file_name ?? null; // имя файла — дешёвый сигнал
  }

  return {
    type: det.type,
    tgMessageId: msg.message_id,
    sourceChat: det.sourceChat ?? null,
    rawText: det.text || null,
    url: det.url ?? null,
    title,
    tgFileId,
    tgFileUniqueId,
    mediaGroupId: msg.media_group_id ?? null,
  };
}

/**
 * Черновики из пачки пересланных сообщений со СКЛЕЙКОЙ альбомов (media_group): пост с подписью и
 * прикреплёнными картинками → ОДНА запись-пост (как в обычном альбомном пути flushAlbumMessages), а не
 * пост + отдельные фото. Альбом без содержательной подписи → каждый член отдельной картинкой (на полку).
 * Одиночные сообщения — как есть. Порядок прихода сохраняется (группа эмитится на месте первого члена).
 */
export function draftsFromMessages(messages: Message[]): Draft[] {
  const byGroup = new Map<string, Message[]>();
  for (const m of messages) {
    if (!m.media_group_id) continue;
    const arr = byGroup.get(m.media_group_id) ?? [];
    arr.push(m);
    byGroup.set(m.media_group_id, arr);
  }

  const emitted = new Set<string>();
  const out: Draft[] = [];
  for (const m of messages) {
    const gid = m.media_group_id;
    if (!gid) {
      out.push(draftFromMessage(m));
      continue;
    }
    if (emitted.has(gid)) continue; // члены этой группы уже обработаны на первом
    emitted.add(gid);
    const group = byGroup.get(gid)!;
    const captionMsg = group.find((g) => hasMeaningfulCaption(g.caption));
    if (captionMsg) out.push(draftFromMessage(captionMsg)); // подпись → один пост, остальные фото опускаем
    else for (const g of group) out.push(draftFromMessage(g)); // без подписи → картинки на полку
  }
  return out;
}

/** Один пробег/сущность текста в Telegram-экспорте: строка или объект с типом/href. */
interface ExportRun {
  type?: string;
  text?: string;
  href?: string;
}

/** Сообщение из result.json экспорта Telegram (берём только нужные поля). */
export interface ExportMessage {
  type?: string; // 'message' | 'service'
  text?: string | (string | ExportRun)[];
  text_entities?: ExportRun[];
  forwarded_from?: string;
  media_type?: string; // 'photo' нет; есть 'video_file','voice_message','sticker', и т.п.
  mime_type?: string;
  file?: string;
  photo?: string;
  file_name?: string;
}

function plainText(m: ExportMessage): string {
  if (typeof m.text === 'string') return m.text;
  if (Array.isArray(m.text)) {
    return m.text.map((r) => (typeof r === 'string' ? r : (r.text ?? ''))).join('');
  }
  return '';
}

function extractUrl(m: ExportMessage): string | undefined {
  const ents = m.text_entities ?? [];
  for (const e of ents) {
    if (e.type === 'text_link' && e.href) return e.href;
    if (e.type === 'link' && e.text) return e.text;
  }
  if (Array.isArray(m.text)) {
    for (const r of m.text) {
      if (typeof r === 'object' && r.href) return r.href;
    }
  }
  return undefined;
}

/**
 * Черновик из сообщения экспорта. У экспорта НЕТ telegram file_id (только локальные пути) → файлы
 * недоступны для скачивания, индексируем по подписи/имени файла. tgMessageId = null (другой чат).
 */
export function draftFromExport(m: ExportMessage): Draft | null {
  if (m.type && m.type !== 'message') return null; // service-сообщения пропускаем

  const text = plainText(m).trim();
  const url = extractUrl(m);
  const sourceChat = typeof m.forwarded_from === 'string' ? m.forwarded_from : null;
  const isForwarded = Boolean(sourceChat);

  let type: ItemType;
  let title: string | null = null;

  const isDocument = m.media_type === 'document' || (Boolean(m.file) && !m.photo);
  const isVoice = m.media_type === 'voice_message' || m.media_type === 'audio_file';
  const isVideo =
    m.media_type === 'video_file' || m.media_type === 'video_message' || m.media_type === 'animation';

  if (isDocument) {
    type = 'document';
    title = m.file_name ?? null;
  } else if (isVoice) {
    type = 'voice';
  } else if (m.photo || isVideo) {
    if (hasMeaningfulCaption(text)) type = isForwarded ? 'tg_post' : 'text';
    else type = m.photo ? 'image' : 'video';
  } else if (url) {
    type = 'link';
  } else if (isForwarded) {
    type = 'tg_post';
  } else {
    type = 'text';
  }

  return {
    type,
    tgMessageId: null,
    sourceChat,
    rawText: text || null,
    url: url ?? null,
    title,
    tgFileId: null, // экспорт не даёт telegram file_id
    tgFileUniqueId: null,
    mediaGroupId: null, // экспорт идёт уже разнесённым по сообщениям, media_group не реконструируем
  };
}

/**
 * Похоже ли это на экспорт чата Telegram (а не на произвольный JSON)? У экспорта на верхнем уровне
 * всегда есть строковый `type` ("saved_messages" / "personal_chat" / …) и массив `messages`.
 */
export function looksLikeExport(json: unknown): boolean {
  if (typeof json !== 'object' || json === null) return false;
  const j = json as Record<string, unknown>;
  return typeof j.type === 'string' && Array.isArray(j.messages);
}

/** Разобрать весь экспорт `{ messages: [...] }` в черновики. */
export function parseExport(json: unknown): Draft[] {
  const messages = (json as { messages?: unknown })?.messages;
  if (!Array.isArray(messages)) return [];
  const out: Draft[] = [];
  for (const m of messages) {
    const d = draftFromExport(m as ExportMessage);
    if (d) out.push(d);
  }
  return out;
}
