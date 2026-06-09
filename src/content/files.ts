import { writeFile, rm } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import type { Api } from 'grammy';
import { env } from '../config/env.js';

/**
 * Скачивает файл Telegram во ВРЕМЕННЫЙ файл, отдаёт его в fn и гарантированно удаляет после.
 * Файлы на диске постоянно не храним (хранение ≠ ценность): байты нужны только транзиентно —
 * для OCR картинок и чтения документов (L2), потом удаляются. Повторно качаем по tg_file_id.
 */
export async function withTempFile<T>(api: Api, fileId: string, fn: (path: string) => Promise<T>): Promise<T> {
  const file = await api.getFile(fileId);
  if (!file.file_path) throw new Error('getFile вернул пустой file_path');

  const url = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Скачивание файла не удалось: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

  const ext = extname(file.file_path) || '';
  // file_unique_id стабилен и безопасен как имя; ext важен для readDocument (выбор парсера по .pdf/.docx).
  const dest = join(tmpdir(), `boomerang-${file.file_unique_id}${ext}`);
  await writeFile(dest, buf);
  try {
    return await fn(dest);
  } finally {
    await rm(dest, { force: true }).catch(() => {});
  }
}
