import { InlineKeyboard } from 'grammy';
import { getBotApi } from '../bot/api.js';
import { tuning } from '../config/tuning.js';
import { dueKinds, accessReminderText, type AccessReminderKind } from './access-window.js';
import { dueAccessWindows, claimAccessReminder } from '../db/access-reminders.js';

/**
 * Свип напоминаний об окончании Pro-доступа (за 3 дня / за 1 день / по факту окончания). Запускается
 * cron-очередью access-reminders-sweep (queue/boss). Для каждого истекающего окна: какие kind созрели
 * (dueKinds) → claim в access_reminders → доставка. Покрывает и купленные пассы, и истекающий триал.
 */

/** Доставить одно напоминание. Никогда не бросает наружу — фон не должен падать из-за одного юзера. */
async function deliverAccessReminder(
  userId: number,
  kind: AccessReminderKind,
  isTrial: boolean,
): Promise<void> {
  try {
    await getBotApi().sendMessage(userId, accessReminderText(kind, isTrial), {
      link_preview_options: { is_disabled: true },
      reply_markup: new InlineKeyboard().text('⭐ Продлить Pro', 'plans:open'),
    });
  } catch (err) {
    // 403 (юзер заблокировал), сеть — не роняем свип. Claim уже стоит → повтором не спамим.
    console.error('deliverAccessReminder error:', { userId, kind, err });
  }
}

/** Найти истекающие окна и разослать созревшие напоминания (claim перед отправкой → без дублей). */
export async function sweepAccessReminders(now: Date): Promise<void> {
  const windows = await dueAccessWindows(now, tuning.accessRemindSweepBatch);
  for (const w of windows) {
    // Изолируем окно: транзиентный сбой claim (БД) на одном юзере не должен ронять весь батч и тормозить
    // рассылку остальным. Дублей нет (claim идемпотентен), pg-boss доберёт это окно следующим тиком.
    try {
      const isTrial = w.source === 'trial';
      for (const kind of dueKinds(w.activeUntil, now)) {
        if (await claimAccessReminder(w.userId, w.activeUntil, kind)) {
          await deliverAccessReminder(w.userId, kind, isTrial);
        }
      }
    } catch (err) {
      console.error('sweepAccessReminders window error:', { userId: w.userId, err });
    }
  }
}
