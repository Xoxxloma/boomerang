import { and, asc, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { db } from './client.js';
import { items, users, remindPending, type Item } from './schema.js';
import { tuning } from '../config/tuning.js';

/**
 * БД-слой пользовательских напоминаний («верни мне это в момент T»). Напоминание — это флаг на самом
 * item (remind_at + remind_status), а не отдельная сущность: «что вернуть» = строка item. Источник
 * истины для cron-sweep — колонка remind_at; никаких таймеров в памяти.
 */

/** Поставить/перенести напоминание на item (с проверкой владельца). Возвращает true, если обновили. */
export async function setReminder(itemId: string, userId: number, remindAt: Date): Promise<boolean> {
  const res = await db
    .update(items)
    .set({ remindAt, remindStatus: 'pending', remindCreatedAt: sql`now()` })
    .where(and(eq(items.id, itemId), eq(items.userId, userId)))
    .returning({ id: items.id });
  return res.length > 0;
}

/** Снять напоминание (remind_at оставляем для истории/«верни сейчас»). Проверка владельца. */
export async function clearReminder(itemId: string, userId: number): Promise<boolean> {
  const res = await db
    .update(items)
    .set({ remindStatus: 'cancelled' })
    .where(and(eq(items.id, itemId), eq(items.userId, userId)))
    .returning({ id: items.id });
  return res.length > 0;
}

/** Пользователь нажал «Готово» на возврате — закрываем напоминание (item остаётся в архиве). */
export async function markReminderDone(itemId: string, userId: number): Promise<boolean> {
  const res = await db
    .update(items)
    .set({ remindStatus: 'done' })
    .where(and(eq(items.id, itemId), eq(items.userId, userId)))
    .returning({ id: items.id });
  return res.length > 0;
}

/**
 * Забрать созревшие напоминания (remind_at <= now, status pending) и пометить их 'sent'.
 * Два шага: выбираем id (с лимитом-пачкой) → UPDATE только тех, что ВСЁ ЕЩЁ pending (guard в where).
 * Гонка двух тиков безопасна: первый флипнет в 'sent' и вернёт строки, второй обновит 0 (уже не pending) —
 * один item доставится один раз. Возвращает полные строки item (в них всё для доставки).
 */
export async function claimDueReminders(now: Date, limit: number): Promise<Item[]> {
  const due = await db
    .select({ id: items.id })
    .from(items)
    .where(and(eq(items.remindStatus, 'pending'), lte(items.remindAt, now)))
    .orderBy(asc(items.remindAt))
    .limit(limit);
  const ids = due.map((r) => r.id);
  if (ids.length === 0) return [];
  return db
    .update(items)
    .set({ remindStatus: 'sent' })
    .where(and(inArray(items.id, ids), eq(items.remindStatus, 'pending')))
    .returning();
}

/**
 * Перенести напоминание на новое время и вернуть в очередь (status → pending). Без проверки владельца —
 * внутренний вызов из доставки (тихие часы) и «Отложить»; владелец уже подтверждён выше по стеку/коллбэку.
 */
export async function deferReminder(itemId: string, remindAt: Date): Promise<void> {
  await db
    .update(items)
    .set({ remindAt, remindStatus: 'pending' })
    .where(eq(items.id, itemId));
}

/** Ближайшие активные напоминания пользователя — для экрана «Скоро вернётся» в Mini App. */
export async function listUpcoming(userId: number, limit: number): Promise<Item[]> {
  return db
    .select()
    .from(items)
    .where(and(eq(items.userId, userId), eq(items.remindStatus, 'pending'), isNotNull(items.remindAt)))
    .orderBy(asc(items.remindAt))
    .limit(limit);
}

/** Настройки напоминаний пользователя: таймзона, дефолтный час, тихие часы. Все поля со здравыми дефолтами. */
export interface ReminderSettings {
  tz: string;
  defaultHour: number;
  quietStartHour: number;
  quietEndHour: number;
}

/** Партиал из users.settings.reminder (jsonb) — что реально хранится; остальное добивается дефолтами. */
type StoredReminderSettings = Partial<ReminderSettings>;

/** Прочитать настройки напоминаний из users.settings.reminder, добив пробелы дефолтами из tuning. */
export async function getReminderSettings(userId: number): Promise<ReminderSettings> {
  const [row] = await db
    .select({ reminder: sql<StoredReminderSettings | null>`${users.settings} -> 'reminder'` })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const stored = row?.reminder ?? {};
  return {
    tz: stored.tz ?? tuning.remindDefaultTz,
    defaultHour: stored.defaultHour ?? tuning.remindDefaultHour,
    quietStartHour: stored.quietStartHour ?? tuning.remindQuietStartHour,
    quietEndHour: stored.quietEndHour ?? tuning.remindQuietEndHour,
  };
}

/**
 * Слить частичные настройки напоминаний в users.settings.reminder, не затирая остальные ключи.
 * settings || {reminder: (старый reminder) || partial} — внешний `||` заменил бы весь reminder,
 * поэтому собираем reminder как merge старого и нового (паттерн setProactiveMode, но на под-объекте).
 */
export async function setReminderSettings(userId: number, partial: StoredReminderSettings): Promise<void> {
  await db
    .update(users)
    .set({
      settings: sql`${users.settings} || jsonb_build_object(
        'reminder',
        coalesce(${users.settings} -> 'reminder', '{}'::jsonb) || ${JSON.stringify(partial)}::jsonb
      )`,
    })
    .where(eq(users.id, userId));
}

// --- remind_pending: ввод «Своё время» через force_reply (зеркало edit_pending в sessions.ts). ---

/** Запомнить, к какому item относится force_reply-приглашение «Когда вернуть?». Ключ — сообщение бота. */
export async function setRemindPending(chatId: number, messageId: number, itemId: string): Promise<void> {
  await db
    .insert(remindPending)
    .values({ chatId, messageId, itemId })
    .onConflictDoUpdate({
      target: [remindPending.chatId, remindPending.messageId],
      set: { itemId, createdAt: sql`now()` },
    });
}

/** Достать itemId по ответу на приглашение (TTL 10 минут, как у edit_pending). */
export async function getRemindPending(chatId: number, messageId: number): Promise<string | undefined> {
  const [row] = await db
    .select()
    .from(remindPending)
    .where(
      and(
        eq(remindPending.chatId, chatId),
        eq(remindPending.messageId, messageId),
        sql`${remindPending.createdAt} > now() - interval '10 minutes'`,
      ),
    )
    .limit(1);
  return row?.itemId;
}

export async function delRemindPending(chatId: number, messageId: number): Promise<void> {
  await db
    .delete(remindPending)
    .where(and(eq(remindPending.chatId, chatId), eq(remindPending.messageId, messageId)));
}
