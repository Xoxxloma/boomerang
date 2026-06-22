import type { Item } from '../db/schema.js';
import { listAnniversaryItems, listRecentIndexedItems, findOlderSibling } from '../db/items.js';
import { tuning } from '../config/tuning.js';

/**
 * Эхо (фича C Mini App, режим 2 как PULL): «накопленное само возвращается» — но без пуша в чат
 * (риск спама). Пользователь открывает экран и видит, что хочет вернуться. Сигналы: семантическая
 * перекличка (resonance) + «в этот день» (годовщины). Категорий/«созревших тем» больше нет.
 * Чистая сборка кандидатов: БД-запросы есть, сети/LLM нет.
 */

export type EchoKind = 'on_this_day' | 'resonance';

export interface EchoCard {
  kind: EchoKind;
  /** Основная запись (on_this_day — годовщина; resonance — новая). */
  item?: Item;
  /** Старый сосед, с которым перекликается новая (resonance). */
  relatedItem?: Item;
}

/** Годовщины старше полугода — «в этот день» год+ назад ценнее вчерашнего. */
const ANNIVERSARY_MIN_AGE_DAYS = 180;
/** Окно «недавнего» для отправных точек резонанса. */
const RESONANCE_RECENT_DAYS = 21;

const MAX_ANNIVERSARY = 3;
const MAX_RESONANCE = 4;

/**
 * Собрать ленту возврата: перекличка (самое «живое») → годовщины. Каждая секция ограничена, чтобы
 * лента оставалась дайджестом, а не свалкой.
 */
export async function computeEcho(userId: number): Promise<EchoCard[]> {
  const [resonance, anniversaries] = await Promise.all([
    resonanceCards(userId),
    anniversaryCards(userId),
  ]);
  return [...resonance, ...anniversaries];
}

/** «В этот день»: записи той же календарной даты прошлых лет. */
async function anniversaryCards(userId: number): Promise<EchoCard[]> {
  const items = await listAnniversaryItems(userId, ANNIVERSARY_MIN_AGE_DAYS, MAX_ANNIVERSARY);
  return items.map((item) => ({ kind: 'on_this_day' as const, item }));
}

/**
 * Перекличка: для недавних записей ищем старого семантического соседа (старше порога резонанса,
 * выше порога близости). Дедуп по старому соседу — одна старая запись не всплывает несколько раз.
 */
async function resonanceCards(userId: number): Promise<EchoCard[]> {
  const recent = await listRecentIndexedItems(userId, RESONANCE_RECENT_DAYS, MAX_RESONANCE * 2);
  const cards: EchoCard[] = [];
  const usedOld = new Set<string>();
  for (const item of recent) {
    const emb = item.embedding as number[] | null;
    if (!emb) continue;
    const [old] = await findOlderSibling(userId, item.id, emb, tuning.resonanceMinAgeDays);
    if (!old || usedOld.has(old.id)) continue;
    usedOld.add(old.id);
    cards.push({ kind: 'resonance', item, relatedItem: old });
    if (cards.length >= MAX_RESONANCE) break;
  }
  return cards;
}
