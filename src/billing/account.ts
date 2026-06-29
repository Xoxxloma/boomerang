/**
 * Чистая логика экрана «Аккаунт» (без БД/env — безопасна в юнит-тестах). Бот-хендлер (bot/handlers/plans)
 * берёт отсюда расчёт прогресс-бара заполнения базы.
 */

/** Текстовый прогресс-бар заполнения базы (10 ячеек + проценты) — для free-тарифа. */
export function progressBar(used: number, limit: number): string {
  const ratio = limit > 0 ? Math.min(1, used / limit) : 0;
  const filled = Math.round(ratio * 10);
  return '▓'.repeat(filled) + '░'.repeat(10 - filled) + ` ${Math.round(ratio * 100)}%`;
}
