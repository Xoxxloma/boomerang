import type { Draft } from './draft.js';
import type { Item, NewItem } from '../db/schema.js';
import { insertItems, existingDedupKeys, textKey, groupsAlreadyPosted } from '../db/items.js';
import {
  listClusters,
  createCluster,
  recomputeClusterStats,
  assignItemsToCluster,
  findClusterByNameCI,
} from '../db/clusters.js';
import { embedBatch } from '../ai/embeddings.js';
import { chatJson } from '../ai/llm.js';
import { breakerState } from '../ai/usage.js';
import { QuotaExceededError, BudgetExhaustedError } from '../ai/errors.js';
import { CLUSTER_NAME_SYSTEM, clusterNamePrompt } from '../ai/prompts.js';
import { buildIndexText, type Indexable } from '../ingest/extract.js';
import { IMAGE_SHELF } from '../cluster/assign.js';
import { enqueueProcess } from '../queue/index.js';
import { clusterEmbeddings, type SeedCluster, type ClusterPoint } from '../cluster/batch.js';

/** Страховка от мегаархивов: больше не обрабатываем за один заход (лог при урезании). */
const MAX_ITEMS = 20000;
/** Сколько текстов эмбеддим одним вызовом. */
const EMBED_BATCH = 128;
/** Потолок длины текста на эмбеддинг (символы) — как в L2-пайплайне. */
const MAX_EMBED_CHARS = 8000;
/** Минимальная длина текста, чтобы запись не считалась мусором (если нет url/файла). */
const MIN_TEXT_LEN = 10;
/** Параллельность LLM-нейминга кластеров. */
const NAME_CONCURRENCY = 5;

/** Предел длины сэмпла имён дублей в результате (для UI-списка; счётчики точные). */
export const DUPE_SAMPLE_CAP = 20;

export interface BatchResult {
  saved: number;
  /** Сколько из saved — картинки (на полке «Изображения», не в тематических темах). */
  images: number;
  skipped: number;
  /** Имена постов, уже бывших в Бумеранге (сверка с БД), не добавлены повторно. Сэмпл ≤ DUPE_SAMPLE_CAP. */
  existingDupes: string[];
  /** Имена повторов внутри самой заливки (схлопнуты). Сэмпл ≤ DUPE_SAMPLE_CAP. */
  inBatchDupes: string[];
  /** Точное число «уже было в Бумеранге» (может превышать длину сэмпла). */
  existingDupeCount: number;
  /** Точное число повторов внутри заливки. */
  inBatchDupeCount: number;
  totalClusters: number;
  /**
   * Заливка остановлена на дневном лимите расхода: уже векторизованное вставлено, остаток пула —
   * НЕ обработан и оставлен в буфере (дольётся после сброса лимита). Сигнал для flushBurst не закрывать
   * сессию и не удалять буфер. См. § бюджет-ядро.
   */
  stoppedForBudget?: boolean;
  /** Флаш отложен (альбомы ещё оседали) — буфер/сессия целы, дольём коротким добором. Не финальный итог. */
  deferred?: boolean;
}

export type ProgressFn = (done: number, total: number) => Promise<void> | void;

/**
 * Дедуп внутри пачки: по url, по tg_file_unique_id, по нормализованному тексту. Возвращает уникальные
 * (`kept`) и схлопнутые повторы (`dupes`) — последние идут в отчёт. Пустой текстовый ключ (`t:`) —
 * просто пропуск (это мусор, а не дубль).
 */
export function dedupeDrafts(drafts: Draft[]): { kept: Draft[]; dupes: Draft[] } {
  const seen = new Set<string>();
  const kept: Draft[] = [];
  const dupes: Draft[] = [];
  for (const d of drafts) {
    const key = d.url ? `u:${d.url}` : d.tgFileUniqueId ? `f:${d.tgFileUniqueId}` : `t:${textKey(d.rawText)}`;
    if (key === 't:') continue;
    if (seen.has(key)) {
      dupes.push(d);
      continue;
    }
    seen.add(key);
    kept.push(d);
  }
  return { kept, dupes };
}

