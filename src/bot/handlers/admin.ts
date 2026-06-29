import type { Bot } from 'grammy';
import { env } from '../../config/env.js';
import {
  claimRefund,
  releaseRefundClaim,
  findPaymentByChargeId,
} from '../../billing/payments.js';
import { revokeForRefund } from '../../billing/entitlement.js';

/**
 * Админские команды (только env.ADMIN_IDS; прочим — молчим, команда «не существует»). Пока — рефанд
 * Stars: refundStarPayment + гашение доступа + уведомление юзера.
 */
export function registerAdmin(bot: Bot): void {
  bot.command('refund', async (ctx) => {
    if (!ctx.from || !env.ADMIN_IDS.includes(ctx.from.id)) return; // не админ → тихо игнорируем
    const chargeId = ctx.match.trim();
    if (!chargeId) {
      await ctx.reply('Использование: /refund <telegram_payment_charge_id>');
      return;
    }

    // Атомарно «застолбить» рефанд (test-and-set refunded_at) — это и дедуп от двойного клика/двух админов,
    // и снятие TOCTOU: refundStarPayment вызовем максимум один раз. null → платёж не найден ИЛИ уже возвращён.
    const payment = await claimRefund(chargeId);
    if (!payment) {
      const existing = await findPaymentByChargeId(chargeId);
      await ctx.reply(existing ? 'Этот платёж уже возвращён.' : 'Платёж с таким charge id не найден.');
      return;
    }

    try {
      await ctx.api.refundStarPayment(payment.userId, chargeId);
    } catch (err) {
      // Внешний вызов упал — снимаем заявку, чтобы рефанд можно было повторить (иначе «уже возвращён» навсегда).
      await releaseRefundClaim(chargeId);
      console.error('refund error:', err);
      await ctx.reply(`Не удалось вернуть звёзды: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // Деньги вернулись (заявка уже помечена) → гасим доступ. revokeForRefund идемпотентен.
    await revokeForRefund(payment.userId);
    await ctx.reply(`✅ Возврат ${payment.starsAmount} ⭐ юзеру ${payment.userId} оформлен, доступ снят.`);
    await ctx.api
      .sendMessage(
        payment.userId,
        'Звёзды за Boomerang Pro возвращены, доступ к безлимиту снят. Вопросы — /help.',
      )
      .catch(() => {});
  });
}
