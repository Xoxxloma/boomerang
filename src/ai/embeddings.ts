import OpenAI from 'openai';
import { env, EMBEDDING_DIM } from '../config/env.js';

/**
 * Эмбеддинг-клиент. В v0.1 — OpenAI text-embedding-3-small (1536 dim).
 * Провайдер зафиксирован: смена = переэмбеддить всю базу.
 */
const client = new OpenAI({
  apiKey: env.EMBEDDING_API_KEY,
  baseURL: env.EMBEDDING_BASE_URL,
});

/** Эмбеддинг одного текста. */
export async function embed(text: string): Promise<number[]> {
  const [vec] = await embedBatch([text]);
  if (!vec) throw new Error('Пустой ответ эмбеддинга');
  return vec;
}

/** Батч-эмбеддинг. Пустые строки заменяются пробелом (API не любит пустой input). */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const input = texts.map((t) => (t.trim().length > 0 ? t : ' '));

  const res = await client.embeddings.create({
    model: env.EMBEDDING_MODEL,
    input,
  });

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
