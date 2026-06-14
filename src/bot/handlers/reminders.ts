import { InlineKeyboard, type Bot, type Context } from 'grammy';
import { getItem, itemDisplayName } from '../../db/items.js';
import {
  setReminder,
  clearReminder,
  markReminderDone,
  getReminderSettings,
  setRemindPending,
  getRemindPending,
  delRemindPending,
} from '../../db/reminders.js';
import { presetTime, type PresetKey } from '../../reminders/presets.js';
import { parseTime } from '../../reminders/parse.js';
import { formatRemindAt } from '../../reminders/format.js';
import { tuning } from '../../config/tuning.js';
import type { Item } from '../../db/schema.js';

/** Кнопка «🪃 Напомнить» для клавиатур карточек (callback rem:<itemId>). Хендлер — ниже. */
export function remindButton(kb: InlineKeyboard, itemId: string): InlineKeyboard {
  return kb.text('🪃 Напомнить', `rem:${itemId}`);
}

/** Эфемерное меню выбора времени для item — отдельным сообщением (surface-agnostic, без правки поста). */
function presetMenu(item: Item, tz: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (item.remindAt && item.remindStatus === 'pending') {
    kb.text(`🔕 Отменить (${formatRemindAt(item.remindAt, tz)})`, `rcancel:${item.id}`).row();
  }
  kb.text('Завтра 9:00', `remset:${item.id}:tomorrow`).row();
  kb.text('Сегодня вечером', `remset:${item.id}:evening`).row();
  kb.text('Через неделю', `remset:${item.id}:week`).row();
  kb.text('🕓 Своё время', `remcustom:${item.id}`).row();
  kb.text('✕', 'close');
  return kb;
}

/** Загрузить item с проверкой владельца; на провале — ответить алертом и вернуть null. */
async function ownItem(ctx: Context, itemId: string): Promise<Item | null> {
  const item = await getItem(itemId);
  if (!item || item.userId !== ctx.from?.id) {
    await ctx.answerCallbackQuery({ text: 'Запись не найдена', show_alert: true });
    return null;
  }
  return item;
}

/** Подтвердить постановку: тост + правка сообщения-меню в финальный статус (если это меню). */
async function confirmSet(ctx: Context, item: Item, at: Date, tz: string): Promise<void> {
  await setReminder(item.id, item.userId, at);
  const when = formatRemindAt(at, tz);
  await ctx.answerCallbackQuery({ text: `✅ Верну ${when}` });
  await ctx.editMessageText(`✅ Верну ${when} — «${itemDisplayName(item)}»`).catch(() => {});
}

