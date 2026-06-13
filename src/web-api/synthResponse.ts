import { synthesize, extractCitedIndices } from '../retrieval/synthesize.js';
import { breakerState } from '../ai/usage.js';
import { toItemDTO, type ItemDTO } from './serialize.js';
import type { SearchHit } from '../retrieval/search.js';

/** Источник в ответе с его номером [n] (нумерация совпадает с цитатами в тексте синтеза). */
export type NumberedSource = ItemDTO & { index: number };

export interface SynthResponse {
  /** Связный ответ со ссылками [n]; null — синтез недоступен (degraded/сбой), показываем только источники. */
  answer: string | null;
  sources: NumberedSource[];
  /** Номера источников, реально процитированных в answer (их подсвечиваем). */
  cited: number[];
}

/**
 * Общий хвост для /api/search и /api/synthesize (Свести тему): связный синтез по найденным источникам +
 * номера процитированных. Зеркалит respondWithSynthesis из бота: degraded (breaker не normal) и падение
 * LLM → отдаём список источников без ответа (чтение продолжает работать).
 */
export async function buildSynthResponse(
  query: string,
  hits: SearchHit[],
  userId: number,
): Promise<SynthResponse> {
  const numbered = (items: ReturnType<typeof toItemDTO>[]): NumberedSource[] =>
    items.map((dto, i) => ({ index: i + 1, ...dto }));

  if (breakerState() !== 'normal') {
    return { answer: null, sources: numbered(hits.map((h) => toItemDTO(h.item))), cited: [] };
  }

  try {
    const { answer, sources } = await synthesize(query, hits, userId);
    const cited = extractCitedIndices(answer, sources.length);
    return { answer, sources: numbered(sources.map(toItemDTO)), cited };
  } catch (err) {
    console.error('web synthesize error:', err);
    return { answer: null, sources: numbered(hits.map((h) => toItemDTO(h.item))), cited: [] };
  }
}
