import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processItem } from '../src/queue/jobs/process.js';
import { embed } from '../src/ai/embeddings.js';
import { transcribe } from '../src/ai/stt.js';
import { QuotaExceededError } from '../src/ai/errors.js';
import { getItem, setTranscript, setTitle } from '../src/db/items.js';
import { withTempFile } from '../src/content/files.js';
import { classifyWithTitle, classifyWithTitleAndReminder } from '../src/ingest/classify.js';
import { getReminderSettings, setReminder } from '../src/db/reminders.js';
import type { Item } from '../src/db/schema.js';
import type { Api } from 'grammy';

// Мокаем всё «тяжёлое» окружение processItem (стиль — process-idempotency.test): проверяем ТОЛЬКО
// STT-ветку — гейты (повторная оплата, отсутствие файла), обогащение transcript → заголовок
// (classifyWithTitle), детект напоминания и протечку бюджет-ошибок наружу (для worker).
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
vi.mock('../src/ingest/classify.js', () => ({
  classifyWithTitle: vi.fn(),
  classifyWithTitleAndReminder: vi.fn(),
}));
vi.mock('../src/db/reminders.js', () => ({
  getReminderSettings: vi.fn(async () => ({ tz: 'Europe/Moscow', defaultHour: 9 })),
  setReminder: vi.fn(),
}));
vi.mock('../src/content/ocr.js', () => ({ ocrImage: vi.fn() }));
vi.mock('../src/content/documents.js', () => ({ readDocument: vi.fn() }));
vi.mock('../src/content/files.js', () => ({ withTempFile: vi.fn() }));
vi.mock('../src/bot/api.js', () => ({ getBotApi: vi.fn(() => ({})) }));

const mockEmbed = vi.mocked(embed);
const mockTranscribe = vi.mocked(transcribe);
const mockGetItem = vi.mocked(getItem);
const mockSetTranscript = vi.mocked(setTranscript);
const mockSetTitle = vi.mocked(setTitle);
const mockWithTempFile = vi.mocked(withTempFile);
const mockClassifyWithTitle = vi.mocked(classifyWithTitle);
const mockClassifyWithTitleAndReminder = vi.mocked(classifyWithTitleAndReminder);
const mockSetReminder = vi.mocked(setReminder);

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
    createdAt: new Date(),
    indexedAt: null,
    remindAt: null,
    remindStatus: null,
    remindCreatedAt: null,
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
  mockClassifyWithTitle.mockResolvedValue({ title: 'Идея про оплату подписки' });
  // detectReminder-путь: дефолт — заголовок есть, напоминания нет (переопределяется в кейсах).
  mockClassifyWithTitleAndReminder.mockResolvedValue({ title: 'Звонок маме', reminder: null });
  // resetAllMocks стёр factory-реализацию — возвращаем tz для detectReminder-ветки.
  vi.mocked(getReminderSettings).mockResolvedValue({ tz: 'Europe/Moscow', defaultHour: 9 });
});

