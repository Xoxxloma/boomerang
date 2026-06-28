import type { Api } from 'grammy';
import type { Message } from 'grammy/types';
import { detect, hasMeaningfulCaption, mediaFileRef } from './detect.js';
import { detectReminder } from './classify.js';
import { fetchLinkMeta, hostnameOf } from '../content/og.js';
import { insertItem, findItemByTgMessageId, findDuplicateItem, groupsAlreadyPosted } from '../db/items.js';
import { getReminderSettings, setReminder } from '../db/reminders.js';
import { enqueueProcess, type AckRef } from '../queue/index.js';
import type { Item, NewItem } from '../db/schema.js';

/**
 * Сохраняет одно логическое сообщение как item: дешёвый сигнал по типу → запись → постановка
 * тяжёлого (L2) в фон. Категорий нет (организация по источнику, поиск по вектору) — на живом приёме
 * лишь детектим «напомни …». Без ctx — принимает Api напрямую (хендлер и фоновый флаш альбома).
 */
export async function saveItem(
  api: Api,
  userId: number,
  msg: Message,
  ack?: AckRef,
  opts?: { detectReminder?: boolean },
): Promise<{ item: Item; duplicate: boolean }> {
  const det = detect(msg);

  let title: string | undefined;
  let description: string | undefined;
  let tgFileId: string | undefined;
  let tgFileUniqueId: string | undefined;
  let sttSkipReason: 'too_big' | undefined;

  // Извлекаем id файла/имя документа РАНЬШЕ сетевого fetchLinkMeta: они нужны для дедупа,
  // а при дубле дорогой OG-запрос вообще не делаем.
  if (det.type === 'image') {
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
  } else if (det.type === 'voice' || det.type === 'video') {
    // Голос/аудио/видео: id для транскрипции в L2 (tgFileId есть только у транскрибируемых — ≤20MB,
    // не gif), uid — для дедупа повторных пересылок, title — «Исполнитель — Трек» из тегов аудио.
    const ref = mediaFileRef(msg);
    tgFileId = ref.tgFileId;
    tgFileUniqueId = ref.tgFileUniqueId;
    title = ref.title;
    sttSkipReason = ref.tooBig ? 'too_big' : undefined;
  }

  // Дедуп ДО вставки (§ тезис): тот же пост уже сохранён → не задваиваем, возвращаем существующий.
  // Приоритет ключа — как в балк-дедупе: url → file_unique_id → нормализованный текст.
  // url берём КЛЮЧОМ дедупа только для настоящей ссылки-поста (type 'link'). У медиа-с-подписью
  // det.url теперь тоже бывает (ссылка в подписи — для дочитывания статьи в L2), но идентичность такой
  // записи — это файл/подпись, не url: иначе два разных фото с одной ссылкой-подписью схлопнулись бы.
  // Так дедуп для всех НЕ-link типов остаётся ровно прежним (file_unique_id → текст).
  const dedupUrl = det.type === 'link' ? det.url : undefined;
  const dup = await findDuplicateItem(userId, { url: dedupUrl, fileUid: tgFileUniqueId, text: det.text });
  if (dup) {
    return { item: dup, duplicate: true };
  }

  if (det.type === 'link' && det.url) {
    const meta = await fetchLinkMeta(det.url); // title + OG, тело НЕ читаем
    // Нет вменяемого title (анти-бот сайт отдал заглушку → meta пуста) → фолбэк на хост (avito.ru):
    // полезнее мусорной «Авито — Объявления…» и попадает в индекс (через buildIndexText.title).
    // NB: хост латиницей — запрос кириллицей «авито» к нему не мостит (вне объёма); поиск по подписи работает.
    title = meta.title ?? hostnameOf(det.url);
    description = meta.description;
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
    mediaGroupId: msg.media_group_id ?? null,
  };
  const item = await insertItem(values);

  // detectReminder для голоса/видео: их текст рождается только в L2 (STT) — «напомни …» ловим там по
  // транскрипту (на L1 сигнал пуст). Только живой одиночный приём (флаг), не импорт/burst/альбом.
  const detectVoiceReminder = Boolean(opts?.detectReminder) && (det.type === 'voice' || det.type === 'video');
  // Живой одиночный приём text/link/doc: тем же дешёвым вызовом ловим «напомни …» и молча ставим
  // напоминание (без регекса). Возврат всплывёт на финале L2 (worker.ts). Картинки/голос минуют это.
  if (opts?.detectReminder && !detectVoiceReminder && det.type !== 'image') {
    const { tz } = await getReminderSettings(userId);
    const { reminder } = await detectReminder(item, userId, { tz });
    if (reminder) await setReminder(item.id, userId, reminder.whenAt);
  }
  // ack передаём только для одиночных пересылок — тогда L2 сможет отредактировать приём при сбое.
  // sttSkipReason едет в payload (не вычисляется в L2): там по отсутствию tgFileId большой файл
  // неотличим от gif — gif получил бы ложное предупреждение «сохранил без расшифровки».
  await enqueueProcess(item.id, ack, false, sttSkipReason, detectVoiceReminder);
  return { item, duplicate: false };
}

/** Текст-подтверждение для уже сохранённого поста (дубль): заголовок, если известен. */
export function duplicateText(item: Item): string {
  const name = item.title ? ` — «${truncate(item.title, 80)}»` : '';
  return `Это уже в Бумеранге${name}. Повторно не добавил.`;
}

/** Финальный статус приёма: «✅ Принял — «заголовок»» (если есть title) или просто «✅ Принял». */
export function acceptedText(item: Item): string {
  const title = item.title?.trim();
  return title ? `✅ Принял — «${truncate(title, 80)}»` : '✅ Принял';
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
    let text: string;
    if (existing) {
      text = `✅ Уже сохранил${existing.title ? ` — ${truncate(existing.title, 80)}` : ''}`;
    } else {
      const { item, duplicate } = await saveItem(api, captionMsg.from.id, captionMsg);
      // Тот же контент другим message_id (мимо findItemByTgMessageId) → дубль: не задвоили, сообщаем.
      text = duplicate ? duplicateText(item) : acceptedText(item);
    }
    // Правка ack — best-effort: её падение (протухшее/изменённое сообщение) не должно ронять флаш
    // и гонять ретрай (он бы задвоил уже сохранённое). Без кнопок: управление записью — в карточке
    // события (cardKeyboard), не на сообщении-приёме.
    await api.editMessageText(ackChatId, ackMessageId, text).catch(() => {});
    return;
  }
  // Опоздавший член уже-постнутого альбома: его собратья (с подписью) сохранены прошлым флашем, а этот
  // переклеймил сессию и пришёл один без подписи. Не кладём его отдельной картинкой — это фото поста.
  const m0 = messages.find((m) => m.media_group_id && m.from);
  const gid = m0?.media_group_id;
  if (gid && m0?.from) {
    const posted = await groupsAlreadyPosted(m0.from.id, [gid]);
    if (posted.has(gid)) {
      await api.editMessageText(ackChatId, ackMessageId, '✅ Уже сохранил этот альбом').catch(() => {});
      return;
    }
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

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
