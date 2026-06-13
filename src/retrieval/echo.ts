import type { Item } from '../db/schema.js';
import { listClusters } from '../db/clusters.js';
import {
  listClusterContentFields,
  listAnniversaryItems,
  listRecentIndexedItems,
  findOlderSiblingInCluster,
} from '../db/items.js';
import { hasRealContent } from '../ingest/extract.js';
import { IMAGE_SHELF, LINKS_SHELF } from '../cluster/assign.js';
import { tuning } from '../config/tuning.js';

/**
 * Эхо (фича C Mini App, режим 2 как PULL): «накопленное само возвращается» — но без пуша в чат
 * (риск спама). Пользователь открывает экран и видит, что хочет вернуться. Переиспользует те же
 * сигналы, что проактив (maturity/resonance), плюс «в этот день». Чистая сборка кандидатов: БД-запросы
 * есть, сети/LLM нет — синтез запускается отдельно по кнопке «Свести».
 */

export type EchoKind = 'maturity' | 'on_this_day' | 'resonance';

export interface EchoCard {
  kind: EchoKind;
  /** Кластер-источник (для maturity → кнопка «Свести»). */
  clusterId?: string;
  clusterName?: string;
  /** Сколько содержательных записей в теме (maturity). */
  count?: number;
  /** Основная запись (on_this_day — годовщина; resonance — новая). */
  item?: Item;
  /** Старый сосед, с которым перекликается новая (resonance). */
  relatedItem?: Item;
}

/** Полки-свалки без темы: «созревание»/«перекличка» по ним бессмысленны (как в proactive.ts). */
const SHELFLESS = new Set([IMAGE_SHELF, LINKS_SHELF]);

/** Годовщины старше полугода — «в этот день» год+ назад ценнее вчерашнего. */
const ANNIVERSARY_MIN_AGE_DAYS = 180;
/** Окно «недавнего» для отправных точек резонанса. */
const RESONANCE_RECENT_DAYS = 21;

const MAX_MATURITY = 4;
const MAX_ANNIVERSARY = 3;
const MAX_RESONANCE = 4;

/**
 * Собрать ленту возврата для пользователя. Порядок секций: перекличка (самое «живое») → годовщины →
 * созревшие темы. Каждая секция ограничена, чтобы лента оставалась дайджестом, а не свалкой.
 */
export async function computeEcho(userId: number): Promise<EchoCard[]> {
  const [resonance, anniversaries, maturity] = await Promise.all([
    resonanceCards(userId),
    anniversaryCards(userId),
    maturityCards(userId),
  ]);
  return [...resonance, ...anniversaries, ...maturity];
}

/** Созревшие темы: кластеры, где содержательных записей достигло порога — есть что сводить. */
async function maturityCards(userId: number): Promise<EchoCard[]> {
  const clusters = (await listClusters(userId))
    .filter((c) => !SHELFLESS.has(c.name) && c.size >= tuning.maturityThreshold)
    .slice(0, MAX_MATURITY * 2); // запас: часть отсеется по содержательному счёту

  const cards: EchoCard[] = [];
  for (const cl of clusters) {
    const fields = await listClusterContentFields(userId, cl.id);
    const count = fields.filter(hasRealContent).length;
    if (count < tuning.maturityThreshold) continue;
    cards.push({ kind: 'maturity', clusterId: cl.id, clusterName: cl.name, count });
    if (cards.length >= MAX_MATURITY) break;
  }
  return cards;
}

/** «В этот день»: записи той же календарной даты прошлых лет. */
async function anniversaryCards(userId: number): Promise<EchoCard[]> {
  const items = await listAnniversaryItems(userId, ANNIVERSARY_MIN_AGE_DAYS, MAX_ANNIVERSARY);
  return items.map((item) => ({ kind: 'on_this_day' as const, item }));
}

/**
 * Перекличка: для недавних записей ищем старого соседа по кластеру (старше порога резонанса).
 * Дедуп по старому соседу — одна старая запись не всплывает несколько раз.
 */
async function resonanceCards(userId: number): Promise<EchoCard[]> {
  const recent = await listRecentIndexedItems(userId, RESONANCE_RECENT_DAYS, MAX_RESONANCE * 2);
  const cards: EchoCard[] = [];
  const usedOld = new Set<string>();
  for (const item of recent) {
    if (!item.clusterId) continue;
    const emb = item.embedding as number[] | null;
    if (!emb) continue;
    const [old] = await findOlderSiblingInCluster(
      userId,
      item.clusterId,
      item.id,
      emb,
      tuning.resonanceMinAgeDays,
    );
    if (!old || usedOld.has(old.id)) continue;
    usedOld.add(old.id);
    cards.push({ kind: 'resonance', item, relatedItem: old, clusterId: item.clusterId });
    if (cards.length >= MAX_RESONANCE) break;
  }
  return cards;
}
