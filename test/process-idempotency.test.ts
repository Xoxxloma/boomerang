import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processItem } from '../src/queue/jobs/process.js';
import { embed } from '../src/ai/embeddings.js';
import { getItem, setEmbedding } from '../src/db/items.js';
import { withTempFile } from '../src/content/files.js';
import type { Item } from '../src/db/schema.js';

// Мокаем всё «тяжёлое» окружение processItem (БД, эмбеддинги, OCR/файлы, Telegram), чтобы проверить
// ТОЛЬКО гейт идемпотентности: повторный прогон джобы не переэмбеддит запись, у которой вектор уже
// есть — иначе платный эмбеддинг списался бы дважды (бюджет-гард). Стиль — как в parseQuery.test.
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
  setBodyText: vi.fn(),
  setOcrText: vi.fn(),
  setRawText: vi.fn(),
  setTranscript: vi.fn(),
  setTitle: vi.fn(),
  markIndexed: vi.fn(),
}));
vi.mock('../src/ingest/extract.js', () => ({ buildIndexText: () => 'index text' }));
vi.mock('../src/ingest/classify.js', () => ({
  classifyWithTitle: vi.fn(),
  classifyWithTitleAndReminder: vi.fn(),
}));
vi.mock('../src/content/ocr.js', () => ({ ocrImage: vi.fn() }));
vi.mock('../src/content/documents.js', () => ({ readDocument: vi.fn() }));
vi.mock('../src/content/files.js', () => ({ withTempFile: vi.fn() }));
vi.mock('../src/bot/api.js', () => ({ getBotApi: vi.fn(() => ({})) }));

const mockEmbed = vi.mocked(embed);
const mockGetItem = vi.mocked(getItem);
const mockSetEmbedding = vi.mocked(setEmbedding);

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
    bodyText: null,
    bodyStatus: null,
    tgFileId: null,
    tgFileUniqueId: null,
    mediaGroupId: null,
    embedding: null,
    createdAt: new Date(),
    indexedAt: null,
    remindAt: null,
    remindStatus: null,
    remindCreatedAt: null,
    ...p,
  };
}

describe('processItem — идемпотентность эмбеддинга (бюджет-гард)', () => {
  beforeEach(() => {
    mockEmbed.mockReset();
    mockGetItem.mockReset();
    mockSetEmbedding.mockReset();
    mockEmbed.mockResolvedValue([0.1, 0.2]);
  });

  it('вектора ещё нет → эмбеддит один раз и сохраняет', async () => {
    mockGetItem.mockResolvedValue(makeItem({ embedding: null }));
    await processItem('i1');
    expect(mockEmbed).toHaveBeenCalledTimes(1);
    expect(mockSetEmbedding).toHaveBeenCalledTimes(1);
  });

  it('вектор уже в БД (ретрай после сбоя) → НЕ эмбеддит повторно (нет двойной оплаты)', async () => {
    mockGetItem.mockResolvedValue(makeItem({ embedding: [0.3, 0.4] }));
    await processItem('i1');
    expect(mockEmbed).not.toHaveBeenCalled();
    expect(mockSetEmbedding).not.toHaveBeenCalled();
  });

  it('транзиентный сбой записи вектора → ретраит setEmbedding, embed() не зовём заново', async () => {
    mockGetItem.mockResolvedValue(makeItem({ embedding: null }));
    // Первые две записи падают (обрыв БД), третья проходит — оплаченный вектор не выбрасываем.
    mockSetEmbedding
      .mockRejectedValueOnce(new Error('db hiccup'))
      .mockRejectedValueOnce(new Error('db hiccup'))
      .mockResolvedValueOnce(undefined);
    await processItem('i1');
    expect(mockEmbed).toHaveBeenCalledTimes(1); // платный вызов ровно один
    expect(mockSetEmbedding).toHaveBeenCalledTimes(3); // 2 сбоя + успех
  });

  it('запись вектора падает стабильно → пробрасываем (pg-boss доретраит весь джоб)', async () => {
    mockGetItem.mockResolvedValue(makeItem({ embedding: null }));
    mockSetEmbedding.mockRejectedValue(new Error('db down'));
    await expect(processItem('i1')).rejects.toThrow('db down');
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
    const res = await processItem('i1');
    expect(res.docUnreadable).toBe(true);
  });

  it('тело прочиталось → docUnreadable=false', async () => {
    mockGetItem.mockResolvedValue(makeItem({ type: 'document', tgFileId: 'f1', title: 'doc.pdf' }));
    mockWithTempFile.mockResolvedValue('текст документа');
    const res = await processItem('i1');
    expect(res.docUnreadable).toBe(false);
  });

  it('не документ → чтение не пробуем, docUnreadable=false', async () => {
    mockGetItem.mockResolvedValue(makeItem({ type: 'text' }));
    const res = await processItem('i1');
    expect(mockWithTempFile).not.toHaveBeenCalled();
    expect(res.docUnreadable).toBe(false);
  });
});
