/**
 * Чистый троттлинг алертов админам: один и тот же сбой (по ключу) не чаще раза в окно. Вынесен из
 * alerts.ts (тот тянет env/Telegram), чтобы политику можно было юнит-тестить без секретов и сети —
 * как ai/usage.ts (см. правило «env-free модули тестируемы»).
 */

/** Дефолтное окно троттлинга алертов (мс) — 1 час. */
export const ALERT_THROTTLE_MS = 60 * 60 * 1000;

const lastSent = new Map<string, number>();

/**
 * true, если алерт по ключу пора слать (и помечает время отправки). false — ещё рано (троттл).
 * now передаётся снаружи ради тестируемости (в проде — Date.now()).
 */
export function shouldAlert(key: string, now: number, throttleMs: number = ALERT_THROTTLE_MS): boolean {
  const prev = lastSent.get(key);
  if (prev != null && now - prev < throttleMs) return false;
  lastSent.set(key, now);
  return true;
}

/** @internal только для тестов — сброс состояния троттлинга. */
export function __resetAlertThrottleForTest(): void {
  lastSent.clear();
}
