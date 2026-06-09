import { and, cosineDistance, desc, eq, isNotNull, ne, sql } from 'drizzle-orm';
import { db } from './client.js';
import { items, type Item, type NewItem } from './schema.js';

/** Каналы/авторы (sourceChat) пользователя с числом записей — для просмотра «по каналу» (/folders). */
export async function listChannels(userId: number): Promise<{ sourceChat: string; count: number }[]> {
  const rows = await db
    .select({ sourceChat: items.sourceChat, count: sql<number>`count(*)::int` })
    .from(items)
    .where(and(eq(items.userId, userId), isNotNull(items.sourceChat)))
    .groupBy(items.sourceChat)
    .orderBy(desc(sql`count(*)`), items.sourceChat);
  // sourceChat гарантированно не null из-за isNotNull в where.
  return rows.map((r) => ({ sourceChat: r.sourceChat as string, count: r.count }));
}

/** Страница записей + общее число — для пагинации внутри папки (/folders). Свежие сверху. */
export interface ItemsPage {
  items: Item[];
  total: number;
}

/** Страница записей категории (кластера) — для открытия и листания папки в /folders. */
export async function itemsByClusterPage(
  userId: number,
  clusterId: string,
  limit: number,
  offset: number,
): Promise<ItemsPage> {
  const where = and(eq(items.userId, userId), eq(items.clusterId, clusterId));
  const rows = await db.select().from(items).where(where).orderBy(desc(items.createdAt)).limit(limit).offset(offset);
  const [c] = await db.select({ total: sql<number>`count(*)::int` }).from(items).where(where);
  return { items: rows, total: c?.total ?? 0 };
}

/** Страница записей канала (по sourceChat) — для открытия и листания папки канала в /folders. */
export async function itemsBySourcePage(
  userId: number,
  sourceChat: string,
  limit: number,
  offset: number,
): Promise<ItemsPage> {
  const where = and(eq(items.userId, userId), eq(items.sourceChat, sourceChat));
  const rows = await db.select().from(items).where(where).orderBy(desc(items.createdAt)).limit(limit).offset(offset);
  const [c] = await db.select({ total: sql<number>`count(*)::int` }).from(items).where(where);
  return { items: rows, total: c?.total ?? 0 };
}

export async function insertItem(values: NewItem): Promise<Item> {
  const [row] = await db.insert(items).values(values).returning();
  if (!row) throw new Error('insertItem: пустой результат');
  return row;
}

/** Батч-вставка (заливка избранного). Чанкуем, чтобы не упереться в лимит параметров запроса. */
export async function insertItems(values: NewItem[]): Promise<Item[]> {
  const out: Item[] = [];
  const CHUNK = 500;
  for (let i = 0; i < values.length; i += CHUNK) {
    const rows = await db.insert(items).values(values.slice(i, i + CHUNK)).returning();
    out.push(...rows);
  }
  return out;
}

/** Нормализованный ключ текста для дедупа (общий для batch-дедупа и сверки с БД). */
export function textKey(s: string | null): string {
  return (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Существующие ключи дедупа пользователя — чтобы заливка не плодила дубли. Бакетим по той же
 * приоритетности, что и dedupeDrafts: url → tg_file_unique_id → нормализованный текст. Текст нужен,
 * чтобы повторная пересылка тех же постов-без-ссылки (tg_post/text) не задвоила записи.
 */
export async function existingDedupKeys(
  userId: number,
): Promise<{ urls: Set<string>; fileUids: Set<string>; texts: Set<string> }> {
  const rows = await db
    .select({ url: items.url, fileUid: items.tgFileUniqueId, rawText: items.rawText })
    .from(items)
    .where(eq(items.userId, userId));
  const urls = new Set<string>();
  const fileUids = new Set<string>();
  const texts = new Set<string>();
  for (const r of rows) {
    if (r.url) urls.add(r.url);
    else if (r.fileUid) fileUids.add(r.fileUid);
    else {
      const t = textKey(r.rawText);
      if (t) texts.add(t);
    }
  }
  return { urls, fileUids, texts };
}

export async function getItem(id: string): Promise<Item | undefined> {
  const [row] = await db.select().from(items).where(eq(items.id, id)).limit(1);
  return row;
}

/**
 * Найти item по исходному сообщению Telegram (userId + tgMessageId) — для идемпотентности флаша
 * альбома: при ретрае члены, сохранённые до сбоя, не задваиваются (у каждого члена свой message_id).
 */
export async function findItemByTgMessageId(userId: number, tgMessageId: number): Promise<Item | undefined> {
  const [row] = await db
    .select()
    .from(items)
    .where(and(eq(items.userId, userId), eq(items.tgMessageId, tgMessageId)))
    .limit(1);
  return row;
}

/** Записать эмбеддинг и пометить, что L2-индексация прошла. */
export async function setEmbedding(id: string, embedding: number[]): Promise<void> {
  await db
    .update(items)
    .set({ embedding, indexedAt: sql`now()` })
    .where(eq(items.id, id));
}

/** Сырой OCR-текст — только в индекс (§3.4), пользователю не показываем. */
export async function setOcrText(id: string, ocrText: string): Promise<void> {
  await db.update(items).set({ ocrText }).where(eq(items.id, id));
}

/**
 * Удалить item по запросу пользователя (§ удаление контента) — чтобы бот больше его не учитывал.
 * Проверяем владельца. FK clusterId → onDelete: set null, кластеры не ломаются.
 * Возвращает true, если запись существовала и принадлежала пользователю.
 */
export async function deleteItem(id: string, userId: number): Promise<boolean> {
  const res = await db
    .delete(items)
    .where(and(eq(items.id, id), eq(items.userId, userId)))
    .returning({ id: items.id });
  return res.length > 0;
}

export async function setRawText(id: string, rawText: string): Promise<void> {
  await db.update(items).set({ rawText }).where(eq(items.id, id));
}

export async function setTranscript(id: string, transcript: string): Promise<void> {
  await db.update(items).set({ transcript }).where(eq(items.id, id));
}

/**
 * Самый похожий «старый сосед» в том же кластере — для проактивного резонанса (режим 2, триггер A).
 * Берём только достаточно старые item (createdAt < now() - minAgeDays), сортируем по близости
 * к queryVec (косинус). Паттерн похожести — как в retrieval/search.ts.
 */
export async function findOlderSiblingInCluster(
  userId: number,
  clusterId: string,
  excludeId: string,
  queryVec: number[],
  minAgeDays: number,
  limit = 1,
): Promise<Item[]> {
  const similarity = sql<number>`1 - (${cosineDistance(items.embedding, queryVec)})`;
  return db
    .select()
    .from(items)
    .where(
      and(
        eq(items.userId, userId),
        eq(items.clusterId, clusterId),
        ne(items.id, excludeId),
        isNotNull(items.embedding),
        sql`${items.createdAt} < now() - (${minAgeDays} || ' days')::interval`,
      ),
    )
    .orderBy(desc(similarity))
    .limit(limit);
}
