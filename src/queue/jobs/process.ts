import { embed } from '../../ai/embeddings.js';
import { getItem, setEmbedding, setOcrText, setRawText, markIndexed } from '../../db/items.js';
import { buildIndexText } from '../../ingest/extract.js';
import { assignCluster, assignToShelf, IMAGE_SHELF } from '../../cluster/assign.js';
import { maybeSurface } from '../../retrieval/proactive.js';
import { ocrImage } from '../../content/ocr.js';
import { readDocument } from '../../content/documents.js';
import { withTempFile } from '../../content/files.js';
import { getBotApi } from '../../bot/api.js';

/** Потолок длины текста на эмбеддинг (символы) — защита от лимита токенов на больших документах. */
const MAX_EMBED_CHARS = 8000;

/**
 * L2-пайплайн фоном: (OCR для картинок) → эмбеддинг → отнесение к кластеру.
 * seedCategory — имя для нового кластера (из L1), чтобы не звать LLM повторно.
 */
export async function processItem(itemId: string, seedCategory: string): Promise<void> {
  let item = await getItem(itemId);
  if (!item) return;

  // Картинки: OCR в ocr_text (только индекс, §3.4). Файл качаем во временный и сразу удаляем.
  if (item.type === 'image' && item.tgFileId && !item.ocrText) {
    const text = await withTempFile(getBotApi(), item.tgFileId, ocrImage);
    if (text) {
      await setOcrText(itemId, text);
      item = (await getItem(itemId)) ?? item;
    }
  }

  // Документы: извлекаем текст целиком в rawText (§3.3), один раз (до индексации). Файл — временно.
  if (item.type === 'document' && item.tgFileId && !item.indexedAt) {
    const body = await withTempFile(getBotApi(), item.tgFileId, readDocument);
    if (body) {
      const caption = item.rawText?.trim();
      await setRawText(itemId, caption ? `${caption}\n\n${body}` : body);
      item = (await getItem(itemId)) ?? item;
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
      const res = await assignCluster(withEmb, seedCategory);
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
}
