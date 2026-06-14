import { DateTime } from 'luxon';
import { chatJson } from '../ai/llm.js';
import {
  CLASSIFY_SYSTEM,
  classifyPrompt,
  CLASSIFY_TITLE_SYSTEM,
  classifyTitlePrompt,
  CLASSIFY_REMIND_SYSTEM,
  classifyRemindPrompt,
} from '../ai/prompts.js';
import { tuning } from '../config/tuning.js';
import { LINKS_SHELF } from '../cluster/assign.js';
import { buildClassifySignal, isContentlessLink, type Indexable } from './extract.js';

/**
 * L1-классификация по дешёвому сигналу: одна короткая категория (§5 Level 1).
 * Это «ощущение порядка» для человека, НЕ механизм поиска (поиск — по эмбеддингам).
 * В вехе 4 поверх этого появятся кластеры; промах тут не критичен.
 */
export async function classify(it: Indexable, userId: number): Promise<string> {
  // Ссылка-пустышка (ни подписи, ни OG, в URL только хост): темы нет — не зовём LLM гадать по
  // домену (avito → ложная «Недвижимость»), кладём на нейтральную полку. Бесплатно и честно.
  if (isContentlessLink(it)) return LINKS_SHELF;

  const signal = buildClassifySignal(it);
  if (!signal.trim()) return 'Разное';

  try {
    const { category } = await chatJson<{ category: string }>(classifyPrompt(signal), {
      system: CLASSIFY_SYSTEM,
      temperature: 0,
      userId,
      maxTokens: 64,
    });
    return cleanCategory(category);
  } catch (err) {
    console.error('classify error:', err);
    return 'Разное';
  }
}

/** Извлечённое из L1-детекта напоминание («верни в момент T»). */
export interface DetectedReminder {
  whenAt: Date;
}

/** ISO со смещением → UTC Date, только если момент в будущем (прошлое/мусор отбрасываем). */
function isoToFutureDate(iso: string | null | undefined, now: Date): Date | null {
  if (!iso) return null;
  const dt = DateTime.fromISO(iso, { setZone: true });
  if (!dt.isValid) return null;
  const at = dt.toUTC().toJSDate();
  return at.getTime() > now.getTime() ? at : null;
}

/**
 * L1-классификация ПЛЮС детект «это инструкция-напоминание + когда» — одним LLM-вызовом (без доп.
 * запросов и регекса). Зовётся только на живом одиночном сообщении (гейт detectReminder в saveItem),
 * НЕ при импорте. Категория считается как в classify(); reminder — null, если юзер не просил напомнить.
 */
export async function classifyWithReminder(
  it: Indexable,
  userId: number,
  opts: { tz: string; now?: Date },
): Promise<{ category: string; reminder: DetectedReminder | null }> {
  if (isContentlessLink(it)) return { category: LINKS_SHELF, reminder: null };
  const signal = buildClassifySignal(it);
  if (!signal.trim()) return { category: 'Разное', reminder: null };

  const now = opts.now ?? new Date();
  const nowIso = DateTime.fromJSDate(now).setZone(opts.tz).toISO() ?? now.toISOString();
  try {
    const res = await chatJson<{ category: string; reminder?: { whenIso?: string | null } | null }>(
      classifyRemindPrompt(signal, nowIso, tuning.remindDefaultHour),
      { system: CLASSIFY_REMIND_SYSTEM, temperature: 0, userId, maxTokens: 110 },
    );
    const whenAt = isoToFutureDate(res.reminder?.whenIso, now);
    return { category: cleanCategory(res.category), reminder: whenAt ? { whenAt } : null };
  } catch (err) {
    // Фолбэк как у classify: тема «Разное», напоминания нет — пайплайн приёма не падает.
    console.error('classifyWithReminder error:', err);
    return { category: 'Разное', reminder: null };
  }
}

/** Валидация категории из LLM: общая для classify/classifyWithTitle/vision, чтобы правила не разошлись. */
export function cleanCategory(category: string | undefined): string {
  const cleaned = category?.trim();
  return cleaned && cleaned.length <= 40 ? cleaned : 'Разное';
}

/**
 * Категория + заголовок ОДНИМ LLM-вызовом — для голосовых/видео после транскрипции (L2):
 * у них нет своего названия, без title запись в выдаче — пустышка. Один вызов вместо двух —
 * дешевле и не дублирует прогон того же сигнала. Фолбэк как у classify: любой сбой →
 * {'Разное', null} — пайплайн не падает (STT уже отработал, индекс по транскрипту ценен и так).
 */
export async function classifyWithTitle(
  it: Indexable,
  userId: number,
): Promise<{ category: string; title: string | null }> {
  const signal = buildClassifySignal(it);
  if (!signal.trim()) return { category: 'Разное', title: null };

  try {
    const res = await chatJson<{ category: string; title: string }>(classifyTitlePrompt(signal), {
      system: CLASSIFY_TITLE_SYSTEM,
      temperature: 0,
      userId,
      maxTokens: 128,
    });
    const title = res.title?.trim().slice(0, 80) || null;
    return { category: cleanCategory(res.category), title };
  } catch (err) {
    console.error('classifyWithTitle error:', err);
    return { category: 'Разное', title: null };
  }
}