describe('processItem — транскрипция голосовых/видео (STT-ветка)', () => {
  it('войс с файлом: транскрибирует, пишет transcript, classifyWithTitle один раз, ставит title', async () => {
    useLiveItem({ type: 'voice' });
    mockTranscribe.mockResolvedValue('приходил Иванов спрашивал про повышение');

    await processItem('i1');

    expect(mockTranscribe).toHaveBeenCalledTimes(1);
    expect(mockSetTranscript).toHaveBeenCalledWith('i1', 'приходил Иванов спрашивал про повышение');
    expect(mockClassifyWithTitle).toHaveBeenCalledTimes(1);
    expect(mockSetTitle).toHaveBeenCalledWith('i1', 'Идея про оплату подписки');
  });

  it('видео с файлом (≤20MB) транскрибируется так же', async () => {
    useLiveItem({ type: 'video' });
    mockTranscribe.mockResolvedValue('текст из ролика');
    await processItem('i1');
    expect(mockTranscribe).toHaveBeenCalledTimes(1);
    expect(mockSetTranscript).toHaveBeenCalledWith('i1', 'текст из ролика');
  });

  it('transcript уже есть (ретрай джобы) → STT НЕ зовётся повторно (нет двойной оплаты)', async () => {
    useLiveItem({ transcript: 'уже расшифровано', embedding: [0.3, 0.4] });
    await processItem('i1');
    expect(mockWithTempFile).not.toHaveBeenCalled();
    expect(mockTranscribe).not.toHaveBeenCalled();
  });

  it('войс без tgFileId (старая запись / >20MB / gif) → STT не пробуем', async () => {
    useLiveItem({ tgFileId: null });
    await processItem('i1');
    expect(mockWithTempFile).not.toHaveBeenCalled();
  });

  it('transcribe упал (протухший file_id / сеть) → джоба НЕ падает, transcript не пишется', async () => {
    useLiveItem({ type: 'voice' });
    mockTranscribe.mockRejectedValue(new Error('file not found'));
    await expect(processItem('i1')).resolves.toBeDefined();
    expect(mockSetTranscript).not.toHaveBeenCalled();
    expect(mockClassifyWithTitle).not.toHaveBeenCalled();
  });

  it('бюджет-стоп (QuotaExceededError) пробрасывается наружу — worker покажет «лимит исчерпан»', async () => {
    useLiveItem({ type: 'voice' });
    mockTranscribe.mockRejectedValue(new QuotaExceededError(new Date()));
    await expect(processItem('i1')).rejects.toThrow(QuotaExceededError);
  });

  it('пустая транскрипция (инструментал/тишина) → не пишем, не классифицируем, не сбой', async () => {
    useLiveItem({ type: 'voice' });
    mockTranscribe.mockResolvedValue('');
    await expect(processItem('i1')).resolves.toBeDefined();
    expect(mockSetTranscript).not.toHaveBeenCalled();
    expect(mockClassifyWithTitle).not.toHaveBeenCalled();
  });

  it('title уже есть (теги трека «Исполнитель — Название») → LLM-заголовком не затираем', async () => {
    useLiveItem({ title: 'Miyagi — Captain' });
    mockTranscribe.mockResolvedValue('текст песни');
    await processItem('i1');
    expect(mockSetTitle).not.toHaveBeenCalled();
  });

  it('detectReminder: «напомни …» в транскрипте → ставим напоминание (тем же вызовом, без classifyWithTitle)', async () => {
    useLiveItem({ type: 'voice' });
    mockTranscribe.mockResolvedValue('напомни позвонить маме через 5 минут');
    const whenAt = new Date('2030-01-01T12:00:00Z');
    mockClassifyWithTitleAndReminder.mockResolvedValue({ title: 'Позвонить маме', reminder: { whenAt } });

    await processItem('i1', { detectReminder: true });

    expect(mockClassifyWithTitleAndReminder).toHaveBeenCalledTimes(1);
    expect(mockClassifyWithTitle).not.toHaveBeenCalled(); // тот же один вызов, не два
    expect(mockSetReminder).toHaveBeenCalledWith('i1', 1, whenAt);
    expect(mockSetTitle).toHaveBeenCalledWith('i1', 'Позвонить маме');
  });

  it('detectReminder: голос без интента → напоминание НЕ ставится', async () => {
    useLiveItem({ type: 'voice' });
    mockTranscribe.mockResolvedValue('просто мысль вслух про отпуск');
    mockClassifyWithTitleAndReminder.mockResolvedValue({ title: 'Мысль про отпуск', reminder: null });

    await processItem('i1', { detectReminder: true });

    expect(mockClassifyWithTitleAndReminder).toHaveBeenCalledTimes(1);
    expect(mockSetReminder).not.toHaveBeenCalled();
  });

  it('без флага detectReminder → прежний путь classifyWithTitle, напоминание не трогаем', async () => {
    useLiveItem({ type: 'voice' });
    mockTranscribe.mockResolvedValue('напомни позвонить маме через 5 минут');

    await processItem('i1');

    expect(mockClassifyWithTitle).toHaveBeenCalledTimes(1);
    expect(mockClassifyWithTitleAndReminder).not.toHaveBeenCalled();
    expect(mockSetReminder).not.toHaveBeenCalled();
  });
});
