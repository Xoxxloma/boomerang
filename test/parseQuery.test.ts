import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseQuery } from '../src/retrieval/parseQuery.js';
import { chatJson } from '../src/ai/llm.js';
import { listClusters } from '../src/db/clusters.js';
import type { Cluster } from '../src/db/schema.js';

// Мокаем LLM и БД-кластеры: тестируем валидацию/маппинг разбора, а не модель и не Postgres.
// (Заодно не тянем config/env и db/client при импорте реальных модулей.)
vi.mock('../src/ai/llm.js', () => ({ chat: vi.fn(), chatJson: vi.fn() }));
vi.mock('../src/db/clusters.js', () => ({ listClusters: vi.fn() }));

const mockChatJson = vi.mocked(chatJson);
const mockListClusters = vi.mocked(listClusters);

function cluster(id: string, name: string): Cluster {
  return {
    id,
    userId: 1,
    name,
    centroid: null,
    size: 1,
    maturedAt: null,
    updatedAt: new Date(),
  };
}

describe('parseQuery', () => {
  beforeEach(() => {
    mockChatJson.mockReset();
    mockListClusters.mockReset();
    mockListClusters.mockResolvedValue([]);
  });

  it('пустой запрос — passthrough без LLM', async () => {
    const res = await parseQuery(1, '   ');
    expect(mockChatJson).not.toHaveBeenCalled();
    expect(res).toEqual({ query: '', types: [], sinceDays: null, expansions: [], clusterIds: [] });
  });

  it('тип+время без темы → метаданные-фильтр, query пуст', async () => {
    mockChatJson.mockResolvedValue({
      query: '',
      types: ['document'],
      sinceDays: 14,
      expansions: [],
      categories: [],
    });
    const res = await parseQuery(1, 'какие документы за последние две недели');
    expect(mockChatJson).toHaveBeenCalledOnce();
    expect(res).toMatchObject({ query: '', types: ['document'], sinceDays: 14 });
  });

  it('тема + временной фильтр сохраняются вместе', async () => {
    mockChatJson.mockResolvedValue({ query: 'ипотека', types: [], sinceDays: 7, expansions: [], categories: [] });
    const res = await parseQuery(1, 'ипотека за неделю');
    expect(res).toMatchObject({ query: 'ипотека', types: [], sinceDays: 7 });
  });

  it('мусорные/неизвестные типы отбрасываются, общие (tg_post/text) не фильтруют', async () => {
    mockChatJson.mockResolvedValue({
      query: '',
      types: ['document', 'banana', 'tg_post', 'text'],
      sinceDays: null,
      expansions: [],
      categories: [],
    });
    const res = await parseQuery(1, 'какие файлы я слал');
    expect(res.types).toEqual(['document']);
  });

  it('некорректный sinceDays клампится в null, нецелое — округляется вниз', async () => {
    mockChatJson.mockResolvedValue({ query: 'x', types: [], sinceDays: -3, expansions: [], categories: [] });
    expect((await parseQuery(1, 'x за месяц')).sinceDays).toBeNull();
    mockChatJson.mockResolvedValue({ query: 'x', types: [], sinceDays: 14.9, expansions: [], categories: [] });
    expect((await parseQuery(1, 'x за месяц')).sinceDays).toBe(14);
  });

  it('если LLM не нашёл фильтров — тема = исходный запрос (а не обрезок)', async () => {
    mockChatJson.mockResolvedValue({ query: '', types: [], sinceDays: null, expansions: [], categories: [] });
    const res = await parseQuery(1, 'видеокарты сравнение');
    expect(res.query).toBe('видеокарты сравнение');
  });

  it('синонимы прокидываются, имена категорий маппятся на id (без учёта регистра)', async () => {
    mockListClusters.mockResolvedValue([cluster('c-esport', 'Киберспорт'), cluster('c-food', 'Рецепты')]);
    mockChatJson.mockResolvedValue({
      query: 'новости Counter-Strike',
      types: [],
      sinceDays: null,
      expansions: ['Counter-Strike', 'CS2', 'киберспорт'],
      categories: ['киберспорт'], // другой регистр — должен сматчиться
    });
    const res = await parseQuery(1, 'новости контры');
    expect(res.expansions).toEqual(['Counter-Strike', 'CS2', 'киберспорт']);
    expect(res.clusterIds).toEqual(['c-esport']);
    expect(res.query).toBe('новости Counter-Strike');
  });

  it('выдуманные имена категорий (не из списка) отсекаются', async () => {
    mockListClusters.mockResolvedValue([cluster('c-esport', 'Киберспорт')]);
    mockChatJson.mockResolvedValue({
      query: 'x',
      types: [],
      sinceDays: null,
      expansions: [],
      categories: ['Несуществующая', 'Киберспорт'],
    });
    const res = await parseQuery(1, 'x контра');
    expect(res.clusterIds).toEqual(['c-esport']);
  });

  it('fail-safe: битый ответ LLM → passthrough по сырому запросу', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // null вместо объекта роняет разбор (TypeError) — тот же catch, что и при ошибке сети.
    mockChatJson.mockResolvedValue(null as never);
    const res = await parseQuery(1, 'документы за неделю');
    expect(res).toEqual({
      query: 'документы за неделю',
      types: [],
      sinceDays: null,
      expansions: [],
      clusterIds: [],
    });
    errSpy.mockRestore();
  });
});
