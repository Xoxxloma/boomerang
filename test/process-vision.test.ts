import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processItem } from '../src/queue/jobs/process.js';
import { embed } from '../src/ai/embeddings.js';
import { describeImage } from '../src/ai/vision.js';
import { QuotaExceededError } from '../src/ai/errors.js';
import { getItem, setDescription, setOcrText, setTitle } from '../src/db/items.js';
import { ocrImage } from '../src/content/ocr.js';
import { withTempFile } from '../src/content/files.js';
import type { Item } from '../src/db/schema.js';
import type { Api } from 'grammy';

// Мокаем всё «тяжёлое» окружение processItem (стиль — process-transcribe.test): проверяем ТОЛЬКО
// image-ветку — OCR+vision в одном скачивании, гейты от двойной оплаты при ретрае, протечку
// бюджет-ошибок наружу (для worker). Категорий/полок больше нет — vision даёт description+title.
vi.mock('../src/ai/embeddings.js', () => ({ embed: vi.fn() }));
vi.mock('../src/ai/stt.js', () => ({ transcribe: vi.fn() }));
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
vi.mock('../src/ingest/classify.js', () => ({
  classifyWithTitle: vi.fn(),
  classifyWithTitleAndReminder: vi.fn(),
}));
vi.mock('../src/content/ocr.js', () => ({ ocrImage: vi.fn() }));
vi.mock('../src/content/documents.js', () => ({ readDocument: vi.fn() }));
vi.mock('../src/content/files.js', () => ({ withTempFile: vi.fn() }));
vi.mock('../src/bot/api.js', () => ({ getBotApi: vi.fn(() => ({})) }));

const mockEmbed = vi.mocked(embed);
const mockDescribeImage = vi.mocked(describeImage);
const mockGetItem = vi.mocked(getItem);
const mockSetDescription = vi.mocked(setDescription);
const mockSetOcrText = vi.mocked(setOcrText);
const mockSetTitle = vi.mocked(setTitle);
const mockOcrImage = vi.mocked(ocrImage);
const mockWithTempFile = vi.mocked(withTempFile);

function makeItem(p: Partial<Item>): Item {
  return {
    id: 'i1',
    userId: 1,
    tgMessageId: null,
    sourceChat: null,
    type: 'image',
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
    createdAt: new Date(),
    indexedAt: null,
    remindAt: null,
    remindStatus: null,
    remindCreatedAt: null,
    ...p,
  };
}

/** «Живой» item: set* меняют его, getItem отдаёт свежую версию — как реальная БД. */
let current: Item;
function useLiveItem(p: Partial<Item>): void {
  current = makeItem(p);
  mockGetItem.mockImplementation(async () => current);
  mockSetOcrText.mockImplementation(async (_id, ocrText) => {
    current = { ...current, ocrText };
  });
  mockSetDescription.mockImplementation(async (_id, description) => {
    current = { ...current, description };
  });
  mockSetTitle.mockImplementation(async (_id, title) => {
    current = { ...current, title };
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mockEmbed.mockResolvedValue([0.1, 0.2]);
  // withTempFile прозрачно зовёт колбэк — OCR/vision контролируют свои моки.
  mockWithTempFile.mockImplementation((_api: Api, _id: string, fn: (p: string) => Promise<unknown>) =>
    fn('/tmp/boomerang-u1.jpg'),
  );
  mockOcrImage.mockResolvedValue('');
  mockDescribeImage.mockResolvedValue({
    description: 'Рыжий кот спит на подоконнике',
    title: 'Рыжий кот на подоконнике',
  });
});

describe('processItem — vision-аннотация картинок (image-ветка)', () => {
  it('happy-path: OCR и vision по разу, description/title пишутся', async () => {
    useLiveItem({ rawText: 'смотри какой', sourceChat: 'Котоканал' });
    mockOcrImage.mockResolvedValue('надпись на меме');

    await processItem('i1');

    expect(mockOcrImage).toHaveBeenCalledTimes(1);
    expect(mockSetOcrText).toHaveBeenCalledWith('i1', 'надпись на меме');
    expect(mockDescribeImage).toHaveBeenCalledTimes(1);
    // контекст vision: подпись + свежая OCR-выжимка + источник
    expect(mockDescribeImage).toHaveBeenCalledWith(
      '/tmp/boomerang-u1.jpg',
      { caption: 'смотри какой', ocr: 'надпись на меме', source: 'Котоканал' },
      1,
    );
    expect(mockSetDescription).toHaveBeenCalledWith('i1', 'Рыжий кот спит на подоконнике');
    expect(mockSetTitle).toHaveBeenCalledWith('i1', 'Рыжий кот на подоконнике');
  });

  it('ретрай: ocr и description уже в БД → файл не качаем, vision не зовётся (нет двойной оплаты)', async () => {
    useLiveItem({ ocrText: 'текст', description: 'описание', embedding: [0.3, 0.4] });
    await processItem('i1');
    expect(mockWithTempFile).not.toHaveBeenCalled();
    expect(mockDescribeImage).not.toHaveBeenCalled();
  });

  it('частичный ретрай: OCR уже есть, description нет → vision зовётся, OCR — нет', async () => {
    useLiveItem({ ocrText: 'уже распознано' });
    await processItem('i1');
    expect(mockOcrImage).not.toHaveBeenCalled();
    expect(mockDescribeImage).toHaveBeenCalledTimes(1);
    expect(mockDescribeImage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ocr: 'уже распознано' }),
      1,
    );
  });

  it('транзиентный сбой vision (сеть/не-JSON) → джоба НЕ падает, OCR сохранён', async () => {
    useLiveItem({});
    mockOcrImage.mockResolvedValue('текст с картинки');
    mockDescribeImage.mockRejectedValue(new Error('network'));
    await expect(processItem('i1')).resolves.toBeDefined();
    expect(mockSetOcrText).toHaveBeenCalledWith('i1', 'текст с картинки');
    expect(mockSetDescription).not.toHaveBeenCalled();
  });

  it('бюджет-стоп (QuotaExceededError) пробрасывается наружу — worker покажет «лимит исчерпан»', async () => {
    useLiveItem({});
    mockDescribeImage.mockRejectedValue(new QuotaExceededError(new Date()));
    await expect(processItem('i1')).rejects.toThrow(QuotaExceededError);
  });

  it('vision без заголовка → description всё равно записан (индекс обогащён)', async () => {
    useLiveItem({});
    mockDescribeImage.mockResolvedValue({ description: 'Размытое фото', title: null });
    await processItem('i1');
    expect(mockSetDescription).toHaveBeenCalledWith('i1', 'Размытое фото');
    expect(mockSetTitle).not.toHaveBeenCalled();
  });

  it('свой title уже есть → vision-заголовком не затираем', async () => {
    useLiveItem({ title: 'Мой заголовок' });
    await processItem('i1');
    expect(mockSetTitle).not.toHaveBeenCalled();
  });

  it('без tgFileId (старая запись) → ни OCR, ни vision не пробуем', async () => {
    useLiveItem({ tgFileId: null });
    await processItem('i1');
    expect(mockWithTempFile).not.toHaveBeenCalled();
    expect(mockDescribeImage).not.toHaveBeenCalled();
  });
});
