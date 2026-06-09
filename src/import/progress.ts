import type { Api } from 'grammy';
import type { BatchResult, ProgressFn } from './batch.js';

/** Минимальный интервал между правками прогресс-сообщения (лимиты Telegram на edit). */
const EDIT_THROTTLE_MS = 1500;

/**
 * Троттлящий редактор прогресса: возвращает onProgress, который правит одно сообщение-счётчик
 * не чаще раза в EDIT_THROTTLE_MS. Ошибки редактирования глушим (не критично).
 */
export function makeProgress(api: Api, chatId: number | null, messageId: number | null): ProgressFn {
  if (!chatId || !messageId) return () => {};
  let last = 0;
  return async (done: number, total: number) => {
    const now = Date.now();
    if (done < total && now - last < EDIT_THROTTLE_MS) return;
    last = now;
    await api
      .editMessageText(chatId, messageId, `🪃 Обрабатываю избранное… ${done}/${total}`)
      .catch(() => {});
  };
}

/** Финальный текст после заливки: счётчики + приглашение к запросу (без визуальной карты — она позже). */
export function finalText(res: BatchResult): string {
  if (res.saved === 0) {
    return res.skipped > 0
      ? `Похоже, всё это уже было сохранено или не несло текста (${res.skipped}). Ничего нового не добавил.`
      : 'Не нашёл, что обработать. Перешли что-нибудь — и спроси.';
  }
  const skip = res.skipped > 0 ? ` (пропустил ${res.skipped} дублей и мелочи)` : '';
  const themed = res.saved - res.images;
  const imgPart = res.images > 0 ? ` + ${res.images} картинок на полке «Изображения»` : '';
  return (
    `✅ Разобрал ${res.saved}: ${themed} по темам${imgPart}${skip}.\n` +
    'Загляни в /folders или спроси — например «что я сохранял про переезд» (кнопка 🔍 Найти или /find).'
  );
}
