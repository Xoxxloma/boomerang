import { embed } from '../../ai/embeddings.js';
import { getItem, setEmbedding, setOcrText, setRawText, markIndexed } from '../../db/items.js';
import { buildIndexText } from '../../ingest/extract.js';
import { classify } from '../../ingest/classify.js';
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

  // Картинки: OCR в ocr_text (только индекс, §3.4). Файл качаем во временный и сразу удаляем.
  // Недоступный файл не роняет джобу (как у документов): подпись/полка ценны и без OCR.
  if (item.type === 'image' && item.tgFileId && !item.ocrText) {
    const text = await withTempFile(getBotApi(), item.tgFileId, ocrImage).catch((err) => {
      console.error('image fetch error:', { itemId, err });
      return '';
    });
    if (text) {
      await setOcrText(itemId, text);
      item = (await getItem(itemId)) ?? item;
    }
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

  if (item.type === 'image') {
    // Все картинки — на одну полку, без тематического дробления. Если уже на полке (заливка пачкой
    // проставила cluster заранее) — не переназначаем: этот прогон лишь до-OCR-ил и обновил эмбеддинг
    // (setEmbedding выше), повторный assignToShelf задвоил бы размер/центроид полки.
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
      if (enriched) {
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
