import { embed } from '../../ai/embeddings.js';
import { transcribe } from '../../ai/stt.js';
import { describeImage } from '../../ai/vision.js';
import { QuotaExceededError, BudgetExhaustedError } from '../../ai/errors.js';
import {
  getItem,
  setBodyText,
  setDescription,
  setEmbedding,
  setOcrText,
  setRawText,
  setTranscript,
  setTitle,
  markIndexed,
} from '../../db/items.js';
import { buildIndexText } from '../../ingest/extract.js';
import { fetchArticleBody } from '../../content/article.js';
import {
  classifyWithTitle,
  classifyWithTitleAndReminder,
  type DetectedReminder,
} from '../../ingest/classify.js';
import { getReminderSettings, setReminder } from '../../db/reminders.js';
import { ocrImage } from '../../content/ocr.js';
import { readDocument } from '../../content/documents.js';
import { withTempFile } from '../../content/files.js';
import { getBotApi } from '../../bot/api.js';

/** Потолок длины текста на эмбеддинг (символы) — защита от лимита токенов на больших документах. */
const MAX_EMBED_CHARS = 8000;

/**
 * Запись уже ОПЛАЧЕННОГО вектора с парой немедленных ретраев: транзиентный сбой БД (обрыв
 * соединения) не должен выбрасывать вектор и заставлять ретрай джобы платить за embed() заново.
 * Исчерпав попытки — пробрасываем (pg-boss доретраит весь джоб; гейт !emb тогда честно пересчитает).
 */
async function persistEmbedding(itemId: string, emb: number[]): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await setEmbedding(itemId, emb);
      return;
    } catch (err) {
      lastErr = err;
      console.error('setEmbedding failed, retrying', { itemId, attempt, err });
    }
  }
  throw lastErr;
}

/** Итог L2: честный флаг нечитаемого документа (для предупреждения юзеру в финале). */
export interface ProcessResult {
  /** Документ пробовали читать, но тело извлечь не вышло (скан/неподдержанный формат) — юзера надо предупредить. */
  docUnreadable: boolean;
}

/**
 * L2-пайплайн фоном: (OCR/vision для картинок, чтение документа, STT для голоса) → эмбеддинг.
 * Категорий/кластеров больше нет: организация по источнику, поиск — по вектору. На L2 добываем
 * только содержание (description/transcript/тело) и title (показать юзеру) + детект напоминания у голоса.
 */
