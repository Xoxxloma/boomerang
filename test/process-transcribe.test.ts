import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processItem } from '../src/queue/jobs/process.js';
import { embed } from '../src/ai/embeddings.js';
import { transcribe } from '../src/ai/stt.js';
import { QuotaExceededError } from '../src/ai/errors.js';
import { getItem, setTranscript, setTitle } from '../src/db/items.js';
import { assignCluster } from '../src/cluster/assign.js';
import { withTempFile } from '../src/content/files.js';
import { classify, classifyWithTitle } from '../src/ingest/classify.js';
import type { Item } from '../src/db/schema.js';
import type { Api } from 'grammy';

// Мокаем всё «тяжёлое» окружение processItem (стиль — process-idempotency.test): проверяем ТОЛЬКО
// STT-ветку — гейты (повторная оплата, отсутствие файла), обогащение transcript →
// classifyWithTitle → свежая категория в кластер, и протечку бюджет-ошибок наружу (для worker).
vi.mock('../src/ai/embeddings.js', () => ({ embed: vi.fn() }));
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
const mockTranscribe = vi.mocked(transcribe);
const mockGetItem = vi.mocked(getItem);
const mockSetTranscript = vi.mocked(setTranscript);
const mockSetTitle = vi.mocked(setTitle);
const mockAssignCluster = vi.mocked(assignCluster);
const mockWithTempFile = vi.mocked(withTempFile);
const mockClassify = vi.mocked(classify);
const mockClassifyWithTitle = vi.mocked(classifyWithTitle);

function makeItem(p: Partial<Item>): Item {
  return {
    id: 'i1',
    userId: 1,
    tgMessageId: null,
    sourceChat: null,
    type: 'voice',
    rawText: null,
    url: null,
    title: null,
    description: null,
    ocrText: null,
    transcript: null,
    tgFileId: 'f1',
    tgFileUniqueId: 'u1',
    mediaGroupId: null,
    embedding: null,
    clusterId: null,
    clusterLocked: false,
    createdAt: new Date(),
    indexedAt: null,
    ...p,
  };
}

/** «Живой» item: setTranscript/setTitle меняют его, getItem отдаёт свежую версию — как реальная БД. */
let current: Item;
function useLiveItem(p: Partial<Item>): void {
  current = makeItem(p);
  mockGetItem.mockImplementation(async () => current);
  mockSetTranscript.mockImplementation(async (_id, transcript) => {
    current = { ...current, transcript };
  });
  mockSetTitle.mockImplementation(async (_id, title) => {
    current = { ...current, title };
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mockEmbed.mockResolvedValue([0.1, 0.2]);
  // withTempFile прозрачно зовёт колбэк — транскрипцию контролирует мок transcribe.
  mockWithTempFile.mockImplementation((_api: Api, _id: string, fn: (p: string) => Promise<unknown>) =>
    fn('/tmp/boomerang-u1.oga'),
  );
  mockClassifyWithTitle.mockResolvedValue({ category: 'Идеи', title: 'Идея про оплату подписки' });
});

describe('processItem — транскрипция голосовых/видео (STT-ветка)', () => {
  it('войс с файлом: транскрибирует, пишет transcript, classifyWithTitle один раз, свежая категория в кластер', async () => {
    useLiveItem({ type: 'voice' });
    mockTranscribe.mockResolvedValue('приходил Иванов спрашивал про повышение');

    await processItem('i1', 'Разное');

    expect(mockTranscribe).toHaveBeenCalledTimes(1);
    expect(mockSetTranscript).toHaveBeenCalledWith('i1', 'приходил Иванов спрашивал про повышение');
    expect(mockClassifyWithTitle).toHaveBeenCalledTimes(1);
    expect(mockSetTitle).toHaveBeenCalledWith('i1', 'Идея про оплату подписки');
    // свежая категория уходит сидом в кластеризацию; старый classify не зовётся (нет двойного LLM)
    expect(mockAssignCluster).toHaveBeenCalledWith(expect.anything(), 'Идеи');
    expect(mockClassify).not.toHaveBeenCalled();
  });

  it('видео с файлом (≤20MB) транскрибируется так же', async () => {
    useLiveItem({ type: 'video' });
    mockTranscribe.mockResolvedValue('текст из ролика');
    await processItem('i1', 'Разное');
    expect(mockTranscribe).toHaveBeenCalledTimes(1);
    expect(mockSetTranscript).toHaveBeenCalledWith('i1', 'текст из ролика');
  });

  it('transcript уже есть (ретрай джобы) → STT НЕ зовётся повторно (нет двойной оплаты)', async () => {
    useLiveItem({ transcript: 'уже расшифровано', embedding: [0.3, 0.4], clusterId: 'c1' });
    await processItem('i1', 'Разное');
    expect(mockWithTempFile).not.toHaveBeenCalled();
    expect(mockTranscribe).not.toHaveBeenCalled();
  });

  it('войс без tgFileId (старая запись / >20MB / gif) → STT не пробуем', async () => {
    useLiveItem({ tgFileId: null });
    await processItem('i1', 'Разное');
    expect(mockWithTempFile).not.toHaveBeenCalled();
  });

  it('transcribe упал (протухший file_id / сеть) → джоба НЕ падает, transcript не пишется', async () => {
    useLiveItem({ type: 'voice' });
    mockTranscribe.mockRejectedValue(new Error('file not found'));
    await expect(processItem('i1', 'Разное')).resolves.toBeDefined();
    expect(mockSetTranscript).not.toHaveBeenCalled();
    expect(mockClassifyWithTitle).not.toHaveBeenCalled();
  });

  it('бюджет-стоп (QuotaExceededError) пробрасывается наружу — worker покажет «лимит исчерпан»', async () => {
    useLiveItem({ type: 'voice' });
    mockTranscribe.mockRejectedValue(new QuotaExceededError(new Date()));
    await expect(processItem('i1', 'Разное')).rejects.toThrow(QuotaExceededError);
  });

  it('пустая транскрипция (инструментал/тишина) → не пишем, не классифицируем, не сбой', async () => {
    useLiveItem({ type: 'voice' });
    mockTranscribe.mockResolvedValue('');
    await expect(processItem('i1', 'Разное')).resolves.toBeDefined();
    expect(mockSetTranscript).not.toHaveBeenCalled();
    expect(mockClassifyWithTitle).not.toHaveBeenCalled();
  });

  it('title уже есть (теги трека «Исполнитель — Название») → LLM-заголовком не затираем', async () => {
    useLiveItem({ title: 'Miyagi — Captain' });
    mockTranscribe.mockResolvedValue('текст песни');
    await processItem('i1', 'Разное');
    expect(mockSetTitle).not.toHaveBeenCalled();
    // а категория всё равно освежается
    expect(mockAssignCluster).toHaveBeenCalledWith(expect.anything(), 'Идеи');
  });

  it('classifyWithTitle дал «Разное» → осмысленный L1-seed не затирается', async () => {
    useLiveItem({ type: 'voice' });
    mockTranscribe.mockResolvedValue('что-то невнятное');
    mockClassifyWithTitle.mockResolvedValue({ category: 'Разное', title: null });
    await processItem('i1', 'Голосовые');
    expect(mockAssignCluster).toHaveBeenCalledWith(expect.anything(), 'Голосовые');
    // и общий enriched-хук НЕ зовёт classify второй раз (тот же сигнал — та же цена за тот же ответ)
    expect(mockClassify).not.toHaveBeenCalled();
  });
});
