import type { Api } from 'grammy';
import type { Message } from 'grammy/types';
import { detect, hasMeaningfulCaption } from './detect.js';
import { classify } from './classify.js';
import { fetchLinkMeta } from '../content/og.js';
import { insertItem, findItemByTgMessageId } from '../db/items.js';
import { enqueueProcess, type AckRef } from '../queue/index.js';
import { IMAGE_SHELF } from '../cluster/assign.js';
import { fixKeyboard } from '../bot/handlers/callbacks.js';
import type { Item, NewItem } from '../db/schema.js';

/**
 * Сохраняет одно логическое сообщение как item: дешёвый сигнал по типу → запись → классификация →
 * постановка тяжёлого (L2) в фон. Возвращает item и категорию (для edit сообщения).
 * Без ctx — принимает Api напрямую, чтобы вызываться и из хендлера, и из фонового флаша альбома.
 */
export async function saveItem(
  api: Api,
  userId: number,
  msg: Message,
  ack?: AckRef,
): Promise<{ item: Item; category: string }> {
  const det = detect(msg);

  let title: string | undefined;
  let description: string | undefined;
  let tgFileId: string | undefined;
  let tgFileUniqueId: string | undefined;

  if (det.type === 'link' && det.url) {
    const meta = await fetchLinkMeta(det.url); // title + OG, тело НЕ читаем
    title = meta.title;
    description = meta.description;
  } else if (det.type === 'image') {
    // Файл НЕ качаем — только сохраняем id Telegram; байты возьмём временно при OCR в L2.
    const photo = msg.photo?.[msg.photo.length - 1];
    tgFileId = photo?.file_id;
    tgFileUniqueId = photo?.file_unique_id;
  } else if (det.type === 'document') {
    const doc = msg.document;
    if (doc) {
      tgFileId = doc.file_id; // чтение текста — временно, в L2
      tgFileUniqueId = doc.file_unique_id;
      title = doc.file_name ?? undefined; // имя файла — дешёвый сигнал для классификации
    }
  }

  const values: NewItem = {
    userId,
    type: det.type,
    tgMessageId: msg.message_id,
    sourceChat: det.sourceChat ?? null,
    rawText: det.text || null,
    url: det.url ?? null,
    title: title ?? null,
    description: description ?? null,
    tgFileId: tgFileId ?? null,
    tgFileUniqueId: tgFileUniqueId ?? null,
  };
  const item = await insertItem(values);

  // Картинки — единая полка (§3.4), без LLM-классификации. Остальное — по дешёвому сигналу.
  const category = det.type === 'image' ? IMAGE_SHELF : await classify(item, userId);
  // ack передаём только для одиночных пересылок — тогда L2 сможет отредактировать «Положил…» при сбое.
  await enqueueProcess(item.id, category, ack);
  return { item, category };
}

/**
 * Флаш альбома: есть содержательная подпись → один пост по подписи (медиа игнорируем); иначе —
 * каждый член отдельно. Редактирует ack-сообщение «Принял».
 */
export async function flushAlbumMessages(
  api: Api,
  messages: Message[],
  ackChatId: number,
  ackMessageId: number,
): Promise<void> {
  const captionMsg = messages.find((m) => hasMeaningfulCaption(m.caption));
  if (captionMsg && captionMsg.from) {
    // Идемпотентность: при ретрае флаша член мог уже сохраниться до сбоя — не задваиваем.
    const existing = await findItemByTgMessageId(captionMsg.from.id, captionMsg.message_id);
    let itemId: string;
    let text: string;
    if (existing) {
      // Категория из L1 при ретрае недоступна (не персистится) — нейтральное подтверждение,
      // но всё так же с кнопкой правки категории.
      itemId = existing.id;
      text = `✅ Уже сохранил${existing.title ? ` — ${truncate(existing.title, 80)}` : ''}`;
    } else {
      const { item, category } = await saveItem(api, captionMsg.from.id, captionMsg);
      itemId = item.id;
      text = `✅ Положил в ${label(item.title, category)}`;
    }
    // Правка ack — best-effort: её падение (протухшее/изменённое сообщение) не должно ронять флаш
    // и гонять ретрай (он бы задвоил уже сохранённое).
    await api
      .editMessageText(ackChatId, ackMessageId, text, { reply_markup: fixKeyboard(itemId) })
      .catch(() => {});
    return;
  }
  let n = 0;
  for (const m of messages) {
    if (!m.from) continue;
    if (!(await findItemByTgMessageId(m.from.id, m.message_id))) {
      await saveItem(api, m.from.id, m);
    }
    n += 1;
  }
  await api.editMessageText(ackChatId, ackMessageId, `✅ Принял ${n} медиа (без подписи)`).catch(() => {});
}

export function label(title: string | null, category: string): string {
  return title ? `«${category}» — ${truncate(title, 80)}` : `«${category}»`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
