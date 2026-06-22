import type { Item } from '../db/schema.js';

/**
 * Версия записи для отдачи в Mini App. Сознательно НЕ включает: embedding (вектор),
 * ocrText / transcript / description — это «сырьё только в индекс» (правило проекта §3): пользователю
 * показываем заголовок и СВОЙ текст (rawText — подпись/тело поста/мысль), а не машинную аннотацию.
 */
export interface ItemDTO {
  id: string;
  type: Item['type'];
  /** Готовое имя для строки списка (title → начало текста → url). */
  name: string;
  title: string | null;
  url: string | null;
  sourceChat: string | null;
  /** Свой текст пользователя (подпись/пост/мысль) — для разворота карточки; усечён. НЕ ocr/транскрипт. */
  text: string | null;
  createdAt: string;
}

/** Потолок текста в карточке: тело документа (до 40k) раздуло бы ответ; для разворота хватает начала. */
const TEXT_CAP = 1200;

/** Имя для строки списка (как itemDisplayName в db/items, но без DB-импорта — сериализатор чистый). */
function displayName(it: Item): string {
  return it.title?.trim() || it.rawText?.trim().slice(0, 60) || it.url || 'запись';
}

export function toItemDTO(it: Item): ItemDTO {
  const text = it.rawText?.trim() ? it.rawText.trim().slice(0, TEXT_CAP) : null;
  return {
    id: it.id,
    type: it.type,
    name: displayName(it),
    title: it.title?.trim() || null,
    url: it.url || null,
    sourceChat: it.sourceChat || null,
    text,
    createdAt: it.createdAt.toISOString(),
  };
}
