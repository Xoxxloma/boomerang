import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from './client.js';
import { clusters, items, type Cluster } from './schema.js';

export async function listClusters(userId: number): Promise<Cluster[]> {
  return db.select().from(clusters).where(eq(clusters.userId, userId)).orderBy(sql`${clusters.size} desc`);
}

/**
 * Категории с РЕАЛЬНЫМ числом записей (count по items.cluster_id), крупные сверху — для /folders.
 * Реальный count честнее дрейфующего clusters.size (после ручных переносов/удалений size расходится).
 * Пустые кластеры (count 0) отбрасываем — листать нечего.
 */
export async function listClustersWithCounts(userId: number): Promise<(Cluster & { count: number })[]> {
  const count = sql<number>`count(${items.id})::int`;
  const rows = await db
    .select({ cluster: clusters, count })
    .from(clusters)
    .innerJoin(items, eq(items.clusterId, clusters.id))
    .where(eq(clusters.userId, userId))
    .groupBy(clusters.id)
    .orderBy(sql`count(${items.id}) desc`);
  return rows.map((r) => ({ ...r.cluster, count: r.count }));
}

export async function getCluster(id: string): Promise<Cluster | undefined> {
  const [row] = await db.select().from(clusters).where(eq(clusters.id, id)).limit(1);
  return row;
}

export async function findClusterByName(userId: number, name: string): Promise<Cluster | undefined> {
  const [row] = await db
    .select()
    .from(clusters)
    .where(and(eq(clusters.userId, userId), eq(clusters.name, name)))
    .limit(1);
  return row;
}

/** То же, но без учёта регистра — чтобы ручной ввод не плодил дубли «Авто»/«авто». */
export async function findClusterByNameCI(userId: number, name: string): Promise<Cluster | undefined> {
  const [row] = await db
    .select()
    .from(clusters)
    .where(and(eq(clusters.userId, userId), sql`lower(${clusters.name}) = lower(${name})`))
    .limit(1);
  return row;
}

/**
 * Создать кластер. Гонка check-then-create (два воркера одновременно не нашли имя и оба создают)
 * ловится уникальным индексом clusters_user_name_ci_uq: onConflictDoNothing вместо ошибки →
 * перечитываем и возвращаем уже созданный соседом кластер. Вызывающий не отличает исходы — и не должен
 * (но обязан пересчитать stats: при race-merge центроид/size существующего не учитывают его item).
 */
export async function createCluster(
  userId: number,
  name: string,
  centroid: number[] | null,
): Promise<Cluster> {
  const [row] = await db
    .insert(clusters)
    .values({ userId, name, centroid, size: 1 })
    .onConflictDoNothing()
    .returning();
  if (row) return row;
  const existing = await findClusterByNameCI(userId, name);
  if (!existing) throw new Error(`createCluster: конфликт без записи («${name}»)`);
  return existing;
}

/**
 * Пересчитать центроид и size кластера ОТ ИСТИНЫ — среднее по фактическим эмбеддингам записей и их
 * реальное число. В отличие от инкрементального обновления, не дрейфует: удаление/перенос учитываются
 * автоматически, параллельные вызовы пишут одно и то же верное среднее (нет lost-update), а size не
 * расходится с реальностью (см. listClustersWithCounts). avg(vector) — нативный аггрегат pgvector
 * (≥0.5; на проде 0.8.2). Пустой кластер → centroid NULL, size 0 (assignCluster такой пропускает).
 * Эмбеддинги записей НЕ пересчитываются (дорогой шаг сделан один раз) — только дешёвое усреднение в БД.
 */
export async function recomputeClusterStats(clusterId: string): Promise<number> {
  const rows = await db.execute<{ size: number }>(sql`
    update clusters set
      centroid = (select avg(embedding) from items where cluster_id = ${clusterId} and embedding is not null),
      size = (select count(*) from items where cluster_id = ${clusterId}),
      updated_at = now()
    where id = ${clusterId}
    returning size`);
  return Number(rows[0]?.size ?? 0);
}

export async function renameCluster(id: string, name: string): Promise<void> {
  await db.update(clusters).set({ name, updatedAt: sql`now()` }).where(eq(clusters.id, id));
}

/** Отметить, что по кластеру отправлено maturity-напоминание (проактивное всплытие, режим 2). */
export async function setClusterMatured(id: string): Promise<void> {
  await db.update(clusters).set({ maturedAt: sql`now()` }).where(eq(clusters.id, id));
}

/** Батч-назначение пачки item одному кластеру (заливка) — один UPDATE вместо N. */
export async function assignItemsToCluster(itemIds: string[], clusterId: string): Promise<void> {
  if (itemIds.length === 0) return;
  const CHUNK = 1000;
  for (let i = 0; i < itemIds.length; i += CHUNK) {
    await db
      .update(items)
      .set({ clusterId })
      .where(inArray(items.id, itemIds.slice(i, i + CHUNK)));
  }
}

/** Назначить item кластеру. locked=true — пользователь правил вручную (не перетрясать авто). */
export async function assignItemCluster(
  itemId: string,
  clusterId: string,
  locked = false,
): Promise<void> {
  await db
    .update(items)
    .set({ clusterId, ...(locked ? { clusterLocked: true } : {}) })
    .where(eq(items.id, itemId));
}
