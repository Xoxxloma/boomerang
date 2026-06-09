import { and, eq, sql } from 'drizzle-orm';
import { db } from './client.js';
import { editPending } from './schema.js';

/**
 * Сессия правки категории в БД (вместо in-memory Map): durable + работает при нескольких инстансах.
 * Ключ — (chatId, messageId) L1-сообщения с кнопками. TTL ~10 минут.
 */
export async function setEditPending(chatId: number, messageId: number, itemId: string): Promise<void> {
  await db
    .insert(editPending)
    .values({ chatId, messageId, itemId })
    .onConflictDoUpdate({
      target: [editPending.chatId, editPending.messageId],
      set: { itemId, createdAt: sql`now()` },
    });
}

export async function getEditPending(chatId: number, messageId: number): Promise<string | undefined> {
  const [row] = await db
    .select()
    .from(editPending)
    .where(
      and(
        eq(editPending.chatId, chatId),
        eq(editPending.messageId, messageId),
        sql`${editPending.createdAt} > now() - interval '10 minutes'`,
      ),
    )
    .limit(1);
  return row?.itemId;
}

export async function delEditPending(chatId: number, messageId: number): Promise<void> {
  await db
    .delete(editPending)
    .where(and(eq(editPending.chatId, chatId), eq(editPending.messageId, messageId)));
}
