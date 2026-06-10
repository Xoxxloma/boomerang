import OpenAI from 'openai';
import { env, EMBEDDING_DIM } from '../config/env.js';
import { enforce, recordUsage } from './usage.js';
import { alertIfUsageMissing } from '../bot/alerts.js';

/**
 * Эмбеддинг-клиент. В v0.1 — OpenAI text-embedding-3-small (1536 dim).
 * Провайдер зафиксирован: смена = переэмбеддить всю базу.
 */
const client = new OpenAI({
  apiKey: env.EMBEDDING_API_KEY,
  baseURL: env.EMBEDDING_BASE_URL,
});

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
    model: env.EMBEDDING_MODEL,
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
            `Проверь EMBEDDING_MODEL.`,
        );
      }
      return d.embedding as number[];
    });
}
