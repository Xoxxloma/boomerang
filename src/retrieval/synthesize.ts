import { chat } from '../ai/llm.js';
import { SYNTHESIZE_SYSTEM, synthesizePrompt } from '../ai/prompts.js';
import type { Item } from '../db/schema.js';
import type { SearchHit } from './search.js';

export interface Synthesis {
  answer: string;
  /** Источники в порядке нумерации [1..n] — для показа ссылок под ответом. */
  sources: Item[];
}

/** Короткий фрагмент item для контекста LLM. */
function snippet(it: Item): string {
  const parts = [it.title, it.description, it.rawText, it.ocrText, it.transcript]
    .filter((s): s is string => Boolean(s && s.trim()))
    .join(' — ');
  const body = parts.slice(0, 600);
  return it.url ? `${body} (${it.url})` : body;
}

/**
 * Режим 1: собрать СВЯЗНЫЙ ответ со ссылками на источники, а не список (§6).
 * Источники нумеруются; LLM ссылается на них как [n].
 */
export async function synthesize(question: string, hits: SearchHit[]): Promise<Synthesis> {
  const sources = hits.map((h) => h.item);
  const block = sources.map((it, i) => `[${i + 1}] ${snippet(it)}`).join('\n\n');

  const answer = await chat(synthesizePrompt(question, block), {
    system: SYNTHESIZE_SYSTEM,
    temperature: 0.3,
  });

  return { answer, sources };
}

/**
 * Номера [n], которые синтез реально процитировал. Только их показываем как источники —
 * иначе в список попадают найденные, но неиспользованные (и нерелевантные) item.
 */
export function extractCitedIndices(answer: string, count: number): number[] {
  const seen = new Set<number>();
  for (const m of answer.matchAll(/\[(\d+)\]/g)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= count) seen.add(n);
  }
  return [...seen].sort((a, b) => a - b);
}

/** Короткое имя источника для подписи кнопки. */
export function sourceName(it: Item): string {
  const raw = it.title ?? it.rawText ?? it.url ?? 'без названия';
  return raw.trim().slice(0, 45);
}
