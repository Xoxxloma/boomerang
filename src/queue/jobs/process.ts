import { embed } from '../../ai/embeddings.js';
import { transcribe } from '../../ai/stt.js';
import { describeImage } from '../../ai/vision.js';
import { QuotaExceededError, BudgetExhaustedError } from '../../ai/errors.js';
import {
  getItem,
  setDescription,
  setEmbedding,
  setOcrText,
  setRawText,
  setTranscript,
  setTitle,
  markIndexed,
} from '../../db/items.js';
import { buildIndexText } from '../../ingest/extract.js';
import { classify, classifyWithTitle } from '../../ingest/classify.js';
import { assignCluster, assignToShelf, IMAGE_SHELF } from '../../cluster/assign.js';
import { maybeSurface } from '../../retrieval/proactive.js';
import { ocrImage } from '../../content/ocr.js';
import { readDocument } from '../../content/documents.js';
import { withTempFile } from '../../content/files.js';
import { getBotApi } from '../../bot/api.js';

/** Потолок длины текста на эмбеддинг (символы) — защита от лимита токенов на больших документах. */
const MAX_EMBED_CHARS = 8000;

/** Итог L2: имя реальной полки (для финализации «Положил в …») + честный флаг нечитаемого документа. */
export interface ProcessResult {
  /** null — картинка/без кластера/cluster_locked: реконсилировать нечего. */
  clusterName: string | null;
  /** Документ пробовали читать, но тело извлечь не вышло (скан/неподдержанный формат) — юзера надо предупредить. */
  docUnreadable: boolean;
}

/**
 * L2-пайплайн фоном: (OCR для картинок) → эмбеддинг → отнесение к кластеру.
 * seedCategory — имя для нового кластера (из L1), чтобы не звать LLM повторно.
 */
export async function processItem(itemId: string, seedCategory: string): Promise<ProcessResult> {
  let docUnreadable = false;
  // L2 добыл НОВЫЙ контент, которого L1 не видел (тело документа; в будущем — транскрипция войса,
  // OCR скана): L1-seed построен по дешёвому сигналу (имя файла) и устарел → перед кластеризацией
  // освежаем категорию тем же дешёвым classify, но уже по обогащённой записи. Общий хук для всех
  // типов с «поздним» контентом — не плодим точечные правила на каждый тип.
  let enriched = false;
  let item = await getItem(itemId);
  if (!item) return { clusterName: null, docUnreadable };

  // Свежая категория, добытая на L2 «поздним» контентом (vision у картинок, транскрипт у голосовых) —
  // мимо общего enriched-хука: тот позвал бы classify ВТОРЫМ вызовом, а у этих типов категория уже
  // пришла из своего LLM-вызова (describeImage/classifyWithTitle) — двойная оплата того же ответа.
  let freshSeed: string | null = null;

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
      if (annotation.category !== 'Разное') freshSeed = annotation.category;
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
      enriched = true; // L1 видел только имя файла — категорию надо освежить по телу
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
      // enriched НЕ взводим: реклассификация уже здесь (одним вызовом с заголовком). Общий
      // enriched-хук позвал бы classify ВТОРОЙ раз по тому же сигналу — двойная оплата того же ответа.
      const res = await classifyWithTitle(item, item.userId);
      // Заголовок — только если своего нет: теги трека «Исполнитель — Название» не затираем резюме текста песни.
      if (res.title && !item.title?.trim()) {
        await setTitle(itemId, res.title);
        item = (await getItem(itemId)) ?? item; // title попадёт в indexText → в эмбеддинг
      }
      if (res.category !== 'Разное') freshSeed = res.category;
    }
  }

  const indexText = buildIndexText(item).slice(0, MAX_EMBED_CHARS);
  // Идемпотентность ретрая: если вектор уже в БД (джоба упала ПОСЛЕ эмбеддинга — напр. в кластеризации
  // / maybeSurface), НЕ зовём embed() повторно — иначе платный эмбеддинг считается дважды (бюджет-гард).
  let emb: number[] | null = item.embedding ?? null;
  if (!emb && indexText.trim()) {
    emb = await embed(indexText, item.userId);
    await setEmbedding(itemId, emb);
  }

  // Имя реальной полки (для шага «Положил в …»). Картинки/без-кластера/locked → null (не финализируем).
  let clusterName: string | null = null;

  if (item.type === 'image' && (!freshSeed || !emb)) {
    // Vision не дал темы (сбой / «Разное» / нечего эмбеддить) — фолбэк-полка «Изображения», как до
    // фичи. Если уже на полке (заливка пачкой проставила cluster заранее) — не переназначаем: этот
    // прогон лишь до-OCR-ил и обновил эмбеддинг, повторный assignToShelf задвоил бы центроид полки.
    if (!item.clusterId) await assignToShelf(item.userId, IMAGE_SHELF, itemId, emb);
  } else if (emb) {
    const withEmb = await getItem(itemId);
    // Гейт идемпотентности: при ретрае (напр. упал maybeSurface) item уже отнесён — повторный
    // assignCluster задвоил бы его в центроиде/размере. Как и на пути картинок (!item.clusterId).
    if (withEmb && !withEmb.clusterId) {
      // Запись обогащена на L2 → освежаем seed по реальному контенту (тело документа даёт «Ремонт»,
      // а не «Документы» из имени файла) — тогда seed-вето в assignCluster сравнивает эмбеддинг с
      // категорией, видевшей ТОТ ЖЕ контент. «Разное» = classify не справился (внутренний фолбэк
      // на любой сбой) — не затираем им осмысленный L1-seed.
      let seed = seedCategory;
      if (freshSeed) {
        // Голос/видео/картинка: категория уже пришла из своего LLM-вызова (STT-ветка / vision) — не дублируем.
        seed = freshSeed;
      } else if (enriched) {
        const fresh = await classify(withEmb, withEmb.userId);
        if (fresh !== 'Разное') seed = fresh;
      }
      const res = await assignCluster(withEmb, seed);
      clusterName = res?.name ?? null;
      // Проактивное всплытие (режим 2) — best-effort: его падение НЕ должно ронять джобу и гонять
      // переотнесение по кругу. Логируем и идём дальше.
      if (res) {
        try {
          await maybeSurface(withEmb, res);
        } catch (err) {
          console.error('maybeSurface error:', err);
        }
      }
    }
  }

  // Индексировать было нечего (нет текста на эмбеддинг) — но обработка прошла. Помечаем как
  // обработанное, чтобы такие записи не висели «застрявшими» наравне с реальными сбоями (см. findStuckItems).
  if (!emb) await markIndexed(itemId);

  return { clusterName, docUnreadable };
}
