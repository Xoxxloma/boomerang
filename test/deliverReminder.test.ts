import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deliverReminder } from '../src/reminders/deliver.js';
import { getBotApi } from '../src/bot/api.js';
import type { Item } from '../src/db/schema.js';

// Регресс: тихих часов БОЛЬШЕ НЕТ — напоминание шлётся в любой час (юзер сам выбрал момент). Доставка
// не должна ни откладывать (deferReminder), ни писать в счётчик всплытий (logSurfacing) — это отдельная
// от проактива система. Проверяем сам факт sendMessage и отсутствие зависимостей от времени.
const sendMessage = vi.fn(
  (_chatId: number, _text: string, _opts: Record<string, unknown>): Promise<unknown> => Promise.resolve({}),
);
vi.mock('../src/bot/api.js', () => ({ getBotApi: vi.fn(() => ({ sendMessage })) }));
vi.mock('../src/db/items.js', () => ({ itemDisplayName: vi.fn(() => 'Заголовок') }));

const item = (over: Partial<Item> = {}): Item =>
  ({ id: 'i1', userId: 42, type: 'link', tgMessageId: null, url: 'https://x', rawText: null, ...over }) as Item;

describe('deliverReminder — без тихих часов', () => {
  beforeEach(() => {
    sendMessage.mockClear();
    vi.mocked(getBotApi).mockClear();
  });

  it('шлёт сообщение глубокой ночью (никакого переноса на утро)', async () => {
    await deliverReminder(item());
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(42, expect.any(String), expect.any(Object));
  });

  it('заметка-задача (type=text) — шлёт текст пользователя без reply', async () => {
    await deliverReminder(item({ type: 'text', rawText: 'купить молоко', tgMessageId: 123 }));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [, body, opts] = sendMessage.mock.calls[0]!;
    expect(body).toContain('купить молоко');
    expect(opts).not.toHaveProperty('reply_parameters');
  });

  it('сохранённый контент с tgMessageId — reply к оригиналу', async () => {
    await deliverReminder(item({ type: 'link', tgMessageId: 555 }));
    const [, , opts] = sendMessage.mock.calls[0]!;
    expect(opts).toHaveProperty('reply_parameters');
  });
});
