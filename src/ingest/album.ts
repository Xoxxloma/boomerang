import { eq } from 'drizzle-orm';
import type { Api } from 'grammy';
import type { Message } from 'grammy/types';
import { db } from '../db/client.js';
import { albumPart, albumSession } from '../db/schema.js';
import { enqueueAlbumFlush } from '../queue/index.js';
import { flushAlbumMessages } from './save.js';

/**
 * Приём части альбома: пишем сообщение в БД, первая часть шлёт «Принял ✅» и сохраняет ack-мету,
 * каждая часть продлевает debounce-флаш (pg-boss). Состояние в БД → переживает рестарт и работает
 * при нескольких инстансах.
 */
export async function bufferAlbumPart(api: Api, msg: Message): Promise<void> {
  const gid = msg.media_group_id;
  if (!gid) return;

  // Клеймим «первую часть» атомарно: вставка сессии с ON CONFLICT DO NOTHING.
  const claimed = await db
    .insert(albumSession)
    .values({ mediaGroupId: gid })
    .onConflictDoNothing()
    .returning({ id: albumSession.mediaGroupId });

  await db.insert(albumPart).values({ mediaGroupId: gid, message: msg });

  if (claimed.length > 0) {
    const ack = await api.sendMessage(msg.chat.id, 'Принял ✅', {
      reply_parameters: { message_id: msg.message_id },
    });
    await db
      .update(albumSession)
      .set({ ackChatId: ack.chat.id, ackMessageId: ack.message_id })
      .where(eq(albumSession.mediaGroupId, gid));
  }

  await enqueueAlbumFlush(gid); // debounce: продлеваем окно на каждую часть
}

/**
 * Флаш альбома (вызывается воркером pg-boss). Атомарно забирает части (DELETE … RETURNING) — флашит
 * только один инстанс; читает ack-мету, прогоняет логику склейки, чистит сессию.
 */
export async function flushAlbum(api: Api, gid: string): Promise<void> {
  // ЧИТАЕМ части (не удаляем): удаление — только после успешной склейки, иначе сбой saveItem
  // (сеть/БД) потерял бы альбом. Тут части целы → pg-boss повторит, ничего не пропадает.
  const parts = await db.select().from(albumPart).where(eq(albumPart.mediaGroupId, gid));
  if (parts.length === 0) return; // уже флашнул другой воркер

  const [session] = await db
    .select()
    .from(albumSession)
    .where(eq(albumSession.mediaGroupId, gid))
    .limit(1);

  if (!session?.ackChatId || !session.ackMessageId) {
    // Нет ack-меты (битая/чужая сессия) — обрабатывать нечем, подчищаем и выходим.
    await db.delete(albumPart).where(eq(albumPart.mediaGroupId, gid));
    await db.delete(albumSession).where(eq(albumSession.mediaGroupId, gid));
    return;
  }

  const messages = parts
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((p) => p.message as Message);

  await flushAlbumMessages(api, messages, session.ackChatId, session.ackMessageId);

  // Успех → теперь безопасно удалить части и сессию.
  await db.delete(albumPart).where(eq(albumPart.mediaGroupId, gid));
  await db.delete(albumSession).where(eq(albumSession.mediaGroupId, gid));
}
