import type { Item } from '../db/schema.js';
import {
  assignItemCluster,
  createCluster,
  findClusterByName,
  findClusterByNameCI,
  listClusters,
  recomputeClusterStats,
} from '../db/clusters.js';
import { cosineSimilarity } from './math.js';
import { tuning } from '../config/tuning.js';

/** Единая полка «Изображения» (§3.4): картинки не дробим на подкатегории. */
export const IMAGE_SHELF = 'Изображения';

/**
 * Принудительно кладёт item в именованную полку (не по схожести). Для картинок.
 * Если есть эмбеддинг — подтягивает центроид полки (для поиска это не важно, но держим консистентно).
 */
export async function assignToShelf(
  userId: number,
  name: string,
  itemId: string,
  emb: number[] | null,
): Promise<void> {
  const shelf = await findClusterByName(userId, name);
  if (!shelf) {
    const created = await createCluster(userId, name, emb);
    await assignItemCluster(itemId, created.id);
    return;
  }
  await assignItemCluster(itemId, shelf.id);
  // Центроид/size — от истины (среднее по фактическим записям полки), без дрейфа.
  await recomputeClusterStats(shelf.id);
}

/**
 * Порог близости к ближайшему кластеру. Ниже — заводим новый кластер-кандидат.
 * Подбирается эмпирически на своём корпусе (§12), настраивается через CLUSTER_THRESHOLD в .env.
 */
export const NEW_CLUSTER_THRESHOLD = tuning.clusterThreshold;

/**
 * Результат отнесения к кластеру. isNew — завели новый кластер; size — размер кластера ПОСЛЕ
 * добавления этого item. Нужно проактивному всплытию (режим 2): резонанс — только при попадании
 * в существующий кластер; созревание — когда size пересёк порог.
 */
export interface AssignResult {
  clusterId: string;
  /** Имя кластера, куда реально попал item — для финализации L1-подтверждения (шаг «Положил в …»). */
  name: string;
  isNew: boolean;
  size: number;
}

/**
 * Отнести item к ближайшему существующему кластеру (по косинусу к центроиду) или,
 * если далеко от всех, завести новый. Реализует «категории всплывают снизу» (§7).
 * seedName — имя для нового кластера (из L1-классификации, без лишнего LLM-вызова).
 * Не трогает item с cluster_locked=true (ручная правка пользователя — приоритет).
 */
export async function assignCluster(item: Item, seedName: string): Promise<AssignResult | null> {
  if (!item.embedding) return null;
  if (item.clusterLocked) return null;

  const emb = item.embedding as number[];
  const existing = await listClusters(item.userId);

  let best: { id: string; name: string; sim: number; centroid: number[]; size: number } | null = null;
  for (const c of existing) {
    if (!c.centroid) continue;
    const sim = cosineSimilarity(emb, c.centroid as number[]);
    if (!best || sim > best.sim) {
      best = { id: c.id, name: c.name, sim, centroid: c.centroid as number[], size: c.size };
    }
  }

  if (best && best.sim >= NEW_CLUSTER_THRESHOLD) {
    await assignItemCluster(item.id, best.id);
    // size — реальное число записей после добавления (нужно maturity-триггеру: size === порог).
    const size = await recomputeClusterStats(best.id);
    return { clusterId: best.id, name: best.name, isNew: false, size };
  }

  // Вектор далёк от всех кластеров. Но прежде чем плодить новый — не было бы дубля ПО ИМЕНИ
  // (L1-классификатор выдал ту же категорию, напр. «Новости»/«Разное»). Как в батче: мёржим в
  // одноимённый, не создаём близнеца. Иначе /folders покажет две одинаковые папки, а recall по
  // имени категории размоется по дублям.
  const name = seedName || 'Разное';
  const byName = await findClusterByNameCI(item.userId, name);
  if (byName) {
    await assignItemCluster(item.id, byName.id);
    const size = await recomputeClusterStats(byName.id);
    return { clusterId: byName.id, name: byName.name, isNew: false, size };
  }

  const created = await createCluster(item.userId, name, emb);
  await assignItemCluster(item.id, created.id);
  return { clusterId: created.id, name: created.name, isNew: true, size: 1 };
}
