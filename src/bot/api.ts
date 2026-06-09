import type { Api } from 'grammy';

/**
 * Ссылка на Telegram API бота для фоновых воркеров (флаш альбома редактирует ack-сообщение и
 * скачивает файлы). Выставляется один раз при старте процесса в src/index.ts.
 */
let api: Api | null = null;

export function setBotApi(a: Api): void {
  api = a;
}

export function getBotApi(): Api {
  if (!api) throw new Error('Bot API не инициализирован (setBotApi не вызван)');
  return api;
}
