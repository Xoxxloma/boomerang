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
      .editMessageText(chatId, messageId, `Обрабатываю избранное… ${done}/${total}`)
      .catch(() => {});
  };
}

/** Сколько имён дублей показываем в секции (остаток сворачиваем в «…и ещё N»). */
const DUPE_SHOW = 5;

/** Секция списка дублей: заголовок + до DUPE_SHOW имён буллетами + «…и ещё N» при остатке. */
function dupeSection(header: string, sample: string[], count: number): string {
  const shown = sample.slice(0, DUPE_SHOW).map((n) => `• ${n}`);
  const rest = count - Math.min(DUPE_SHOW, sample.length);
  if (rest > 0) shown.push(`…и ещё ${rest}`);
  return [header, ...shown].join('\n');
}

/**
 * Финальный текст после заливки: что разобрал + ПОНЯТНЫЕ списки дублей (что уже было в Бумеранге и
 * что повторилось внутри заливки) + мелочь числом + приглашение к запросу. Plain-text (шлётся без
 * parse_mode), буллеты безопасны.
 */
export function finalText(res: BatchResult): string {
  // Совсем нечего показать — ни сохранённого, ни пропущенного.
  if (res.saved === 0 && res.skipped === 0) {
    return 'Не нашёл, что обработать. Перешли что-нибудь — и спроси.';
  }

  const blocks: string[] = [];
  if (res.saved > 0) {
    const imgPart = res.images > 0 ? ` (из них ${res.images} картинок)` : '';
    blocks.push(`✅ Разобрал ${res.saved}${imgPart}.`);
  } else {
    blocks.push('Ничего нового не добавил.');
  }

  if (res.existingDupeCount > 0) {
    blocks.push(dupeSection('Эти посты уже были в Boomerang, не добавил повторно:', res.existingDupes, res.existingDupeCount));
  }
  if (res.inBatchDupeCount > 0) {
    blocks.push(dupeSection('Убрал повторы внутри заливки:', res.inBatchDupes, res.inBatchDupeCount));
  }

  // Остаток пропуска сверх дублей — мелочь без текста (короткие заметки/эмодзи).
  const noise = res.skipped - res.existingDupeCount - res.inBatchDupeCount;
  if (noise > 0) blocks.push(`Пропустил мелочь без текста: ${noise}.`);

  // Не влезло в потолок бесплатного тарифа: честно сообщаем + CTA на Pro (записи не потеряны — дольёшь
  // после апгрейда). Единственная платная стена — ёмкость базы.
  if (res.cappedOut && res.cappedOut > 0) {
    blocks.push(
      `🗄 Ещё ${res.cappedOut} не поместилось — хранилище заполнено. Оформи Boomerang Pro (безлимит) ` +
        'и долей остаток: /premium',
    );
  }

  blocks.push('Загляни в /folders или спроси — например «что я сохранял про переезд» (кнопка 🔍 Найти или /find).');
  return blocks.join('\n\n');
}
