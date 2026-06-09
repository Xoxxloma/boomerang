import { describe, it, expect } from 'vitest';
import { clusterEmbeddings, blendCentroid, type ClusterPoint } from '../src/cluster/batch.js';

function pt(itemId: string, emb: number[]): ClusterPoint {
  return { itemId, emb, sampleText: itemId };
}

describe('clusterEmbeddings', () => {
  it('две далёкие группы → два новых кластера', () => {
    const points = [
      pt('a1', [1, 0]),
      pt('a2', [0.99, 0.01]),
      pt('b1', [0, 1]),
      pt('b2', [0.01, 0.99]),
    ];
    const { toExisting, newGroups } = clusterEmbeddings([], points);
    expect(toExisting).toHaveLength(0);
    expect(newGroups).toHaveLength(2);
    const sizes = newGroups.map((g) => g.size).sort();
    expect(sizes).toEqual([2, 2]);
  });

  it('близкие точки мёржатся в существующий кластер-сид', () => {
    const seed = { id: 'seed-1', centroid: [1, 0], size: 10 };
    const { toExisting, newGroups } = clusterEmbeddings([seed], [pt('x', [0.98, 0.02])]);
    expect(newGroups).toHaveLength(0);
    expect(toExisting).toHaveLength(1);
    expect(toExisting[0]!.clusterId).toBe('seed-1');
    expect(toExisting[0]!.addedCount).toBe(1);
    expect(toExisting[0]!.itemIds).toEqual(['x']);
  });

  it('далёкая от сида точка → новый кластер, сид не трогаем', () => {
    const seed = { id: 'seed-1', centroid: [1, 0], size: 5 };
    const { toExisting, newGroups } = clusterEmbeddings([seed], [pt('y', [0, 1])]);
    expect(toExisting).toHaveLength(0);
    expect(newGroups).toHaveLength(1);
    expect(newGroups[0]!.itemIds).toEqual(['y']);
  });

  it('собирает образцы текста для нейминга (не более 5)', () => {
    const points = Array.from({ length: 8 }, (_, i) => pt(`s${i}`, [1, 0.001 * i]));
    const { newGroups } = clusterEmbeddings([], points);
    expect(newGroups).toHaveLength(1);
    expect(newGroups[0]!.sampleTexts.length).toBeLessThanOrEqual(5);
  });
});

describe('blendCentroid', () => {
  it('смешивает по весам size/addCount', () => {
    // старый [0] вес 1 + добавленный [10] вес 1 → [5]
    expect(blendCentroid([0], 1, [10], 1)).toEqual([5]);
    // старый [0] вес 9 + добавленный [10] вес 1 → [1]
    expect(blendCentroid([0], 9, [10], 1)).toEqual([1]);
  });
});