/**
 * Выкинуть осколки уже-постнутых альбомов: image-черновик, чей media_group уже стал постом (в прошлой
 * волне/флаше член-с-подписью сохранён), — это «потерянное» фото поста, его НЕ кладём отдельной картинкой.
 * Чистая функция (postedGids — результат groupsAlreadyPosted), тестируется как dedupeDrafts.
 */
export function dropPostedStragglers(drafts: Draft[], postedGids: Set<string>): Draft[] {
  return drafts.filter((d) => !(d.type === 'image' && d.mediaGroupId && postedGids.has(d.mediaGroupId)));
}

/** Короткое имя черновика для отчёта о дублях (заголовок → начало текста → url). Аналог itemDisplayName. */
export function draftDisplayName(d: Draft): string {
  return d.title?.trim() || d.rawText?.trim().slice(0, 60) || d.url || 'без названия';
}

const EMOJI_PUNCT_ONLY = /^[\p{Emoji}\p{P}\s\d]*$/u;

/** Мусор: нет ни url, ни файла, а текст слишком короткий/пустой/из одних эмодзи. */
export function isNoise(d: Draft): boolean {
  if (d.url || d.tgFileUniqueId) return false;
  const t = (d.rawText ?? '').trim();
  if (t.length < MIN_TEXT_LEN) return true;
  if (EMOJI_PUNCT_ONLY.test(t)) return true;
  return false;
}

function sampleTextOf(it: Item): string {
  return (it.title ?? it.rawText ?? it.url ?? '').slice(0, 120);
}

/** Draft в форме Indexable для buildIndexText (полей description/ocr/transcript у черновика нет). */
function draftIndexable(d: Draft): Indexable {
  return {
    type: d.type,
    url: d.url,
    title: d.title,
    description: null,
    rawText: d.rawText,
    ocrText: null,
    transcript: null,
    sourceChat: d.sourceChat,
  };
}

