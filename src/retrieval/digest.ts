import { and, desc, eq, gt, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { items, clusters, type Item } from '../db/schema.js';
import { chat } from '../ai/llm.js';
import { breakerState } from '../ai/usage.js';
import { tuning } from '../config/tuning.js';
import { DIGEST_SYSTEM, digestPrompt } from '../ai/prompts.js';

interface Theme {
  name: string;
  count: number;
  examples: string[];
}

function titleOf(it: Item): string {
  return (it.title ?? it.rawText ?? it.url ?? 'без названия').slice(0, 80);
}

/**
 * Режим 3 (§6): дайджест «вот темы, которые тебя зацепили за период».
 * Группируем сохранённое за N дней по кластерам, верх — самые наполненные темы,
 * затем лёгкая LLM-формулировка (1 вызов). Возвращаем готовый текст для отправки.
 */
export async function buildDigest(userId: number, days = 7): Promise<string> {
  const rows = await db
    .select({ item: items, clusterName: clusters.name })
    .from(items)
    .leftJoin(clusters, eq(items.clusterId, clusters.id))
    .where(and(eq(items.userId, userId), gt(items.createdAt, sql`now() - (${days} || ' days')::interval`)))
    .orderBy(desc(items.createdAt));

  if (rows.length === 0) {
    return `За последние ${days} дн. ты ничего не сохранял. Перешли что-нибудь — и я начну собирать темы.`;
  }

  const byTheme = new Map<string, Theme>();
  for (const { item, clusterName } of rows) {
    const name = clusterName ?? 'Разное';
    const t = byTheme.get(name) ?? { name, count: 0, examples: [] };
    t.count += 1;
    if (t.examples.length < 3) t.examples.push(titleOf(item));
    byTheme.set(name, t);
  }

  const themes = [...byTheme.values()].sort((a, b) => b.count - a.count).slice(0, 5);
  const themesBlock = themes
    .map((t) => `• ${t.name} (${t.count}): ${t.examples.join('; ')}`)
    .join('\n');

  // Дорогая генерация: в degraded/paused пропускаем LLM и отдаём детерминированную сводку.
  if (breakerState() === 'normal') {
    try {
      const text = await chat(digestPrompt(themesBlock, days, rows.length), {
        system: DIGEST_SYSTEM,
        temperature: 0.5,
        userId,
        maxTokens: tuning.digestMaxTokens,
      });
      if (text.trim()) return text.trim();
    } catch (err) {
      console.error('digest LLM error:', err);
    }
  }

  // Фолбэк без LLM — детерминированная сводка.
  return `За ${days} дн. ты сохранил ${rows.length} материалов. Главные темы:\n${themesBlock}`;
}
