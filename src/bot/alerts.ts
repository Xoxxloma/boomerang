import { env } from '../config/env.js';
import { getBotApi } from './api.js';
import { shouldAlert } from './alertThrottle.js';

/**
 * Алерты админам в Telegram о критичных сбоях бюджет-гарда (учёт расхода ослеп, регидрация упала).
 * Раньше такое уходило только в console.error — на зарубежном VPS его никто не видит. Адресаты —
 * ADMIN_IDS из env (пусто → тихо, как раньше). Троттлинг (alertThrottle) не даёт одному и тому же
 * сбою спамить чат и упереться в лимиты Telegram (важно: «прокси без usage» иначе слал бы на каждый вызов).
 */

/** Отправить алерт админам (best-effort, троттл по key). Никогда не бросает — не роняет вызывающий код. */
export async function notifyAdmins(key: string, text: string): Promise<void> {
  if (env.ADMIN_IDS.length === 0) return;
  if (!shouldAlert(key, Date.now())) return;
  try {
    const api = getBotApi();
    await Promise.all(env.ADMIN_IDS.map((id) => api.sendMessage(id, text).catch(() => {})));
  } catch {
    // Алерт — best-effort: getBotApi не готов / сеть упала — глушим, чтобы не ронять вызывающий код.
  }
}

/**
 * Бюджет-гард считает расход по res.usage. Если провайдер/прокси его не вернул (токены = 0 при
 * непустом запросе) — учёт «ослеп», лимиты фактически отключены. На боевом OpenAI usage есть всегда
 * (проверено curl), поэтому нули — сигнал смены/поломки эндпоинта. Шлём алерт (троттл по типу вызова).
 */
export async function alertIfUsageMissing(
  kind: 'llm' | 'embedding',
  promptTokens: number,
  completionTokens: number,
): Promise<void> {
  if (promptTokens > 0 || completionTokens > 0) return; // usage пришёл — норма, молчим
  const varName = kind === 'llm' ? 'LLM_BASE_URL' : 'EMBEDDING_BASE_URL';
  await notifyAdmins(
    `usage-missing:${kind}`,
    `⚠️ Бюджет-гард: ответ ${kind}-API без поля usage (токены = 0). ` +
      `Учёт расхода не считает — дневные лимиты фактически ОТКЛЮЧЕНЫ. Проверь ${varName}.`,
  );
}
