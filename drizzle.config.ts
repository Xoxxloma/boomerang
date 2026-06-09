import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://boomerang:boomerang@localhost:5433/boomerang',
  },
  // pgvector — extension создаётся в src/db/migrate.ts до прогона миграций
  extensionsFilters: ['postgres'],
  strict: true,
  verbose: true,
});
