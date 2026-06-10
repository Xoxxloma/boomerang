import 'dotenv/config';
import { z } from 'zod';

/**
 * Единая точка чтения и валидации окружения.
 * В v0.1 LLM и эмбеддинги идут на OpenAI (бот хостится на зарубежном VPS, гео-доступ ок).
 * Если отдельные LLM_/EMBEDDING_ ключи не заданы — падаем на общий OPENAI_API_KEY.
 * Провайдеры OpenAI-совместимы: смена = *_BASE_URL + *_MODEL в .env, без правок кода.
 */
const raw = {
  BOT_TOKEN: process.env.BOT_TOKEN,
  DATABASE_URL: process.env.DATABASE_URL,
  // Включать SSL для подключения к БД (облако: Neon/Supabase требуют). Локальный docker — без SSL.
  DATABASE_SSL: process.env.DATABASE_SSL,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  // Кому слать алерты о критичных сбоях (бюджет-гард ослеп, регидрация упала). CSV из tg-id. Пусто → молчим.
  ADMIN_IDS: process.env.ADMIN_IDS,

  LLM_API_KEY: process.env.LLM_API_KEY || process.env.OPENAI_API_KEY,
  LLM_BASE_URL: process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
  LLM_MODEL: process.env.LLM_MODEL || 'gpt-4o-mini',

  EMBEDDING_API_KEY: process.env.EMBEDDING_API_KEY || process.env.OPENAI_API_KEY,
  EMBEDDING_BASE_URL: process.env.EMBEDDING_BASE_URL || 'https://api.openai.com/v1',
  EMBEDDING_MODEL: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
};

const schema = z.object({
  BOT_TOKEN: z.string().min(1, 'BOT_TOKEN обязателен (получить у @BotFather)'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL обязателен'),
  DATABASE_SSL: z
    .string()
    .optional()
    .default('false')
    .transform((v) => v === 'true'),

  LLM_API_KEY: z.string().min(1, 'LLM_API_KEY или OPENAI_API_KEY обязателен'),
  LLM_BASE_URL: z.string().url(),
  LLM_MODEL: z.string().min(1),

  EMBEDDING_API_KEY: z.string().min(1, 'EMBEDDING_API_KEY или OPENAI_API_KEY обязателен'),
  EMBEDDING_BASE_URL: z.string().url(),
  EMBEDDING_MODEL: z.string().min(1),

  // Опционально: список tg-id админов через запятую для алертов. Пусто/не задано → [] (алерты молчат).
  ADMIN_IDS: z
    .string()
    .optional()
    .default('')
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
