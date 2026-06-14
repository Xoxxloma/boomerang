import { DateTime } from 'luxon';
import { InlineKeyboard } from 'grammy';
import type { Item } from '../db/schema.js';
import { getBotApi } from '../bot/api.js';
import { itemDisplayName } from '../db/items.js';
import { getReminderSettings, deferReminder } from '../db/reminders.js';

/**
 * Доставка сработавшего напоминания пользователю. Тон — не будильник, а «второй мозг возвращает вещь».
 * Сохранённый контент → reply к оригиналу в архиве (тап перематывает к нему). Заметка-задача (type=text)
 * → просто текст. Тихие часы соблюдаем переносом доставки (не глушением). Никогда не бросает наружу —
 * фон не должен падать из-за одного напоминания.
 */

/** Сейчас в тихих часах пользователя? Окно может пересекать полночь (22→8). */
function inQuietHours(now: Date, tz: string, startH: number, endH: number): boolean {
  if (startH === endH) return false;
  const h = DateTime.fromJSDate(now).setZone(tz).hour;
  return startH < endH ? h >= startH && h < endH : h >= startH || h < endH;
}

/** Ближайший конец тихих часов (endH:00) как UTC — на него переносим «созревшее ночью». */
function nextQuietEnd(now: Date, tz: string, endH: number): Date {
  const local = DateTime.fromJSDate(now).setZone(tz);
  let target = local.set({ hour: endH, minute: 0, second: 0, millisecond: 0 });
  if (target <= local) target = target.plus({ days: 1 });
  return target.toUTC().toJSDate();
}

/** Клавиатура возврата: к источнику (если есть) + Готово/Отложить. Всегда непустая (иначе middleware
 *  в bot/index.ts дошьёт search-клавиатуру). */
function reminderKeyboard(item: Item): InlineKeyboard {
  const kb = new InlineKeyboard();
  // Источник: reply-переход (src:) работает только при tgMessageId; для импортных url — прямая ссылка.
  if (item.tgMessageId) kb.text('↑ Источник', `src:${item.id}`).row();
  else if (item.url) kb.url('🔗 Открыть', item.url).row();
  kb.text('✅ Готово', `rdone:${item.id}`);
  kb.text('⏰ +1ч', `rsnz:h:${item.id}`).text('⏰ +1д', `rsnz:d:${item.id}`);
  return kb;
}

/** Доставить одно напоминание (item уже заклеймлен в статус 'sent'). */
export async function deliverReminder(item: Item, now: Date = new Date()): Promise<void> {
  try {
    const { tz, quietStartHour, quietEndHour } = await getReminderSettings(item.userId);

    // Тихие часы: не шлём, переносим на конец окна (status → pending), следующий sweep доставит.
    if (inQuietHours(now, tz, quietStartHour, quietEndHour)) {
      await deferReminder(item.id, nextQuietEnd(now, tz, quietEndHour));
      return;
    }

    const kb = reminderKeyboard(item);
    // Заметка-задача (текст самого юзера) — reply к своей же команде бессмыслен, шлём просто текстом.
    // Сохранённый контент с tgMessageId — reply к оригиналу: тап перематывает к нему в архиве.
    const isTask = item.type === 'text';
    // allow_sending_without_reply: оригинал мог быть удалён/протух (>48ч) — доставим без перехода, не теряем.
    const replyParams =
      !isTask && item.tgMessageId
        ? { message_id: item.tgMessageId, allow_sending_without_reply: true }
        : undefined;
    const body = isTask
      ? `🪃 Ты просил вернуть:\n${item.rawText ?? itemDisplayName(item)}`
      : `🪃 Возвращаю, как просил:\n«${itemDisplayName(item)}»`;

    await getBotApi().sendMessage(item.userId, body, {
      link_preview_options: { is_disabled: true },
      reply_markup: kb,
      ...(replyParams ? { reply_parameters: replyParams } : {}),
    });
  } catch (err) {
    // 403 (юзер заблокировал), сеть — не роняем sweep. Item остаётся 'sent' (повтором не спамим).
    console.error('deliverReminder error:', { itemId: item.id, err });
  }
}
