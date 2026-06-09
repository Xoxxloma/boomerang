import { describe, it, expect } from 'vitest';
import { matchClustersByName, wordSimilarity } from '../src/retrieval/clusterMatch.js';
import type { Cluster } from '../src/db/schema.js';

function cluster(name: string): Cluster {
  return {
    id: name,
    userId: 1,
    name,
    centroid: null,
    size: 0,
    maturedAt: null,
    updatedAt: new Date(),
  };
}

describe('wordSimilarity', () => {
  it('терпит русскую морфологию (окончания)', () => {
    expect(wordSimilarity('животные', 'животным')).toBeGreaterThan(0.45);
    expect(wordSimilarity('политика', 'политику')).toBeGreaterThan(0.45);
  });

  it('разные слова — низкая близость', () => {
    expect(wordSimilarity('животные', 'музыка')).toBeLessThan(0.45);
    expect(wordSimilarity('кот', 'политика')).toBeLessThan(0.45);
  });
});

describe('matchClustersByName', () => {
  const clusters = [cluster('Животные'), cluster('Музыка'), cluster('Политика')];

  it('находит категорию по слову запроса в любой форме', () => {
    expect(matchClustersByName(clusters, 'что есть по животным?').map((c) => c.name)).toEqual([
      'Животные',
    ]);
    expect(matchClustersByName(clusters, 'покажи про музыку').map((c) => c.name)).toEqual(['Музыка']);
  });

  it('ничего не матчит, если запрос не про категории', () => {
    expect(matchClustersByName(clusters, 'ипотека и ставки')).toEqual([]);
  });

  it('короткие слова (предлоги) игнорируются', () => {
    expect(matchClustersByName(clusters, 'по')).toEqual([]);
  });
});