export async function processItem(
  itemId: string,
  opts?: { detectReminder?: boolean },
): Promise<ProcessResult> {
  let docUnreadable = false;
  let item = await getItem(itemId);
  if (!item) return { docUnreadable };

  // Картинки: OCR + vision-аннотация в ОДНОМ скачивании файла (§3.4). OCR первым и сразу в БД —
  // частичный ретрай (vision упал) не платит за OCR повторно; vision вторым, гейт !description
  // (как !transcript у STT). Vision НЕ заменяет OCR: tesseract бесплатный и читает плотный текст
  // в full-res, low-detail vision видит 512px — OCR даёт буквы, vision даёт смысл.
  // Оба результата — только в индекс, пользователю не показываются (юзеру — title из vision).
  if (item.type === 'image' && item.tgFileId && (!item.ocrText || !item.description)) {
    const itemRef = item;
    const annotation = await withTempFile(getBotApi(), itemRef.tgFileId!, async (path) => {
      let ocr = itemRef.ocrText ?? '';
      if (!ocr) {
        ocr = await ocrImage(path);
        if (ocr) await setOcrText(itemId, ocr);
      }
      if (itemRef.description) return null;
      return describeImage(
        path,
        {
          caption: itemRef.rawText ?? undefined,
          ocr: ocr ? ocr.slice(0, 400) : undefined,
          source: itemRef.sourceChat ?? undefined,
        },
        itemRef.userId,
      );
    }).catch((err) => {
      // Бюджет-стоп НЕ глотаем: worker покажет точное «лимит исчерпан» + кнопку «Повторить».
      if (err instanceof QuotaExceededError || err instanceof BudgetExhaustedError) throw err;
      // Протухший file_id / сеть / vision-сбой — джобу не роняем: подпись/полка ценны и без аннотации.
      console.error('image process error:', { itemId, err });
      return null;
    });
    if (annotation) {
      if (annotation.description) await setDescription(itemId, annotation.description);
      // Заголовок — только если своего нет: осмысленный title не затираем LLM-резюме.
      if (annotation.title && !itemRef.title?.trim()) await setTitle(itemId, annotation.title);
    }
    // description/title/ocr попадут в buildIndexText → в эмбеддинг ниже.
    item = (await getItem(itemId)) ?? item;
  }

  // Документы: извлекаем текст целиком в rawText (§3.3), один раз (до индексации). Файл — временно.
  if (item.type === 'document' && item.tgFileId && !item.indexedAt) {
    // Недоступный файл (протухший file_id, файл другого бота) НЕ роняет джобу: иначе ретраи → DLQ,
    // и запись остаётся вообще без эмбеддинга — а индекс по имени файла/подписи всё ещё ценен.
    const body = await withTempFile(getBotApi(), item.tgFileId, readDocument).catch((err) => {
      console.error('document fetch error:', { itemId, err });
      return '';
    });
    if (body) {
      const caption = item.rawText?.trim();
      await setRawText(itemId, caption ? `${caption}\n\n${body}` : body);
      item = (await getItem(itemId)) ?? item;
    } else {
      // Читать пробовали, тела нет (скан без текстового слоя / неподдержанный формат / файл недоступен) —
      // честно скажем юзеру (worker), а не оставим тихую пустышку «как будто всё ок».
      docUnreadable = true;
    }
  }

  // Голос/аудио/видео: транскрипция аудио(дорожки) в transcript (только индекс, как ocr_text).
  // tgFileId есть ТОЛЬКО у транскрибируемых записей (≤20MB, не gif — см. mediaFileRef); гейт
  // !item.transcript защищает от повторной оплаты STT при ретрае (как эмбеддинг-гейт ниже).
  if ((item.type === 'voice' || item.type === 'video') && item.tgFileId && !item.transcript) {
    const itemRef = item;
    const text = await withTempFile(getBotApi(), itemRef.tgFileId!, (p) => transcribe(p, itemRef.userId)).catch(
      (err) => {
        // Бюджет-стоп НЕ глотаем: worker покажет точное «лимит исчерпан» + кнопку «Повторить».
        if (err instanceof QuotaExceededError || err instanceof BudgetExhaustedError) throw err;
        // Протухший file_id / сеть / rate-limit — джобу не роняем: подпись/теги ценны и без расшифровки.
        console.error('transcribe error:', { itemId, err });
        return '';
      },
    );
    // Пустая транскрипция (инструментал/тишина) — норма, не сбой: не пишем и не предупреждаем.
    if (text) {
      await setTranscript(itemId, text);
      item = (await getItem(itemId)) ?? item;
      // Заголовок одним вызовом по транскрипту (голос/видео без своего названия). Живой одиночный
      // голос/видео: тем же вызовом ловим «напомни …» (на L1 текста ещё не было). now=createdAt —
      // относительные времена («через 5 минут») считаем от момента сообщения, не от L2.
      const itemRef2 = item;
      const res: { title: string | null; reminder?: DetectedReminder | null } = opts?.detectReminder
        ? await classifyWithTitleAndReminder(itemRef2, itemRef2.userId, {
            tz: (await getReminderSettings(itemRef2.userId)).tz,
            now: itemRef2.createdAt,
          })
        : await classifyWithTitle(itemRef2, itemRef2.userId);
      // Заголовок — только если своего нет: теги трека «Исполнитель — Название» не затираем резюме текста песни.
      if (res.title && !item.title?.trim()) {
        await setTitle(itemId, res.title);
        item = (await getItem(itemId)) ?? item; // title попадёт в indexText → в эмбеддинг
      }
      // Напоминание из расшифровки: ставим тихо (status pending) — финал worker допишет «🪃 Верну …»
      // через remindLine. Реклассификация без флага возвращает res без reminder (undefined).
      if (res.reminder) {
        await setReminder(itemId, itemRef2.userId, res.reminder.whenAt);
      }
    }
  }

  // Ссылка: дочитываем тело статьи (readability) и кладём в индекс — чтобы запись находилась по
  // СОДЕРЖАНИЮ, а не только по title/OG. Триггер — наличие url (а не тип 'link': ссылка бывает и в
  // подписи к медиа). Гейт `bodyStatus == null` — идемпотентность ретрая (как !ocrText/!transcript):
  // повторно не качаем. fetch+readability бесплатны; тело вливается в ОДИН эмбеддинг ниже (без второго).
  // Сбой/заглушка/SPA/skip-домен → fetchArticleBody вернёт null → помечаем 'unreadable', откат на OG.
  if (item.url && item.bodyStatus == null) {
    const body = await fetchArticleBody(item.url).catch((err) => {
      console.error('article fetch error:', { itemId, err });
      return null;
    });
    await setBodyText(itemId, body, body ? 'ok' : 'unreadable');
    item = (await getItem(itemId)) ?? item; // body_text попадёт в buildIndexText ниже
  }

  const indexText = buildIndexText(item).slice(0, MAX_EMBED_CHARS);
  // Идемпотентность ретрая: если вектор уже в БД (джоба упала ПОСЛЕ эмбеддинга), НЕ зовём embed()
  // повторно — иначе платный эмбеддинг считается дважды (бюджет-гард).
  let emb: number[] | null = item.embedding ?? null;
  if (!emb && indexText.trim()) {
    emb = await embed(indexText, item.userId);
    await persistEmbedding(itemId, emb); // setEmbedding проставит indexedAt
  }

  // Индексировать было нечего (нет текста на эмбеддинг) — но обработка прошла. Помечаем как
  // обработанное, чтобы такие записи не висели «застрявшими» наравне с реальными сбоями (см. findStuckItems).
  if (!emb) await markIndexed(itemId);

  return { docUnreadable };
}
