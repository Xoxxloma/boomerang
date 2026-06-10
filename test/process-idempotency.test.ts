import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processItem } from '../src/queue/jobs/process.js';
import { embed } from '../src/ai/embeddings.js';
import { getItem, setEmbedding } from '../src/db/items.js';
import { assignCluster } from '../src/cluster/assign.js';
import type { Item } from '../src/db/schema.js';

// Мокаем всё «тяжёлое» окружение processItem (БД, эмбеддинги, OCR/файлы, кластеризация, Telegram),
// чтобы проверить ТОЛЬКО гейт идемпотентности: повторный прогон джобы не переэмбеддит запись, у которой
// вектор уже есть — иначе платный эмбеддинг списался бы дважды (бюджет-гард). Стиль — как в parseQuery.test.
vi.mock('../src/ai/embeddings.js', () => ({ embed: vi.fn() }));
vi.mock('../src/db/items.js', () => ({
  getItem: vi.fn(),
  setEmbedding: vi.fn(),
  setOcrText: vi.fn(),
  setRawText: vi.fn(),
  markIndexed: vi.fn(),
}));
vi.mock('../src/ingest/extract.js', () => ({ buildIndexText: () => 'index text' }));
vi.mock('../src/cluster/assign.js', () => ({
  assignCluster: vi.fn(),
  assignToShelf: vi.fn(),
  IMAGE_SHELF: 'Изображения',
}));
vi.mock('../src/retrieval/proactive.js', () => ({ maybeSurface: vi.fn() }));
vi.mock('../src/content/ocr.js', () => ({ ocrImage: vi.fn() }));
vi.mock('../src/content/documents.js', () => ({ readDocument: vi.fn() }));
vi.mock('../src/content/files.js', () => ({ withTempFile: vi.fn() }));
vi.mock('../src/bot/api.js', () => ({ getBotApi: vi.fn(() => ({})) }));

const mockEmbed = vi.mocked(embed);
const mockGetItem = vi.mocked(getItem);
const mockSetEmbedding = vi.mocked(setEmbedding);
const mockAssignCluster = vi.mocked(assignCluster);

function makeItem(p: Partial<Item>): Item {
  return {
    id: 'i1',
    userId: 1,
    tgMessageId: null,
    sourceChat: null,
    type: 'text',
    rawText: 'привет мир',
    url: null,
    title: null,
    description: null,
    ocrText: null,
    transcript: null,
    tgFileId: null,
    tgFileUniqueId: null,
    mediaGroupId: null,
    embedding: null,
    clusterId: null,
    clusterLocked: false,
    createdAt: new Date(),
    indexedAt: null,
    ...p,
  };
}

describe('processItem — идемпотентность эмбеддинга (бюджет-гард)', () => {
  beforeEach(() => {
    mockEmbed.mockReset();
    mockGetItem.mockReset();
    mockSetEmbedding.mockReset();
    mockAssignCluster.mockReset();
    mockEmbed.mockResolvedValue([0.1, 0.2]);
  });

  it('вектора ещё нет → эмбеддит один раз и сохраняет', async () => {
    mockGetItem.mockResolvedValue(makeItem({ embedding: null, clusterId: null }));
    await processItem('i1', 'Разное');
    expect(mockEmbed).toHaveBeenCalledTimes(1);
    expect(mockSetEmbedding).toHaveBeenCalledTimes(1);
  });

  it('вектор уже в БД (ретрай после сбоя) → НЕ эмбеддит повторно (нет двойной оплаты)', async () => {
    mockGetItem.mockResolvedValue(makeItem({ embedding: [0.3, 0.4], clusterId: 'c1' }));
    await processItem('i1', 'Разное');
    expect(mockEmbed).not.toHaveBeenCalled();
    expect(mockSetEmbedding).not.toHaveBeenCalled();
    // уже отнесён к кластеру (clusterId проставлен) → повторного assignCluster тоже нет
    expect(mockAssignCluster).not.toHaveBeenCalled();
  });
});
