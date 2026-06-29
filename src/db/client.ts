import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../config/env.js';
import * as schema from './schema.js';

// Один пул на процесс. postgres.js сам управляет соединениями.
// SSL — для облачной БД (Neon/Supabase). max ниже при SSL: free-tier direct-endpoint
// ограничивает число соединений, а свой пул держит ещё и pg-boss.
const queryClient = postgres(env.DATABASE_URL, {
  max: env.DATABASE_SSL ? 5 : 10,
  ssl: env.DATABASE_SSL ? 'require' : false,
});

export const db = drizzle(queryClient, { schema });
export { queryClient };

/** Транзакционный executor drizzle (тот же query-API, что и db) — параметр для callback `db.transaction`. */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** db или активная транзакция — чтобы billing-хелперы работали и снаружи, и внутри одной транзакции. */
export type Executor = typeof db | Tx;
