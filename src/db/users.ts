import { sql } from 'drizzle-orm';
import { db } from './client.js';
import { users } from './schema.js';

/** Идемпотентно создаёт пользователя по tg id (ничего не делает, если уже есть). */
export async function ensureUser(tgId: number): Promise<void> {
  await db
    .insert(users)
    .values({ id: tgId })
    .onConflictDoNothing({ target: users.id });
}

/** Помечает, что массовый импорт выполнен (для будущей вехи импорта Saved Messages). */
export async function markImportDone(tgId: number): Promise<void> {
  await db.update(users).set({ importDone: true }).where(sql`${users.id} = ${tgId}`);
}

/** Режим проактивного всплытия (режим 2): 'on'/'off' либо undefined — пользователя ещё не спрашивали. */
export type ProactiveMode = 'on' | 'off';

export async function getProactiveMode(tgId: number): Promise<ProactiveMode | undefined> {
  const [row] = await db
    .select({ settings: users.settings })
    .from(users)
    .where(sql`${users.id} = ${tgId}`)
    .limit(1);
  const v = row?.settings?.proactive;
  return v === 'on' || v === 'off' ? v : undefined;
}

/** Мержим один ключ в settings (jsonb), не затирая остальные. */
export async function setProactiveMode(tgId: number, mode: ProactiveMode): Promise<void> {
  await db
    .update(users)
    .set({ settings: sql`${users.settings} || ${JSON.stringify({ proactive: mode })}::jsonb` })
    .where(sql`${users.id} = ${tgId}`);
}
