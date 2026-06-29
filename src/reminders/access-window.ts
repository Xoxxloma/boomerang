/**
 * Чистая логика напоминаний об окончании Pro-доступа (без БД/env — безопасна в юнит-тестах).
 * Свип (reminders/access) берёт отсюда расчёт «какие напоминания созрели» и тексты. Дедуп отправок —
 * снаружи (таблица access_reminders): здесь только когда и что слать.
 */

/** Точки напоминания относительно конца окна: за 3 дня, за 1 день, по факту окончания. */
export type AccessReminderKind = 'd3' | 'd1' | 'd0';

const DAY_MS = 86_400_000;

/**
 * Какие напоминания «созрели» для окна доступа (activeUntil) на момент now.
 * - d3: now в [activeUntil − 3д, activeUntil);
 * - d1: now в [activeUntil − 1д, activeUntil);
 * - d0: now в [activeUntil, activeUntil + 1д) — момент окончания с суточным grace, чтобы не слать
 *   давно-истёкшим (первый деплой/простой свипа). Повторную отправку отсекает claim снаружи.
 */
export function dueKinds(activeUntil: Date, now: Date): AccessReminderKind[] {
  const au = activeUntil.getTime();
  const t = now.getTime();
  const kinds: AccessReminderKind[] = [];
  if (t >= au - 3 * DAY_MS && t < au) kinds.push('d3');
  if (t >= au - DAY_MS && t < au) kinds.push('d1');
  if (t >= au && t < au + DAY_MS) kinds.push('d0');
  return kinds;
}

/**
 * Текст напоминания. Тон — не «платите», а «возврат к ценности»: на бесплатном тарифе сохранять
 * можно лишь до лимита, безлимит снимает потолок. isTrial меняет формулировку (пробный vs купленный).
 */
export function accessReminderText(kind: AccessReminderKind, isTrial: boolean): string {
  const what = isTrial ? 'Пробный Boomerang Pro' : 'Boomerang Pro';
  if (kind === 'd3') {
    return `🪃 ${what} заканчивается через 3 дня. Дальше — бесплатный тариф с лимитом хранилища; чтобы копить без потолка, продли Pro.`;
  }
  if (kind === 'd1') {
    return `🪃 ${what} заканчивается завтра. Продли Pro, чтобы хранилище осталось без лимита.`;
  }
  return isTrial
    ? '🪃 Пробный Boomerang Pro закончился — база перешла на бесплатный лимит. Продли Pro, чтобы снова сохранять без потолка.'
    : '🪃 Boomerang Pro закончился — база перешла на бесплатный лимит. Продли Pro, чтобы снова сохранять без потолка.';
}
