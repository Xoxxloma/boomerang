import { cosineSimilarity, updatedCentroid } from './math.js';
import { NEW_CLUSTER_THRESHOLD } from './assign.js';

/** Существующий кластер пользователя как стартовый центроид (чтобы заливка мёржилась, а не дублировала). */
export interface SeedCluster {
  id: string;
  centroid: number[];
  size: number;
}

/** Точка для кластеризации: id записи, её эмбеддинг и короткий текст-образец (для нейминга). */
export interface ClusterPoint {
  itemId: string;
  emb: number[];
  sampleText: string;
}

/** Добавление пачки записей в существующий кластер: id записей + средний вектор добавленного. */
export interface ExistingAssignment {
  clusterId: string;
  itemIds: string[];
  addedCentroid: number[];
  addedCount: number;
}

/** Новая группа: финальный центроид, размер, id записей и образцы текста для LLM-нейминга. */
export interface NewGroup {
  centroid: number[];
  size: number;
  itemIds: string[];
  sampleTexts: string[];
}

export interface ClusterPlan {
  toExisting: ExistingAssignment[];
  newGroups: NewGroup[];
}

const MAX_SAMPLES = 5;

interface Live {
  isExisting: boolean;
  id?: string;
  centroid: number[]; // эволюционирует по мере добавления — для сравнения
  count: number; // полный размер (вкл. стартовый для существующих)
  addedSum: number[]; // сумма ДОБАВЛЕННЫХ эмбеддингов
  addedCount: number;
  itemIds: string[];
  samples: string[];
}

function addVec(acc: number[], v: number[]): void {
  for (let i = 0; i < acc.length; i++) acc[i]! += v[i]!;
}

function scale(v: number[], k: number): number[] {
  return v.map((x) => x * k);
}

/**
 * Батч-кластеризация в памяти (§7 «категории всплывают снизу»): один проход — каждая точка идёт в
 * ближайший живой кластер при близости ≥ NEW_CLUSTER_THRESHOLD, иначе заводит новый. Существующие
 * кластеры подгружаются как стартовые центроиды и растут. Чище поштучного online-assign на масштабе:
 * заливка не плодит параллельный набор кластеров.
 */
export function clusterEmbeddings(seeds: SeedCluster[], points: ClusterPoint[]): ClusterPlan {
  const dim = points[0]?.emb.length ?? seeds[0]?.centroid.length ?? 0;
  const live: Live[] = seeds.map((s) => ({
    isExisting: true,
    id: s.id,
    centroid: s.centroid.slice(),
    count: s.size,
    addedSum: new Array<number>(dim).fill(0),
    addedCount: 0,
    itemIds: [],
    samples: [],
  }));

  for (const p of points) {
    let best: Live | null = null;
    let bestSim = -Infinity;
    for (const c of live) {
      const sim = cosineSimilarity(p.emb, c.centroid);
      if (sim > bestSim) {
        bestSim = sim;
        best = c;
      }
    }

    if (best && bestSim >= NEW_CLUSTER_THRESHOLD) {
      best.centroid = updatedCentroid(best.centroid, best.count, p.emb);
      best.count += 1;
      addVec(best.addedSum, p.emb);
      best.addedCount += 1;
      best.itemIds.push(p.itemId);
      if (best.samples.length < MAX_SAMPLES && p.sampleText) best.samples.push(p.sampleText);
    } else {
      live.push({
        isExisting: false,
        centroid: p.emb.slice(),
        count: 1,
        addedSum: p.emb.slice(),
        addedCount: 1,
        itemIds: [p.itemId],
        samples: p.sampleText ? [p.sampleText] : [],
      });
    }
  }

  const toExisting: ExistingAssignment[] = [];
  const newGroups: NewGroup[] = [];
  for (const c of live) {
    if (c.addedCount === 0) continue;
    if (c.isExisting && c.id) {
      toExisting.push({
        clusterId: c.id,
        itemIds: c.itemIds,
        addedCentroid: scale(c.addedSum, 1 / c.addedCount),
        addedCount: c.addedCount,
      });
    } else {
      newGroups.push({
        centroid: c.centroid,
        size: c.count,
        itemIds: c.itemIds,
        sampleTexts: c.samples,
      });
    }
  }
  return { toExisting, newGroups };
}

/** Смешать старый центроид (веса size) с добавленным (веса addCount). */
export function blendCentroid(
  oldCentroid: number[],
  oldSize: number,
  addCentroid: number[],
  addCount: number,
): number[] {
  const total = oldSize + addCount;
  if (total === 0) return oldCentroid;
  return oldCentroid.map((x, i) => (x * oldSize + addCentroid[i]! * addCount) / total);
}
