import type { Bot } from 'grammy';
import { planByKey } from '../../billing/plans.js';
import {
  SuccessfulPaymentSchema,
  PreCheckoutSchema,
  parseInvoicePayload,
} from '../../billing/payments-validate.js';
import { db } from '../../db/client.js';
import { recordPaymentIdempotent } from '../../billing/payments.js';
import { grantEntitlement } from '../../billing/entitlement.js';
import { notifyAdmins } from '../alerts.js';

/**
 * Платёжный жизненный цикл Telegram Stars (§ монетизация). Идемпотентно (вебхук ретраится — дедуп по
 * charge id), валидируем границу zod, гранты атомарны. Регистрируется СТРОГО до registerIngest:
 * successful_payment — служебное сообщение без текста, иначе упало бы в приём.
 */
export function registerPayments(bot: Bot): void {
  // Подтверждение перед списанием: перепроверяем продукт/сумму/валюту по каталогу (защита от подмены),
  // отвечаем быстро (только zod + lookup, без сети/LLM → укладываемся в 10 c Telegram).
  bot.on('pre_checkout_query', async (ctx) => {
    const parsed = PreCheckoutSchema.safeParse(ctx.preCheckoutQuery);
    if (!parsed.success) {
      await ctx.answerPreCheckoutQuery(false, { error_message: 'Некорректный платёж.' }).catch(() => {});
      return;
    }
    const payload = parseInvoicePayload(parsed.data.invoice_payload);
    const plan = payload ? planByKey(payload.product) : null;
    if (!plan || plan.stars !== parsed.data.total_amount) {
      await ctx
        .answerPreCheckoutQuery(false, { error_message: 'Тариф изменился — открой /premium заново.' })
        .catch(() => {});
      return;
    }
    await ctx.answerPreCheckoutQuery(true).catch(() => {});
  });

  // Оплата прошла: выдать/продлить Pro идемпотентно.
  bot.on('message:successful_payment', async (ctx) => {
    const sp = SuccessfulPaymentSchema.safeParse(ctx.message.successful_payment);
    if (!sp.success) {
      void notifyAdmins(
        `payment-bad:${ctx.from?.id ?? 0}`,
        `⚠️ successful_payment не прошёл валидацию: ${JSON.stringify(ctx.message.successful_payment)}`,
      );
      return;
    }
    const data = sp.data;
    const payload = parseInvoicePayload(data.invoice_payload);
    const plan = payload ? planByKey(payload.product) : null;
    if (!payload || !plan) {
      void notifyAdmins(
        `payment-payload:${data.telegram_payment_charge_id}`,
        `⚠️ Оплата с неизвестным payload: ${data.invoice_payload} (charge ${data.telegram_payment_charge_id})`,
      );
      return;
    }

    // payload привязан к юзеру (`${product}:${userId}`) — сверяем с плательщиком. В норме совпадает
    // всегда (инвойс оплачивает тот, кому он отправлен); расхождение — аномалия (баг/подмена), а не
    // штатный путь: алертим и НЕ выдаём, чтобы не зачислить Pro не тому.
    if (payload.userId !== ctx.from?.id) {
      void notifyAdmins(
        `payment-user-mismatch:${data.telegram_payment_charge_id}`,
        `⚠️ Плательщик ${ctx.from?.id} ≠ payload.userId ${payload.userId} (charge ${data.telegram_payment_charge_id}). Грант не выдан.`,
      );
      return;
    }

    const userId = payload.userId;
    const now = new Date();
    const grantedUntil = new Date(now.getTime() + plan.durationSec * 1000);

    // Идемпотентность + атомарность в ОДНОЙ транзакции: запись платежа и грант коммитятся вместе. Грант —
    // ТОЛЬКО при выигранном INSERT (дубль вебхука → строки нет → откатываемся в no-op). Без транзакции краш
    // между записью и грантом оставил бы платёж без Pro: ретрай вебхука увидел бы дубль и не выдал доступ.
    const granted = await db.transaction(async (tx) => {
      const inserted = await recordPaymentIdempotent(
        {
          userId,
          telegramPaymentChargeId: data.telegram_payment_charge_id,
          providerPaymentChargeId: data.provider_payment_charge_id,
          product: plan.key,
          starsAmount: data.total_amount,
          invoicePayload: data.invoice_payload,
          grantedFrom: now,
          grantedUntil,
        },
        tx,
      );
      if (!inserted) return false; // дубль вебхука — доступ уже выдан в исходной транзакции
      await grantEntitlement({ userId, source: plan.source, durationSec: plan.durationSec }, tx);
      return true;
    });
    if (!granted) return;

    await ctx
      .reply('✅ Boomerang Pro активен — лимит снят, храни и возвращай сколько угодно. Спасибо! ⭐')
      .catch(() => {});
    void notifyAdmins(
      `purchase:${data.telegram_payment_charge_id}`,
      `💰 Покупка: ${plan.key} (${data.total_amount} ⭐) от ${userId}.`,
    );
  });
}
