import { DateTime } from 'luxon';
import { chatJson } from '../ai/llm.js';
import { PARSE_TIME_SYSTEM, parseTimePrompt } from '../ai/prompts.js';
import { tuning } from '../config/tuning.js';

/**
 * Парс свободной строки времени для входа «Своё время» (намерение уже подтверждено кнопкой).
 * LLM решает только «когда», поэтому надёжнее детекта намерения. Любой сбой → whenAt:null (молча).
 */
export interface ParsedTime {
  whenAt: Date | null;
  /** Второй разумный вариант времени суток («в 9» → 9:00/21:00) — для одного инлайн-конфирма. */
  altAt: Date | null;
}

/** ISO со смещением → UTC Date, только если момент в будущем (прошлое отбрасываем). */
function toFutureDate(iso: string | null | undefined, now: Date): Date | null {
  if (!iso) return null;
  const dt = DateTime.fromISO(iso, { setZone: true });
  if (!dt.isValid) return null;
  const at = dt.toUTC().toJSDate();
  return at.getTime() > now.getTime() ? at : null;
}

export async function parseTime(
  text: string,
  tz: string,
  userId: number,
  now: Date = new Date(),
): Promise<ParsedTime> {
  const nowIso = DateTime.fromJSDate(now).setZone(tz).toISO() ?? new Date(now).toISOString();
  try {
    const res = await chatJson<{ whenIso?: string | null; ambiguous?: boolean; altIso?: string | null }>(
      parseTimePrompt(text, nowIso, tuning.remindDefaultHour),
      { system: PARSE_TIME_SYSTEM, temperature: 0, userId, maxTokens: 160 },
    );
    const whenAt = toFutureDate(res.whenIso, now);
    const altAt = res.ambiguous ? toFutureDate(res.altIso, now) : null;
    return { whenAt, altAt };
  } catch {
    return { whenAt: null, altAt: null };
  }
}
