import { readFile } from 'node:fs/promises';
import type { Api } from 'grammy';
import type { Message } from 'grammy/types';
import { withTempFile } from '../content/files.js';
import { markImportDone } from '../db/users.js';
import { batchIngest } from './batch.js';
import { parseExport, looksLikeExport } from './draft.js';
import { makeProgress, finalText } from './progress.js';

/** Лимит Bot API getFile — 20 МБ. Большой экспорт целиком скачать нельзя. */
const MAX_EXPORT_BYTES = 20 * 1024 * 1024;

/** Это файл экспорта Telegram (result.json)? Детект по mime/имени, без скачивания. */
export function isExportDocument(msg: Message): boolean {
  const doc = msg.document;
  if (!doc) return false;
  const name = (doc.file_name ?? '').toLowerCase();
  return doc.mime_type === 'application/json' || name.endsWith('.json');
}

/**
 * Залив JSON-экспорта Saved Messages: проверка размера → скачивание → проверка формы → батч-конвейер.
 * Возвращает true, если ФАЙЛ ОБРАБОТАН КАК ЭКСПОРТ (или явно отклонён по размеру). false — это не
 * экспорт Telegram (произвольный .json) → вызывающий сохранит файл обычным путём, как документ.
 * Молчим, пока не убедились, что это экспорт: на чужой .json лишних реплик не шлём.
 * Тяжёлый медиа-контент экспорт не вшивает (только пути) — индексируем по тексту.
 */
export async function handleExport(api: Api, msg: Message): Promise<boolean> {
  const doc = msg.document;
  const userId = msg.from?.id;
  if (!doc || !userId) return false;

  if ((doc.file_size ?? 0) > MAX_EXPORT_BYTES) {
    // Скачать и проверить форму нельзя (>20 МБ). JSON такого размера почти наверняка — экспорт чата;
    // предупреждаем про лимит (как экспорт), сохранять как «документ» смысла нет — getFile всё равно не отдаст.
    await api
      .sendMessage(
        msg.chat.id,
        'Похоже на экспорт, но файл больше 20 МБ — Telegram не даёт скачать его боту целиком. ' +
          'Переэкспортируй Избранное без медиа (только сообщения) или по диапазонам дат и пришли снова.',
      )
      .catch(() => {});
    return true;
  }

  let json: unknown;
  try {
    json = await withTempFile(api, doc.file_id, async (path) => {
      const raw = await readFile(path, 'utf8');
      return JSON.parse(raw) as unknown;
    });
  } catch {
    return false; // не распарсился как JSON → не экспорт, отдаём в обычный приём
  }

  if (!looksLikeExport(json)) return false; // валидный JSON, но не экспорт Telegram → обычный приём

  // С этого момента уверены, что это экспорт — можно слать прогресс. reply_parameters: это сообщение
  // потом редактируется (прогресс/итог), а трансформер reply-клавиатуры пропускает прямые ответы на
  // контент пользователя — без него сообщение осталось бы нередактируемым («message can't be edited»).
  const progress = await api
    .sendMessage(msg.chat.id, 'Разбираю экспорт…', { reply_parameters: { message_id: msg.message_id } })
    .catch(() => null);
  const msgId = progress?.message_id ?? null;
  const pChatId = progress?.chat.id ?? null;

  const drafts = parseExport(json);
  if (drafts.length === 0) {
    if (pChatId && msgId) {
      await api.editMessageText(pChatId, msgId, 'В экспорте не нашлось сообщений для разбора.').catch(() => {});
    }
    return true;
  }

  const onProgress = makeProgress(api, pChatId, msgId);
  const res = await batchIngest(userId, drafts, onProgress);
  if (pChatId && msgId) {
    await api.editMessageText(pChatId, msgId, finalText(res)).catch(() => {});
  }
  await markImportDone(userId);
  return true;
}
