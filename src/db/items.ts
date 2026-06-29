import { and, cosineDistance, desc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { db } from './client.js';
import { items, type Item, type NewItem } from './schema.js';
import { tuning } from '../config/tuning.js';

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

/** Сколько записей юзер загрузил сам (без источника, sourceChat IS NULL) — псевдо-папка в /folders. */
export async function countSelfUploaded(userId: number): Promise<number> {
  const [c] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(items)
    .where(and(eq(items.userId, userId), isNull(items.sourceChat)));
  return c?.total ?? 0;
}

/** Страница записей + общее число — для пагинации внутри папки (/folders). Свежие сверху. */
export interface ItemsPage {
  items: Item[];
  total: number;
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

/** Страница «Загружено вручную» (sourceChat IS NULL) — псевдо-папка в /folders. Свежие сверху. */
export async function itemsBySelfUploadPage(
  userId: number,
  limit: number,
  offset: number,
): Promise<ItemsPage> {
  const where = and(eq(items.userId, userId), isNull(items.sourceChat));
  const rows = await db.select().from(items).where(where).orderBy(desc(items.createdAt)).limit(limit).offset(offset);
  const [c] = await db.select({ total: sql<number>`count(*)::int` }).from(items).where(where);
  return { items: rows, total: c?.total ?? 0 };
}

/** Всего записей юзера — для гейта ёмкости free-тарифа (billing/capacity). Дёшево (индекс items_user_idx). */
export async function countUserItems(userId: number): Promise<number> {
  const [c] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(items)
    .where(eq(items.userId, userId));
  return c?.total ?? 0;
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

/**
 * Из переданных media_group_id вернуть те, что уже стали ПОСТОМ (есть не-image запись с этим gid).
 * Альбом с подписью → член-с-подписью сохранён как tg_post/text → gid «занят постом». Альбом без подписи
 * даёт лишь image-записи → сюда не попадёт (его члены законно лежат на полке). Нужно, чтобы опоздавший
 * член-осколок уже-постнутого альбома дропался, а не уезжал отдельной картинкой (см. batch B4 / save B5).
 */
export async function groupsAlreadyPosted(userId: number, gids: string[]): Promise<Set<string>> {
  if (gids.length === 0) return new Set();
  const rows = await db
    .selectDistinct({ gid: items.mediaGroupId })
    .from(items)
    .where(
      and(eq(items.userId, userId), inArray(items.mediaGroupId, gids), ne(items.type, 'image')),
    );
  return new Set(rows.map((r) => r.gid).filter((g): g is string => g != null));
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
 * Найти уже сохранённую запись-дубль для одиночной пересылки — чтобы не задваивать (§ тезис: дубли
 * засоряют возврат). Точечный запрос (не грузим все ключи как existingDedupKeys). Приоритет тот же,
 * что в дедупе балка: url → tg_file_unique_id → нормализованный текст. Берём самую раннюю
 * (createdAt asc), чтобы «↑ Источник» вёл к первому сохранению. Нормализация текста в SQL должна
 * совпадать с textKey (lower + схлопывание пробелов + trim).
 */
export async function findDuplicateItem(
  userId: number,
  key: { url?: string | null; fileUid?: string | null; text?: string | null },
): Promise<Item | undefined> {
  let where;
  if (key.url) {
    where = and(eq(items.userId, userId), eq(items.url, key.url));
  } else if (key.fileUid) {
    where = and(eq(items.userId, userId), eq(items.tgFileUniqueId, key.fileUid));
  } else {
    const t = textKey(key.text ?? null);
    if (!t) return undefined;
    // POSIX-класс, а не '\s': в JS-шаблоне '\s' схлопывается до 's' (Postgres ловил бы буквы «s», не пробелы).
    const norm = sql`btrim(regexp_replace(lower(coalesce(${items.rawText}, '')), '[[:space:]]+', ' ', 'g'))`;
    where = and(eq(items.userId, userId), sql`${norm} = ${t}`);
  }
  const [row] = await db.select().from(items).where(where).orderBy(items.createdAt).limit(1);
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

/**
 * Пометить L2 завершённым БЕЗ эмбеддинга — для записей без индексируемого текста (фото без OCR-текста,
 * видео без подписи): они обработаны, просто индексировать нечего. Иначе `indexed_at IS NULL` навсегда
 * путало бы их с реальным сбоем. Ставим только если ещё не проставлено (идемпотентно).
 */
export async function markIndexed(id: string): Promise<void> {
  await db
    .update(items)
    .set({ indexedAt: sql`now()` })
    .where(and(eq(items.id, id), isNull(items.indexedAt)));
}

/** Короткое имя записи для сообщений (заголовок → начало текста → url). */
export function itemDisplayName(item: Item): string {
  const name = item.title?.trim() || item.rawText?.trim().slice(0, 60) || item.url || 'запись';
  return name;
}

/** Сырой OCR-текст — только в индекс (§3.4), пользователю не показываем. */
export async function setOcrText(id: string, ocrText: string): Promise<void> {
  await db.update(items).set({ ocrText }).where(eq(items.id, id));
}

/**
 * Дочитанное тело статьи — только в индекс (как ocrText/transcript). status фиксирует исход:
 * 'ok' (прочитано) / 'unreadable' (заглушка/SPA/skip-домен) — кэш отказа + идемпотентность ретрая L2
 * (ветка дочитывания гейтится `bodyStatus == null`). body=null при 'unreadable'.
 */
export async function setBodyText(
  id: string,
  bodyText: string | null,
  status: 'ok' | 'unreadable',
): Promise<void> {
  await db.update(items).set({ bodyText, bodyStatus: status }).where(eq(items.id, id));
}

/**
 * Удалить item по запросу пользователя (§ удаление контента) — чтобы бот больше его не учитывал.
 * Проверяем владельца. Возвращает true, если запись существовала и принадлежала пользователю.
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
 * Машинная аннотация записи — только в индекс, пользователю не показываем (как OCR/транскрипт).
 * Поле description едино по семантике: OG-мета у ссылок (save), vision-описание у картинок (L2).
 */
export async function setDescription(id: string, description: string): Promise<void> {
  await db.update(items).set({ description }).where(eq(items.id, id));
}

/** Заголовок записи (LLM-резюме транскрипта голосового/видео) — видим в выдаче/карточке. */
export async function setTitle(id: string, title: string): Promise<void> {
  await db.update(items).set({ title }).where(eq(items.id, id));
}

/**
 * Записи-«годовщины» для Эха (Mini App): созданные в ТОТ ЖЕ календарный день (месяц+день), что сегодня,
 * но достаточно давно (createdAt < now() - minAgeDays) — «в этот день ты сохранял…». Свежие годовщины
 * сверху. Молодой продукт может вернуть пусто — это честно (нет годовщин — нет секции).
 */
export async function listAnniversaryItems(
  userId: number,
  minAgeDays: number,
  limit: number,
): Promise<Item[]> {
  return db
    .select()
    .from(items)
    .where(
      and(
        eq(items.userId, userId),
        sql`extract(month from ${items.createdAt}) = extract(month from now())`,
        sql`extract(day from ${items.createdAt}) = extract(day from now())`,
        sql`${items.createdAt} < now() - (${minAgeDays} || ' days')::interval`,
      ),
    )
    .orderBy(desc(items.createdAt))
    .limit(limit);
}

/**
 * Недавно проиндексированные записи (есть embedding) — отправные точки pull-резонанса в Эхе: для каждой
 * ищем старого семантического соседа (findOlderSibling). Свежие сверху.
 */
export async function listRecentIndexedItems(
  userId: number,
  days: number,
  limit: number,
): Promise<Item[]> {
  return db
    .select()
    .from(items)
    .where(
      and(
        eq(items.userId, userId),
        isNotNull(items.embedding),
        sql`${items.createdAt} > now() - (${days} || ' days')::interval`,
      ),
    )
    .orderBy(desc(items.createdAt))
    .limit(limit);
}

/** Узел «Созвездия» — сама запись (звезда). Полный Item: фронту нужны title/type/source. */
export async function listIndexedItems(userId: number, limit: number): Promise<Item[]> {
  return db
    .select()
    .from(items)
    .where(and(eq(items.userId, userId), isNotNull(items.embedding)))
    .orderBy(desc(items.createdAt))
    .limit(limit);
}

/** Направленная связь между записями: a → b с косинус-близостью sim. */
export interface ItemNeighbor {
  aId: string;
  bId: string;
  sim: number;
}

/**
 * Рёбра «Созвездия» — семантические связи между записями (узлы=записи, не кластеры). Для каждой
 * проиндексированной записи берём top-K ближайших соседей (hnsw-индекс items_embedding_idx), оставляем
 * прошедших порог bridgeMinItemSim. Темы видны как визуальные сгущения (force-граф стягивает близкие),
 * без имён-категорий. Дедуп в неориентированные рёбра + прорежение по узлу — на стороне route (web-api/map).
 */
export async function listItemNeighbors(userId: number): Promise<ItemNeighbor[]> {
  const knn = tuning.bridgeKnn;
  const minSim = tuning.bridgeMinItemSim;
  // Raw SQL: оператор '<=>' (cosine distance) между ДВУМЯ vector-колонками + LATERAL — drizzle-builder не выражает.
  const rows = (await db.execute(sql`
    SELECT a.id AS a_id, n.id AS b_id, 1 - (a.embedding <=> n.embedding) AS sim
    FROM items a
    CROSS JOIN LATERAL (
      SELECT i.id, i.embedding
      FROM items i
      WHERE i.user_id = ${userId}
        AND i.embedding IS NOT NULL
        AND i.id <> a.id
      ORDER BY i.embedding <=> a.embedding
      LIMIT ${knn}
    ) n
    WHERE a.user_id = ${userId}
      AND a.embedding IS NOT NULL
      AND (1 - (a.embedding <=> n.embedding)) >= ${minSim}
  `)) as unknown as Array<{ a_id: string; b_id: string; sim: number }>;
  return rows.map((r) => ({ aId: r.a_id, bId: r.b_id, sim: Number(r.sim) }));
}

/**
 * Самый похожий «старый сосед» по смыслу — для pull-резонанса Эха (режим 2). Берём только достаточно
 * старые item (createdAt < now() - minAgeDays), сортируем по близости к queryVec (косинус). Без привязки
 * к кластеру (их больше нет) — резонанс это чистая семантическая перекличка.
 */
export async function findOlderSibling(
  userId: number,
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
        ne(items.id, excludeId),
        isNotNull(items.embedding),
        // Порог переклички: без кластера-скоупа нужен явный минимум, иначе вернётся ближайший старый
        // даже при нулевой связи (шум). Тот же порог, что у рёбер «Созвездия» — единая «реальная нить».
        sql`1 - (${cosineDistance(items.embedding, queryVec)}) >= ${tuning.bridgeMinItemSim}`,
        sql`${items.createdAt} < now() - (${minAgeDays} || ' days')::interval`,
      ),
    )
    .orderBy(desc(similarity))
    .limit(limit);
}

/**
 * «Похожие записи» для карточки (бот + Mini App): ближайшие по смыслу соседи данной записи — та же
 * item-kNN нить, что в Карте/резонансе, но БЕЗ возрастного фильтра (findOlderSibling) и от вектора
 * самой записи. Ассоциативная навигация по архиву: одна запись тянет забытые соседние. Порог
 * bridgeMinItemSim — реальная связь, а не случайный сосед. У записи без вектора соседей нет → [].
 */
export async function listSimilarItems(userId: number, item: Item, limit: number): Promise<Item[]> {
  if (!item.embedding) return [];
  const queryVec = item.embedding;
  const similarity = sql<number>`1 - (${cosineDistance(items.embedding, queryVec)})`;
  return db
    .select()
    .from(items)
    .where(
      and(
        eq(items.userId, userId),
        ne(items.id, item.id),
        isNotNull(items.embedding),
        sql`1 - (${cosineDistance(items.embedding, queryVec)}) >= ${tuning.bridgeMinItemSim}`,
      ),
    )
    .orderBy(desc(similarity))
    .limit(limit);
}
