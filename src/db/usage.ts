import { eq, sql } from 'drizzle-orm';
import { db } from './client.js';
import { usageDaily } from './schema.js';
import { getUsageDay, hydrateUsage, snapshotUsage, utcDayKey } from '../ai/usage.js';

/**
 * Персистентность дневного учёта расхода (бюджет-гарды). In-memory счётчики из ai/usage.ts
 * периодически флашатся сюда и регидрируются на старте — чтобы рестарт/деплой не обнулял лимиты.
 */

/** Загрузить сегодняшние суммы из БД в память (на старте бота, до приёма апдейтов). */
export async function rehydrateToday(): Promise<void> {
  const dayKey = utcDayKey(new Date());
  const rows = await db.select().from(usageDaily).where(eq(usageDaily.day, dayKey));
  hydrateUsage(
    dayKey,
    rows.map((r) => ({
      userId: r.userId,
      llmPromptTokens: r.llmPromptTokens,
      llmCompletionTokens: r.llmCompletionTokens,
      embeddingTokens: r.embeddingTokens,
      costUsd: Number(r.costUsd),
    })),
  );
}

/** Сбросить текущие суммы в БД (upsert: память — источник истины для дня). */
export async function flushToday(): Promise<void> {
  const day = getUsageDay();
  const values = snapshotUsage().map((r) => ({
    userId: r.userId,
    day,
    llmPromptTokens: r.llmPromptTokens,
    llmCompletionTokens: r.llmCompletionTokens,
    embeddingTokens: r.embeddingTokens,
    costUsd: String(r.costUsd),
  }));
  await db
    .insert(usageDaily)
    .values(values)
    .onConflictDoUpdate({
      target: [usageDaily.userId, usageDaily.day],
      set: {
        llmPromptTokens: sql`excluded.llm_prompt_tokens`,
        llmCompletionTokens: sql`excluded.llm_completion_tokens`,
        embeddingTokens: sql`excluded.embedding_tokens`,
        costUsd: sql`excluded.cost_usd`,
      },
    });
}
