import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processItem } from '../src/queue/jobs/process.js';
import { embed } from '../src/ai/embeddings.js';
import { getItem, setEmbedding } from '../src/db/items.js';
import { assignCluster } from '../src/cluster/assign.js';
import { withTempFile } from '../src/content/files.js';
import { classify } from '../src/ingest/classify.js';
import type { Item } from '../src/db/schema.js';

// Мокаем всё «тяжёлое» окружение processItem (БД, эмбеддинги, OCR/файлы, кластеризация, Telegram),
// чтобы проверить ТОЛЬКО гейт идемпотентности: повторный прогон джобы не переэмбеддит запись, у которой
// вектор уже есть — иначе платный эмбеддинг списался бы дважды (бюджет-гард). Стиль — как в parseQuery.test.
vi.mock('../src/ai/embeddings.js', () => ({ embed: vi.fn() }));
// Сценарии — про эмбеддинг/документы; STT-ветка (voice/video) тут не задевается,
// своя ветка тестируется в process-transcribe.test.ts.
vi.mock('../src/ai/stt.js', () => ({ transcribe: vi.fn() }));
// Vision-ветка (image) тут не задевается (см. process-vision.test.ts), но модуль тянет env — мокаем.
vi.mock('../src/ai/vision.js', () => ({ describeImage: vi.fn() }));
vi.mock('../src/db/items.js', () => ({
  getItem: vi.fn(),
  setDescription: vi.fn(),
  setEmbedding: vi.fn(),
  setOcrText: vi.fn(),
  setRawText: vi.fn(),
  setTranscript: vi.fn(),
  setTitle: vi.fn(),
  markIndexed: vi.fn(),
}));
vi.mock('../src/ingest/extract.js', () => ({ buildIndexText: () => 'index text' }));
vi.mock('../src/cluster/assign.js', () => ({
  assignCluster: vi.fn(),
  assignToShelf: vi.fn(),
  IMAGE_SHELF: 'Изображения',
}));
vi.mock('../src/retrieval/proactive.js', () => ({ maybeSurface: vi.fn() }));
vi.mock('../src/ingest/classify.js', () => ({ classify: vi.fn(), classifyWithTitle: vi.fn() }));
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

  it('транзиентный сбой записи вектора → ретраит setEmbedding, embed() не зовём заново', async () => {
    mockGetItem.mockResolvedValue(makeItem({ embedding: null, clusterId: null }));
    // Первые две записи падают (обрыв БД), третья проходит — оплаченный вектор не выбрасываем.
    mockSetEmbedding
      .mockRejectedValueOnce(new Error('db hiccup'))
      .mockRejectedValueOnce(new Error('db hiccup'))
      .mockResolvedValueOnce(undefined);
    await processItem('i1', 'Разное');
    expect(mockEmbed).toHaveBeenCalledTimes(1); // платный вызов ровно один
    expect(mockSetEmbedding).toHaveBeenCalledTimes(3); // 2 сбоя + успех
  });

  it('запись вектора падает стабильно → пробрасываем (pg-boss доретраит весь джоб)', async () => {
    mockGetItem.mockResolvedValue(makeItem({ embedding: null, clusterId: null }));
    mockSetEmbedding.mockRejectedValue(new Error('db down'));
    await expect(processItem('i1', 'Разное')).rejects.toThrow('db down');
    expect(mockSetEmbedding).toHaveBeenCalledTimes(3); // исчерпали попытки
  });
});

describe('processItem — docUnreadable (честный фидбек о нечитаемом документе)', () => {
  const mockWithTempFile = vi.mocked(withTempFile);

  beforeEach(() => {
    mockEmbed.mockReset();
    mockGetItem.mockReset();
    mockWithTempFile.mockReset();
    mockSetEmbedding.mockReset(); // изолируем от reject-сценариев записи вектора выше
    mockEmbed.mockResolvedValue([0.1, 0.2]);
  });

  it('документ пробовали читать, тело пустое → docUnreadable=true', async () => {
    mockGetItem.mockResolvedValue(makeItem({ type: 'document', tgFileId: 'f1', title: 'скан.pdf' }));
    mockWithTempFile.mockResolvedValue(''); // readDocument вернул пусто
    const res = await processItem('i1', 'Разное');
    expect(res.docUnreadable).toBe(true);
  });

  it('тело прочиталось → docUnreadable=false', async () => {
    mockGetItem.mockResolvedValue(makeItem({ type: 'document', tgFileId: 'f1', title: 'doc.pdf' }));
    mockWithTempFile.mockResolvedValue('текст документа');
    const res = await processItem('i1', 'Разное');
    expect(res.docUnreadable).toBe(false);
  });

  it('не документ → чтение не пробуем, docUnreadable=false', async () => {
    mockGetItem.mockResolvedValue(makeItem({ type: 'text' }));
    const res = await processItem('i1', 'Разное');
    expect(mockWithTempFile).not.toHaveBeenCalled();
    expect(res.docUnreadable).toBe(false);
  });
});

describe('processItem — переклассификация после обогащения (общий хук)', () => {
  const mockWithTempFile = vi.mocked(withTempFile);
  const mockClassify = vi.mocked(classify);

  beforeEach(() => {
    mockEmbed.mockReset();
    mockGetItem.mockReset();
    mockWithTempFile.mockReset();
    mockClassify.mockReset();
    mockAssignCluster.mockReset();
    mockSetEmbedding.mockReset(); // изолируем от reject-сценариев записи вектора выше
    mockEmbed.mockResolvedValue([0.1, 0.2]);
  });

  it('тело документа прочитано → seed освежается по контенту (не имя файла)', async () => {
    mockGetItem.mockResolvedValue(makeItem({ type: 'document', tgFileId: 'f1', title: 'smeta.pdf' }));
    mockWithTempFile.mockResolvedValue('Устройство стяжки, штукатурка, ламинат');
    mockClassify.mockResolvedValue('Ремонт');
    await processItem('i1', 'Документы');
    expect(mockClassify).toHaveBeenCalledTimes(1);
    expect(mockAssignCluster).toHaveBeenCalledWith(expect.anything(), 'Ремонт');
  });

  it('classify упал в «Разное» → осмысленный L1-seed не затирается', async () => {
    mockGetItem.mockResolvedValue(makeItem({ type: 'document', tgFileId: 'f1', title: 'smeta.pdf' }));
    mockWithTempFile.mockResolvedValue('какое-то тело');
    mockClassify.mockResolvedValue('Разное');
    await processItem('i1', 'Документы');
    expect(mockAssignCluster).toHaveBeenCalledWith(expect.anything(), 'Документы');
  });

  it('обогащения не было (текст) → classify не зовём, seed как есть', async () => {
    mockGetItem.mockResolvedValue(makeItem({ type: 'text' }));
    await processItem('i1', 'Заметки');
    expect(mockClassify).not.toHaveBeenCalled();
    expect(mockAssignCluster).toHaveBeenCalledWith(expect.anything(), 'Заметки');
  });

  it('документ без тела (скан) → обогащения нет, classify не зовём', async () => {
    mockGetItem.mockResolvedValue(makeItem({ type: 'document', tgFileId: 'f1', title: 'скан.pdf' }));
    mockWithTempFile.mockResolvedValue('');
    await processItem('i1', 'Документы');
    expect(mockClassify).not.toHaveBeenCalled();
    expect(mockAssignCluster).toHaveBeenCalledWith(expect.anything(), 'Документы');
  });
});
