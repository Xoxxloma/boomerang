import 'dotenv/config';
import { z } from 'zod';

/**
 * Единая точка чтения и валидации окружения. Все поля ОБЯЗАТЕЛЬНЫ, фолбэков и
 * опциональных ключей нет: пустое поле — ошибка на старте, а не молча выключенная фича.
 * OPENAI_API_KEY питает LLM, эмбеддинги и vision; STT_API_KEY — Groq whisper
 * (ключ OpenAI туда не подходит). Базовые URL и имена моделей — константы в src/ai/*.
 */
const raw = {
  BOT_TOKEN: process.env.BOT_TOKEN,
  DATABASE_URL: process.env.DATABASE_URL,
  // Включать SSL для подключения к БД (облако: Neon/Supabase требуют). Локальный docker — false.
  DATABASE_SSL: process.env.DATABASE_SSL,
  // LLM + эмбеддинги + vision (api.openai.com).
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  // STT (транскрипция голосовых/аудио/видео): Groq whisper, НЕ OpenAI.
  STT_API_KEY: process.env.STT_API_KEY,
  // Кому слать алерты о критичных сбоях (бюджет-гард ослеп, регидрация упала). CSV из tg-id.
  ADMIN_IDS: process.env.ADMIN_IDS,
};

const schema = z.object({
  BOT_TOKEN: z.string().min(1, 'BOT_TOKEN обязателен (получить у @BotFather)'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL обязателен'),
  DATABASE_SSL: z
    .string()
    .optional()
    .default('false')
    .transform((v) => v === 'true'),
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY обязателен (LLM + эмбеддинги + vision)'),
  STT_API_KEY: z.string().min(1, 'STT_API_KEY обязателен (Groq whisper, https://console.groq.com)'),
  ADMIN_IDS: z
    .string()
    .min(1, 'ADMIN_IDS обязателен (tg-id админов через запятую)')
    .transform((s) =>
      s
        .split(',')
        .map((x) => Number(x.trim()))
        .filter((n) => Number.isFinite(n) && n > 0),
    ),
});

const parsed = schema.safeParse(raw);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Некорректное окружение (.env):\n${issues}`);
}

export const env = parsed.data;

/** Размерность эмбеддингов text-embedding-3-small — зашита в схему БД (см. db/schema.ts). */
export const EMBEDDING_DIM = 1536;
