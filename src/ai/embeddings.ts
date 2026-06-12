import OpenAI from 'openai';
import { env, EMBEDDING_DIM } from '../config/env.js';
import { enforce, recordUsage } from './usage.js';
import { alertIfUsageMissing } from '../bot/alerts.js';

/**
 * Эмбеддинг-клиент: OpenAI text-embedding-3-small (1536 dim).
 * Модель зафиксирована константой: смена = переэмбеддить всю базу.
 */
const EMBEDDING_MODEL = 'text-embedding-3-small';

const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });

/** Эмбеддинг одного текста. userId — для бюджет-гардов (персональный потолок + атрибуция). */
export async function embed(text: string, userId?: number): Promise<number[]> {
  const [vec] = await embedBatch([text], userId);
  if (!vec) throw new Error('Пустой ответ эмбеддинга');
  return vec;
}

/** Батч-эмбеддинг. Пустые строки заменяются пробелом (API не любит пустой input). */
export async function embedBatch(texts: string[], userId?: number): Promise<number[][]> {
  if (texts.length === 0) return [];
  // Бюджет-гард ДО обращения к API (единая точка енфорса: embed зовёт embedBatch).
  enforce(userId ?? null);
  const input = texts.map((t) => (t.trim().length > 0 ? t : ' '));

  const res = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input,
  });

  const promptTokens = res.usage?.prompt_tokens ?? 0;
  recordUsage(userId ?? null, 'embedding', promptTokens, 0);
  // Нет usage → учёт ослеп. Норма (usage есть) — выходит мгновенно, латентности не добавляет.
  await alertIfUsageMissing('embedding', promptTokens, 0);

  return res.data
    .sort((a, b) => a.index - b.index)
    .map((d) => {
      if (d.embedding.length !== EMBEDDING_DIM) {
        throw new Error(
          `Размерность эмбеддинга ${d.embedding.length} ≠ ожидаемой ${EMBEDDING_DIM}. ` +
            `Проверь модель ${EMBEDDING_MODEL} (embeddings.ts).`,
        );
      }
      return d.embedding as number[];
    });
}
