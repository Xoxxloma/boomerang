import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

/**
 * Применяет миграции из ./drizzle.
 * Инфраструктурный скрипт: нужен только DATABASE_URL, без полной валидации env
 * (BOT_TOKEN/ключи для миграции не требуются).
 * pgvector-расширение должно существовать ДО создания vector-колонок и HNSW-индексов,
 * поэтому включаем его первым отдельным statement.
 */
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL не задан');
  // SSL включаем по тому же флагу, что и основной пул (см. config/env.ts), но читаем
  // напрямую из process.env — скрипт намеренно не тащит полную валидацию env.
  const sql = postgres(url, {
    max: 1,
    ssl: process.env.DATABASE_SSL === 'true' ? 'require' : false,
  });
  try {
    await sql`CREATE EXTENSION IF NOT EXISTS vector`;
    const db = drizzle(sql);
    await migrate(db, { migrationsFolder: './drizzle' });
    console.log('✅ Миграции применены');
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error('❌ Ошибка миграции:', err);
  process.exit(1);
});
