import { chat } from '../ai/llm.js';
import { SYNTHESIZE_SYSTEM, synthesizePrompt } from '../ai/prompts.js';
import { tuning } from '../config/tuning.js';
import { hasRealContent } from '../ingest/extract.js';
import type { Item } from '../db/schema.js';
import type { SearchHit } from './search.js';

export interface Synthesis {
  answer: string;
  /** Источники в порядке нумерации [1..n] — для показа ссылок под ответом. */
  sources: Item[];
}

/** Короткий фрагмент item для контекста LLM. Документам даём больше — у них первые сотни символов
 *  это шапка/реквизиты, фактура дальше по телу; коротким типам хватает 600.
 *  Запись без настоящего содержимого (только имя файла/ссылка) явно помечаем — иначе LLM сочиняет
 *  факты из имени файла (инцидент: «ДДУ зарегистрирован…» из имени pdf). Экспорт — для юнитов. */
export function snippet(it: Item): string {
  const parts = [it.title, it.description, it.rawText, it.ocrText, it.transcript]
    .filter((s): s is string => Boolean(s && s.trim()))
    .join(' — ');
  const cap = it.type === 'document' ? tuning.synthDocChars : tuning.synthSnippetChars;
  const body = parts.slice(0, cap);
  const marked = hasRealContent(it)
    ? body
    : `${body} [содержимое не прочитано — есть только имя файла/ссылка, фактов внутри нет]`;
  return it.url ? `${marked} (${it.url})` : marked;
}

/**
 * Режим 1: собрать СВЯЗНЫЙ ответ со ссылками на источники, а не список (§6).
 * Источники нумеруются; LLM ссылается на них как [n].
 */
export async function synthesize(question: string, hits: SearchHit[], userId?: number): Promise<Synthesis> {
  // L5: ограничиваем число источников — bound на размер промпта (и стоимость синтеза).
  const sources = hits.slice(0, tuning.synthMaxSources).map((h) => h.item);
  const block = sources.map((it, i) => `[${i + 1}] ${snippet(it)}`).join('\n\n');

  const answer = await chat(synthesizePrompt(question, block), {
    system: SYNTHESIZE_SYSTEM,
    temperature: 0.3,
    userId,
    maxTokens: tuning.synthMaxTokens,
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
