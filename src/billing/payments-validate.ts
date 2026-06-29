import { z } from 'zod';
import { planByKey, type ProductKey } from './plans.js';

/**
 * Валидация платёжной границы Telegram (§ honest types на I/O). Чистый модуль (только zod + каталог) —
 * без БД/env, безопасен в юнит-тестах. Подделать сумму/валюту нельзя: pre_checkout перепроверяем по
 * каталогу, на успехе сверяем payload.
 */

/** Поля SuccessfulPayment, которые нам нужны (Telegram присылает больше). */
export const SuccessfulPaymentSchema = z.object({
  currency: z.literal('XTR'),
  total_amount: z.number().int().positive(),
  invoice_payload: z.string().min(1),
  telegram_payment_charge_id: z.string().min(1),
  provider_payment_charge_id: z.string().optional(),
});
export type SuccessfulPaymentParsed = z.infer<typeof SuccessfulPaymentSchema>;

/** Поля PreCheckoutQuery, нужные для подтверждения. */
export const PreCheckoutSchema = z.object({
  id: z.string().min(1),
  currency: z.literal('XTR'),
  total_amount: z.number().int().positive(),
  invoice_payload: z.string().min(1),
});

export interface InvoicePayload {
  product: ProductKey;
  userId: number;
}

/** Разобрать payload инвойса `${productKey}:${userId}`. Возвращает null на мусоре/неизвестном продукте. */
export function parseInvoicePayload(payload: string): InvoicePayload | null {
  const m = /^([a-z0-9_]+):(\d+)$/.exec(payload);
  if (!m) return null;
  const product = m[1]!;
  const userId = Number(m[2]);
  if (!Number.isSafeInteger(userId) || userId <= 0) return null;
  const plan = planByKey(product);
  if (!plan) return null;
  return { product: plan.key, userId };
}
