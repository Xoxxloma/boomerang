import { InlineKeyboard, type Bot, type Context } from 'grammy';
import type { LabeledPrice } from 'grammy/types';
import { allPlans, planByKey, buildInvoicePayload, type Plan } from '../../billing/plans.js';
import { getEntitlement } from '../../billing/entitlement.js';
import { getCapacity } from '../../billing/capacity.js';
import { progressBar } from '../../billing/account.js';

/**
 * Экран «Аккаунт» (/premium) + покупка доступа (Telegram Stars). Единственная платная стена —
 * ёмкость базы (billing/capacity): Pro снимает потолок. Два блока (Доступ / База) + кнопки покупки
 * разовых пассов (1/3/6/12 мес). Авто-подписок нет — доступ конечен, об окончании напоминает свип.
 */

/** Дата в человеческом виде (DD.MM.YYYY, UTC) — для строки «доступ до …». */
function fmtDate(d: Date): string {
  const s = d.toISOString().slice(0, 10).split('-');
  return `${s[2]}.${s[1]}.${s[0]}`;
}

/** Русская форма множественного числа: plural(n, ['запись','записи','записей']). */
function plural(n: number, forms: [string, string, string]): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return forms[0];
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return forms[1];
  return forms[2];
}

const PASS_LABELS: Record<string, string> = {
  pass_1m: 'Месяц',
  pass_3m: '3 месяца',
  pass_6m: '6 месяцев',
  pass_12m: '12 месяцев',
};

/** Кнопки покупки разовых пассов. */
function buyKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const p of allPlans()) {
    kb.text(`${PASS_LABELS[p.key] ?? p.title} — ${p.stars} ⭐`, `buy:${p.key}`).row();
  }
  return kb;
}

/** Экран «Аккаунт»: блоки Доступ + База (статистика) + условные кнопки. */
async function renderAccount(userId: number): Promise<{ text: string; reply_markup: InlineKeyboard }> {
  const [ent, cap] = await Promise.all([getEntitlement(userId), getCapacity(userId)]);
  const lines: string[] = ['👤 *Аккаунт Boomerang*', '', '*Доступ*'];

  if (ent.tier === 'pro' && ent.activeUntil) {
    const until = fmtDate(ent.activeUntil);
    if (ent.source === 'trial') {
      lines.push('🎁 Пробный Pro');
      lines.push(`📅 Действует до: *${until}*`);
      lines.push('_После триала — бесплатный тариф (с лимитом хранилища)._');
    } else {
      lines.push('⭐ Pro');
      lines.push(`📅 Действует до: *${until}*, дальше — бесплатный тариф`);
    }
  } else {
    lines.push('🆓 Бесплатный тариф');
  }

  lines.push('', '*🗄 Хранилище*');
  if (cap.pro) {
    lines.push(`📥 ${cap.used} ${plural(cap.used, ['запись', 'записи', 'записей'])} · без лимита`);
  } else {
    lines.push(`📥 ${cap.used} / ${cap.limit} ${plural(cap.limit, ['запись', 'записи', 'записей'])}`);
    lines.push(progressBar(cap.used, cap.limit));
    lines.push(`осталось ${cap.remaining} ${plural(cap.remaining, ['место', 'места', 'мест'])}`);
  }

  return { text: lines.join('\n'), reply_markup: buyKeyboard() };
}

/** Сообщение «база заполнена» с CTA — общий текст для приёма (ingest/album), когда сработал гейт. */
export function capacityFullMessage(used: number, limit: number): {
  text: string;
  reply_markup: InlineKeyboard;
} {
  return {
    text:
      `🗄 Хранилище заполнено — ${used}/${limit} записей.\n` +
      `Чтобы сохранять дальше, оформи *Boomerang Pro* (безлимит) или удали ненужное в карточках записей.`,
    reply_markup: new InlineKeyboard().text('⭐ Открыть Boomerang Pro', 'plans:open'),
  };
}

/** Отправить разовый Stars-инвойс (currency XTR, provider_token пустой). */
async function sendInvoice(ctx: Context, plan: Plan, userId: number): Promise<void> {
  const prices: LabeledPrice[] = [{ label: plan.title, amount: plan.stars }];
  const payload = buildInvoicePayload(plan.key, userId);
  await ctx.replyWithInvoice(plan.title, plan.description, payload, 'XTR', prices, { provider_token: '' });
}

export function registerPlans(bot: Bot): void {
  const show = async (ctx: Context): Promise<void> => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const { text, reply_markup } = await renderAccount(userId);
    await ctx.reply(text, { parse_mode: 'Markdown', reply_markup });
  };

  bot.command('premium', show);
  bot.command('plans', show);

  // CTA «Открыть Pro» из сообщения о заполненной базе / «← Назад» из подтверждения отмены.
  bot.callbackQuery('plans:open', async (ctx) => {
    await show(ctx);
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^buy:(pass_1m|pass_3m|pass_6m|pass_12m)$/, async (ctx) => {
    const plan = planByKey(ctx.match[1]!);
    const userId = ctx.from?.id;
    if (!plan || !userId) {
      return ctx.answerCallbackQuery({ text: 'Тариф не найден', show_alert: true });
    }
    await sendInvoice(ctx, plan, userId);
    await ctx.answerCallbackQuery();
  });
}