/** Имя кластера по образцам (1 LLM-вызов). Фолбэк — «Разное». В degraded/paused LLM не зовём. */
async function nameCluster(samples: string[], userId: number): Promise<string> {
  if (samples.length === 0) return 'Разное';
  // Дорогая генерация: в degraded/paused пропускаем LLM, новый кластер получает нейтральное имя.
  if (breakerState() !== 'normal') return 'Разное';
  try {
    const { category } = await chatJson<{ category: string }>(clusterNamePrompt(samples), {
      system: CLUSTER_NAME_SYSTEM,
      temperature: 0,
      userId,
      maxTokens: 64,
    });
    const cleaned = category?.trim();
    return cleaned && cleaned.length <= 40 ? cleaned : 'Разное';
  } catch (err) {
    console.error('nameCluster error:', err);
    return 'Разное';
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (it: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const cur = i++;
      out[cur] = await fn(items[cur]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Батч-заливка избранного (всплеск пересылок или JSON-экспорт): дедуп → шумоотсев → bulk insert →
 * батч-эмбеддинги → батч-кластеризация → нейминг новых кластеров. На заливке только дешёвый сигнал
 * (OG/OCR/чтение файлов — лениво/по запросу). Поиск/синтез по залитому работают сразу.
 */
export async function batchIngest(userId: number, drafts: Draft[], onProgress?: ProgressFn): Promise<BatchResult> {
  const total = drafts.length;
  let pool = drafts;

  // Дроп осколков уже-постнутых альбомов ДО дедупа/шумоотсева: иначе одно фото поста, чей член-с-подписью
  // обработан в прошлой волне, уехало бы отдельной картинкой на полку (прод-баг «3 по темам + 1 картинок»).
  const strayGids = [
    ...new Set(pool.filter((d) => d.type === 'image' && d.mediaGroupId).map((d) => d.mediaGroupId!)),
  ];
  if (strayGids.length > 0) {
    const posted = await groupsAlreadyPosted(userId, strayGids);
    if (posted.size > 0) pool = dropPostedStragglers(pool, posted);
  }

  if (pool.length > MAX_ITEMS) {
    console.warn(`batchIngest: пачка ${pool.length} > MAX_ITEMS ${MAX_ITEMS}, беру первые ${MAX_ITEMS}`);
    pool = pool.slice(0, MAX_ITEMS);
  }

  const dedup = dedupeDrafts(pool);
  pool = dedup.kept;
  // Сэмплы имён для отчёта (счётчики — точные, сэмпл обрезаем для UI).
  const inBatchDupeCount = dedup.dupes.length;
  const inBatchDupes = dedup.dupes.slice(0, DUPE_SAMPLE_CAP).map(draftDisplayName);

  const existing = await existingDedupKeys(userId);
  const existingDupesDrafts: Draft[] = [];
  // Сверка с БД по той же приоритетности, что dedupeDrafts: url → file → текст. Текст-сверка делает
  // повторный залив тех же постов-без-ссылки идемпотентным (раньше задваивались). Попавшие в БД — в отчёт.
  pool = pool.filter((d) => {
    const isDup = d.url
      ? existing.urls.has(d.url)
      : d.tgFileUniqueId
        ? existing.fileUids.has(d.tgFileUniqueId)
        : (() => {
            const t = textKey(d.rawText);
            return Boolean(t && existing.texts.has(t));
          })();
    if (isDup) existingDupesDrafts.push(d);
    return !isDup;
  });
  pool = pool.filter((d) => !isNoise(d));

  const existingDupeCount = existingDupesDrafts.length;
  const existingDupes = existingDupesDrafts.slice(0, DUPE_SAMPLE_CAP).map(draftDisplayName);
  const dupeInfo = { existingDupes, inBatchDupes, existingDupeCount, inBatchDupeCount };

  const skipped = total - pool.length;
  if (pool.length === 0) {
    const totalClusters = (await listClusters(userId)).length;
    return { saved: 0, images: 0, skipped, totalClusters, ...dupeInfo };
  }

  // Эмбеддинги считаем ДО вставки: это самый дорогой и сетевой шаг (OpenAI через VPN нестабилен).
  // Если он упадёт — в БД ещё ничего не записано, ретрай чист и не остаётся items-сирот без вектора.
  const embByIndex: (number[] | null)[] = new Array(pool.length).fill(null);
  let done = 0;
  let stoppedForBudget = false;
  let processedCount = pool.length; // сколько записей пула успели векторизовать (для обрезки при стопе)
  for (let i = 0; i < pool.length; i += EMBED_BATCH) {
    const chunk = pool.slice(i, i + EMBED_BATCH);
    const withText = chunk
      .map((d, j) => ({ idx: i + j, text: buildIndexText(draftIndexable(d)).slice(0, MAX_EMBED_CHARS) }))
      .filter((x) => x.text.trim());
    if (withText.length > 0) {
      try {
        const vecs = await embedBatch(withText.map((x) => x.text), userId);
        withText.forEach((x, k) => {
          embByIndex[x.idx] = vecs[k]!;
        });
      } catch (err) {
        // Бюджет исчерпан посреди заливки: НЕ теряем уже посчитанное и НЕ платим за выброшенное.
        // Обрезаем пул до полностью векторизованных чанков [0, i), вставляем их; остаток остаётся в
        // буфере (flushBurst его не удалит) — дольём после сброса лимита, дедуп не даст переэмбеддить.
        // Прочие сбои (сеть/API) пробрасываем как раньше: в БД ещё пусто, ретрай чист.
        if (err instanceof QuotaExceededError || err instanceof BudgetExhaustedError) {
          stoppedForBudget = true;
          processedCount = i;
          break;
        }
        throw err;
      }
    }
    done += chunk.length;
    await onProgress?.(done, pool.length);
  }

  if (processedCount < pool.length) pool = pool.slice(0, processedCount);
  if (pool.length === 0) {
    // Лимит исчерпан на первом же чанке — ничего не векторизовали, вставлять нечего.
    const totalClusters = (await listClusters(userId)).length;
    return { saved: 0, images: 0, skipped, totalClusters, stoppedForBudget, ...dupeInfo };
  }

  // Вставка с уже готовым эмбеддингом одним полем (indexedAt — раз вектор есть, L2 для текста не нужен).
  const now = new Date();
  const values: NewItem[] = pool.map((d, idx) => ({
    userId,
    type: d.type,
    tgMessageId: d.tgMessageId,
    sourceChat: d.sourceChat,
    rawText: d.rawText,
    url: d.url,
    title: d.title,
    tgFileId: d.tgFileId,
    tgFileUniqueId: d.tgFileUniqueId,
    mediaGroupId: d.mediaGroupId,
    embedding: embByIndex[idx],
    indexedAt: embByIndex[idx] ? now : null,
  }));
  const inserted = await insertItems(values);

  // Карта itemId→эмбеддинг (по индексу: insertItems сохраняет порядок) — для кластеризации.
  const embByItem = new Map<string, number[]>();
  inserted.forEach((it, idx) => {
    const e = embByIndex[idx];
    if (e) embByItem.set(it.id, e);
  });

  // Картинки — на единую полку «Изображения» (§3.4), без тематического дробления.
  const imageItems = inserted.filter((it) => it.type === 'image');
  await assignImages(userId, imageItems);

  // Остальное с эмбеддингом — батч-кластеризация по темам.
  const points: ClusterPoint[] = inserted
    .filter((it) => it.type !== 'image' && embByItem.has(it.id))
    .map((it) => ({ itemId: it.id, emb: embByItem.get(it.id)!, sampleText: sampleTextOf(it) }));
  await clusterThematic(userId, points);

  // Картинки с файлом — фоновый OCR (§3.4): иначе залитые пачкой картинки не искались бы по тексту
  // (в отличие от одиночной пересылки). Ставим В КОНЦЕ — clusterId уже проставлен assignImages,
  // поэтому processItem только до-OCR-ит и обновит эмбеддинг, без повторного отнесения к полке.
  for (const it of imageItems) {
    if (it.tgFileId) await enqueueProcess(it.id, IMAGE_SHELF);
  }

  const totalClusters = (await listClusters(userId)).length;
  return { saved: inserted.length, images: imageItems.length, skipped, totalClusters, stoppedForBudget, ...dupeInfo };
}

/** Все картинки пачки → полка «Изображения» (find-or-create), один UPDATE + пересчёт статистики. */
async function assignImages(userId: number, imageItems: Item[]): Promise<void> {
  if (imageItems.length === 0) return;
  const ids = imageItems.map((it) => it.id);
  const shelf = (await listClusters(userId)).find((c) => c.name === IMAGE_SHELF);
  const clusterId = shelf ? shelf.id : (await createCluster(userId, IMAGE_SHELF, null)).id;
  await assignItemsToCluster(ids, clusterId);
  // Центроид/size — от истины: среднее по фактическим эмбеддингам полки. На заливке картинки обычно
  // без подписи (эмбеддинг появится позже из OCR), тогда avg → NULL: null-центроид на полке безвреден
  // (поиск — по эмбеддингам item, в тематическую кластеризацию полка не входит).
  await recomputeClusterStats(clusterId);
}

/** Батч-кластеризация тематических записей с подгрузкой существующих кластеров как стартовых центроидов. */
async function clusterThematic(userId: number, points: ClusterPoint[]): Promise<void> {
  if (points.length === 0) return;

  const seeds: SeedCluster[] = (await listClusters(userId))
    .filter((c) => c.name !== IMAGE_SHELF && c.centroid)
    .map((c) => ({ id: c.id, centroid: c.centroid as number[], size: c.size }));

  const plan = clusterEmbeddings(seeds, points);

  // Дозаливаем в существующие кластеры; центроид/size — пересчётом от истины (один на кластер).
  for (const a of plan.toExisting) {
    await assignItemsToCluster(a.itemIds, a.clusterId);
    await recomputeClusterStats(a.clusterId);
  }

  // Новые группы: нейминг (параллельно), затем создание/мерж по имени.
  const names = await mapLimit(plan.newGroups, NAME_CONCURRENCY, (g) => nameCluster(g.sampleTexts, userId));
  for (let i = 0; i < plan.newGroups.length; i++) {
    const g = plan.newGroups[i]!;
    const name = names[i]!;
    const byName = await findClusterByNameCI(userId, name);
    if (byName) {
      await assignItemsToCluster(g.itemIds, byName.id);
      await recomputeClusterStats(byName.id);
    } else {
      const created = await createCluster(userId, name, g.centroid);
      await assignItemsToCluster(g.itemIds, created.id);
      await recomputeClusterStats(created.id);
    }
  }
}