export function registerReminders(bot: Bot): void {
  // Тап «🪃 Напомнить» на карточке → эфемерное меню времени отдельным сообщением.
  bot.callbackQuery(/^rem:(.+)$/, async (ctx) => {
    const item = await ownItem(ctx, ctx.match[1]!);
    if (!item) return;
    const { tz } = await getReminderSettings(item.userId);
    await ctx.reply(`🪃 Когда вернуть «${itemDisplayName(item)}»?`, {
      reply_markup: presetMenu(item, tz),
      link_preview_options: { is_disabled: true },
    });
    await ctx.answerCallbackQuery();
  });

  // Пресет → детерминированное время (без LLM) → ставим.
  bot.callbackQuery(/^remset:(.+):(tomorrow|evening|week)$/, async (ctx) => {
    const item = await ownItem(ctx, ctx.match[1]!);
    if (!item) return;
    const { tz } = await getReminderSettings(item.userId);
    const at = presetTime(ctx.match[2] as PresetKey, tz);
    await confirmSet(ctx, item, at, tz);
  });

  // «Своё время» → force_reply; ввод привяжем к id сообщения-приглашения через remind_pending.
  bot.callbackQuery(/^remcustom:(.+)$/, async (ctx) => {
    const item = await ownItem(ctx, ctx.match[1]!);
    if (!item) return;
    const prompt = await ctx.reply('🕓 Когда вернуть? Напр. «завтра в 9», «через 2 часа», «3 июля 14:00».', {
      reply_markup: { force_reply: true, input_field_placeholder: 'завтра в 9' },
    });
    await setRemindPending(prompt.chat.id, prompt.message_id, item.id);
    await ctx.answerCallbackQuery();
  });

  // Конфирм неоднозначного времени («в 9» → 9:00/21:00): время в callback — epoch-секундами (лимит 64б).
  bot.callbackQuery(/^rconfirm:(.+):(\d+)$/, async (ctx) => {
    const item = await ownItem(ctx, ctx.match[1]!);
    if (!item) return;
    const at = new Date(Number(ctx.match[2]) * 1000);
    const { tz } = await getReminderSettings(item.userId);
    await confirmSet(ctx, item, at, tz);
  });

  // Снять напоминание (из меню или из «Скоро»).
  bot.callbackQuery(/^rcancel:(.+)$/, async (ctx) => {
    const item = await ownItem(ctx, ctx.match[1]!);
    if (!item) return;
    await clearReminder(item.id, item.userId);
    await ctx.answerCallbackQuery({ text: 'Отменил напоминание' });
    await ctx.editMessageText('🔕 Напоминание отменено.').catch(() => {});
  });

  // «✅ Готово» на доставленном возврате — закрываем (item остаётся в архиве).
  bot.callbackQuery(/^rdone:(.+)$/, async (ctx) => {
    const item = await ownItem(ctx, ctx.match[1]!);
    if (!item) return;
    await markReminderDone(item.id, item.userId);
    await ctx.answerCallbackQuery({ text: 'Готово' });
    await ctx.editMessageReplyMarkup({}).catch(() => {});
  });

  // «⏰ Отложить +1ч/+1д» на возврате — дельта от now (пояс не нужен), снова в очередь.
  bot.callbackQuery(/^rsnz:(h|d):(.+)$/, async (ctx) => {
    const item = await ownItem(ctx, ctx.match[2]!);
    if (!item) return;
    const min = ctx.match[1] === 'h' ? tuning.remindSnoozeHourMin : tuning.remindSnoozeDayMin;
    const at = new Date(Date.now() + min * 60_000);
    await setReminder(item.id, item.userId, at);
    const { tz } = await getReminderSettings(item.userId);
    await ctx.answerCallbackQuery({ text: `Отложил до ${formatRemindAt(at, tz)}` });
    await ctx.editMessageReplyMarkup({}).catch(() => {});
  });

  // Перехват ответа на «Своё время» (ДО ingest, ПОСЛЕ newcat/search — каждый next() на чужой prompt).
  bot.on('message:text', async (ctx, next) => {
    const replyTo = ctx.message.reply_to_message;
    if (!replyTo) return next();
    const itemId = await getRemindPending(ctx.chat.id, replyTo.message_id);
    if (!itemId) return next(); // не наш prompt → дальше (newcat уже отработал раньше, иначе ingest)

    await delRemindPending(ctx.chat.id, replyTo.message_id);
    const item = await getItem(itemId);
    if (!item || item.userId !== ctx.from.id) {
      await ctx.reply('Запись не найдена.');
      return;
    }

    const { tz } = await getReminderSettings(item.userId);
    const { whenAt, altAt } = await parseTime(ctx.message.text, tz, item.userId);
    if (!whenAt) {
      await ctx.reply('Не понял время. Нажми «🪃 Напомнить» и попробуй ещё раз — напр. «завтра в 9».');
      return;
    }

    // Неоднозначно («в 9») → один инлайн-конфирм; время кодируем epoch-секундами в callback.
    if (altAt) {
      const kb = new InlineKeyboard()
        .text(formatRemindAt(whenAt, tz), `rconfirm:${item.id}:${Math.floor(whenAt.getTime() / 1000)}`)
        .text(formatRemindAt(altAt, tz), `rconfirm:${item.id}:${Math.floor(altAt.getTime() / 1000)}`);
      await ctx.reply('Уточни время:', { reply_markup: kb });
      return;
    }

    await setReminder(item.id, item.userId, whenAt);
    await ctx.reply(`✅ Верну ${formatRemindAt(whenAt, tz)} — «${itemDisplayName(item)}».`);
  });
}
