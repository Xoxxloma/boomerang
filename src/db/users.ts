import { sql } from 'drizzle-orm';
import { db } from './client.js';
import { users } from './schema.js';
import { grantTrial } from '../billing/entitlement.js';

/**
 * Идемпотентно создаёт пользователя по tg id (ничего не делает, если уже есть) и выдаёт приветственный
 * триал Pro. grantTrial сам идемпотентен (ON CONFLICT DO NOTHING) — существующим юзерам не выдаётся
 * повторно, поэтому безопасно звать на каждом ensureUser.
 */
export async function ensureUser(tgId: number): Promise<void> {
  await db
    .insert(users)
    .values({ id: tgId })
    .onConflictDoNothing({ target: users.id });
  await grantTrial(tgId);
}

/** Помечает, что массовый импорт выполнен (для будущей вехи импорта Saved Messages). */
export async function markImportDone(tgId: number): Promise<void> {
  await db.update(users).set({ importDone: true }).where(sql`${users.id} = ${tgId}`);
}
