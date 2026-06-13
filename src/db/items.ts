import { and, cosineDistance, desc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { db } from './client.js';
import { items, type Item, type NewItem } from './schema.js';
import { recomputeClusterStats } from './clusters.js';
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

/**
 * Лёгкие контент-поля ВСЕХ записей кластера — для подсчёта содержательных (hasRealContent) в триггере
 * созревания и футере сводки. Не тащим vector и полные тела (документы до 40k): предикату важна лишь
 * непустота, а для ссылок (URL-стрип) хватает первых 500 символов rawText.
 */
export async function listClusterContentFields(
  userId: number,
  clusterId: string,
  limit = 500,
): Promise<Pick<Item, 'type' | 'url' | 'title' | 'description' | 'rawText' | 'ocrText' | 'transcript' | 'sourceChat'>[]> {
  return db
    .select({
      type: items.type,
      url: items.url,
      title: items.title,
      description: sql<string | null>`left(${items.description}, 1)`,
      rawText: sql<string | null>`left(${items.rawText}, 500)`,
      ocrText: sql<string | null>`left(${items.ocrText}, 1)`,
      transcript: sql<string | null>`left(${items.transcript}, 1)`,
      sourceChat: items.sourceChat,
    })
    .from(items)
    .where(and(eq(items.userId, userId), eq(items.clusterId, clusterId)))
    .limit(limit);
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
 * Удалить item по запросу пользователя (§ удаление контента) — чтобы бот больше его не учитывал.
 * Проверяем владельца. FK clusterId → onDelete: set null, кластеры не ломаются.
 * Возвращает true, если запись существовала и принадлежала пользователю.
 */
export async function deleteItem(id: string, userId: number): Promise<boolean> {
  const res = await db
    .delete(items)
    .where(and(eq(items.id, id), eq(items.userId, userId)))
    .returning({ id: items.id, clusterId: items.clusterId });
  // Запись ушла из кластера — пересчитываем его центроид/size от истины (иначе они «помнят» удалённое).
  const clusterId = res[0]?.clusterId;
  if (clusterId) await recomputeClusterStats(clusterId);
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
 * ищем старого соседа по кластеру. Только с clusterId (резонанс ищется внутри кластера). Свежие сверху.
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
        isNotNull(items.clusterId),
        sql`${items.createdAt} > now() - (${days} || ' days')::interval`,
      ),
    )
    .orderBy(desc(items.createdAt))
    .limit(limit);
}

/** Направленный мост между кластерами: ca → cb. bridges — сколько записей ca имеют близкого соседа в cb. */
export interface ClusterBridge {
  ca: string;
  cb: string;
  /** Число записей кластера ca, у которых ближайший кросс-кластерный сосед (из cb) прошёл порог. */
  bridges: number;
  /** Максимальная item-похожесть среди этих пар — сила самой крепкой нити между темами. */
  topSim: number;
}

/**
 * Мосты между кластерами для «Созвездия»: ребро темы значит «темы реально делят нити», а не «их
 * центроиды (усреднения) случайно рядом» — центроид теряет растворённую тему (кот в политическом посте).
 * Для каждой проиндексированной записи берём top-K ближайших соседей ИЗ ДРУГИХ кластеров (hnsw-индекс
 * items_embedding_idx), оставляем прошедших порог bridgeMinItemSim, агрегируем по направленной паре
 * кластеров. Дедуп/схлопывание в неориентированные рёбра — на стороне вызывающего (web-api/map).
 */
export async function listClusterBridges(userId: number): Promise<ClusterBridge[]> {
  const knn = tuning.bridgeKnn;
  const minSim = tuning.bridgeMinItemSim;
  // Raw SQL: оператор '<=>' (cosine distance) между ДВУМЯ vector-колонками + LATERAL — drizzle-builder не выражает.
  const rows = (await db.execute(sql`
    SELECT a.cluster_id AS ca,
           n.cluster_id AS cb,
           count(*)::int AS bridges,
           max(1 - (a.embedding <=> n.embedding)) AS top_sim
    FROM items a
    CROSS JOIN LATERAL (
      SELECT i.cluster_id, i.embedding
      FROM items i
      WHERE i.user_id = ${userId}
        AND i.embedding IS NOT NULL
        AND i.cluster_id IS NOT NULL
        AND i.cluster_id <> a.cluster_id
        AND i.id <> a.id
      ORDER BY i.embedding <=> a.embedding
      LIMIT ${knn}
    ) n
    WHERE a.user_id = ${userId}
      AND a.embedding IS NOT NULL
      AND a.cluster_id IS NOT NULL
      AND (1 - (a.embedding <=> n.embedding)) >= ${minSim}
    GROUP BY a.cluster_id, n.cluster_id
  `)) as unknown as Array<{ ca: string; cb: string; bridges: number; top_sim: number }>;
  return rows.map((r) => ({ ca: r.ca, cb: r.cb, bridges: Number(r.bridges), topSim: Number(r.top_sim) }));
}

/** Конкретная нить-мост: запись из кластера A перекликается с записью из кластера B (id + крепость). */
export interface BridgePair {
  aId: string;
  bId: string;
  similarity: number;
}

/**
 * Записи, реально связывающие две темы — «нити» под ребром «Созвездия» (тап по связи). Для каждой
 * записи кластера A находим близкие записи кластера B (item-level, тот же порог bridgeMinItemSim, что и
 * у рёбер). Возвращаем сырые пары по убыванию крепости; дедуп/выбор репрезентативных — на стороне route
 * (чтобы один «хаб»-пост не занял весь список). Кластеры обычно небольшие — попарный проход дёшев.
 */
export async function listBridgePairs(
  userId: number,
  clusterA: string,
  clusterB: string,
  candidateCap = 60,
): Promise<BridgePair[]> {
  const minSim = tuning.bridgeMinItemSim;
  const rows = (await db.execute(sql`
    SELECT a.id AS a_id, b.id AS b_id, 1 - (a.embedding <=> b.embedding) AS sim
    FROM items a
    JOIN items b ON b.user_id = a.user_id AND b.cluster_id = ${clusterB} AND b.embedding IS NOT NULL
    WHERE a.user_id = ${userId} AND a.cluster_id = ${clusterA} AND a.embedding IS NOT NULL
      AND 1 - (a.embedding <=> b.embedding) >= ${minSim}
    ORDER BY sim DESC
    LIMIT ${candidateCap}
  `)) as unknown as Array<{ a_id: string; b_id: string; sim: number }>;
  return rows.map((r) => ({ aId: r.a_id, bId: r.b_id, similarity: Number(r.sim) }));
}

/** Записи пользователя по списку id (батч) — для сборки нитей-мостов из сырых пар. Чужие отсекаем по userId. */
export async function listItemsByIds(userId: number, ids: string[]): Promise<Item[]> {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(items)
    .where(and(eq(items.userId, userId), inArray(items.id, ids)));
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
