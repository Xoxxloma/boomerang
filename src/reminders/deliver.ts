import { InlineKeyboard } from 'grammy';
import type { Item } from '../db/schema.js';
import { getBotApi } from '../bot/api.js';
import { itemDisplayName } from '../db/items.js';

/**
 * Доставка сработавшего напоминания пользователю. Тон — не будильник, а «второй мозг возвращает вещь».
 * Сохранённый контент → reply к оригиналу в архиве (тап перематывает к нему). Заметка-задача (type=text)
 * → просто текст. Шлём ровно в заданный момент (тихих часов нет: напоминание поставил сам юзер — оно ему
 * нужно именно тогда). Никогда не бросает наружу — фон не должен падать из-за одного напоминания.
 */

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
export async function deliverReminder(item: Item): Promise<void> {
  try {
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
