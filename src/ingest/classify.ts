import { DateTime } from 'luxon';
import { chatJson } from '../ai/llm.js';
import {
  TITLE_SYSTEM,
  titlePrompt,
  REMIND_SYSTEM,
  remindPrompt,
  TITLE_REMIND_SYSTEM,
  titleRemindPrompt,
} from '../ai/prompts.js';
import { tuning } from '../config/tuning.js';
import { buildClassifySignal, type Indexable } from './extract.js';

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
 * Детект «это инструкция-напоминание + когда» одним LLM-вызовом (без регекса). Зовётся только на живом
 * одиночном сообщении (гейт detectReminder в saveItem), НЕ при импорте. Категорий больше нет — определяем
 * только напоминание; reminder = null, если юзер не просил напомнить. Любой сбой → null (приём не падает).
 */
export async function detectReminder(
  it: Indexable,
  userId: number,
  opts: { tz: string; now?: Date },
): Promise<{ reminder: DetectedReminder | null }> {
  const signal = buildClassifySignal(it);
  if (!signal.trim()) return { reminder: null };

  const now = opts.now ?? new Date();
  const nowIso = DateTime.fromJSDate(now).setZone(opts.tz).toISO() ?? now.toISOString();
  try {
    const res = await chatJson<{ reminder?: { whenIso?: string | null } | null }>(
      remindPrompt(signal, nowIso, tuning.remindDefaultHour),
      { system: REMIND_SYSTEM, temperature: 0, userId, maxTokens: 80 },
    );
    const whenAt = isoToFutureDate(res.reminder?.whenIso, now);
    return { reminder: whenAt ? { whenAt } : null };
  } catch (err) {
    console.error('detectReminder error:', err);
    return { reminder: null };
  }
}

/**
 * Заголовок ОДНИМ LLM-вызовом — для голосовых/видео после транскрипции (L2): у них нет своего названия,
 * без title запись в выдаче — пустышка. Фолбэк: любой сбой → null (пайплайн не падает, индекс по
 * транскрипту ценен и так).
 */
export async function classifyWithTitle(
  it: Indexable,
  userId: number,
): Promise<{ title: string | null }> {
  const signal = buildClassifySignal(it);
  if (!signal.trim()) return { title: null };

  try {
    const res = await chatJson<{ title: string }>(titlePrompt(signal), {
      system: TITLE_SYSTEM,
      temperature: 0,
      userId,
      maxTokens: 96,
    });
    const title = res.title?.trim().slice(0, 80) || null;
    return { title };
  } catch (err) {
    console.error('classifyWithTitle error:', err);
    return { title: null };
  }
}

/**
 * То же, что classifyWithTitle (заголовок для голоса/видео в L2), ПЛЮС детект «это напоминание + когда» —
 * одним LLM-вызовом. Нужно для голосовых: их текст появляется только после STT (на L1 детектить нечего),
 * а отдельный вызов ради reminder был бы лишней оплатой того же сигнала. now — опорное «сейчас» для
 * относительных времён («через 5 минут»): передаём момент сообщения (item.createdAt), не текущий, чтобы
 * задержка очереди/STT не съела минуты. Фолбэк как у classifyWithTitle.
 */
export async function classifyWithTitleAndReminder(
  it: Indexable,
  userId: number,
  opts: { tz: string; now: Date },
): Promise<{ title: string | null; reminder: DetectedReminder | null }> {
  const signal = buildClassifySignal(it);
  if (!signal.trim()) return { title: null, reminder: null };

  const nowIso = DateTime.fromJSDate(opts.now).setZone(opts.tz).toISO() ?? opts.now.toISOString();
  try {
    const res = await chatJson<{
      title: string;
      reminder?: { whenIso?: string | null } | null;
    }>(titleRemindPrompt(signal, nowIso, tuning.remindDefaultHour), {
      system: TITLE_REMIND_SYSTEM,
      temperature: 0,
      userId,
      maxTokens: 110,
    });
    const title = res.title?.trim().slice(0, 80) || null;
    // Прошлое/мусор отбрасываем относительно РЕАЛЬНОГО сейчас (now() по умолчанию), не относительно opts.now.
    const whenAt = isoToFutureDate(res.reminder?.whenIso, new Date());
    return { title, reminder: whenAt ? { whenAt } : null };
  } catch (err) {
    console.error('classifyWithTitleAndReminder error:', err);
    return { title: null, reminder: null };
  }
}
