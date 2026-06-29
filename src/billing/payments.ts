import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, type Executor } from '../db/client.js';
import { payments, type Payment } from '../db/schema.js';

/**
 * Журнал платежей Stars + идемпотентность вебхука. Вебхук successful_payment Telegram ретраит — дедуп
 * по telegram_payment_charge_id (UNIQUE): грант выдаётся ТОЛЬКО при выигранном INSERT (no check-then-act).
 */
export interface RecordPaymentInput {
  userId: number;
  telegramPaymentChargeId: string;
  providerPaymentChargeId?: string;
  product: string;
  starsAmount: number;
  invoicePayload: string;
  grantedFrom: Date;
  grantedUntil: Date;
}

/**
 * Записать платёж идемпотентно. true — новая строка (выдавать грант); false — дубль вебхука (ничего не
 * делать). ON CONFLICT DO NOTHING по уникальному charge id.
 */
export async function recordPaymentIdempotent(
  input: RecordPaymentInput,
  exec: Executor = db,
): Promise<boolean> {
  const rows = await exec
    .insert(payments)
    .values({
      userId: input.userId,
      telegramPaymentChargeId: input.telegramPaymentChargeId,
      providerPaymentChargeId: input.providerPaymentChargeId ?? null,
      product: input.product,
      starsAmount: input.starsAmount,
      invoicePayload: input.invoicePayload,
      isRecurring: false,
      isFirstRecurring: false,
      grantedFrom: input.grantedFrom,
      grantedUntil: input.grantedUntil,
    })
    .onConflictDoNothing({ target: payments.telegramPaymentChargeId })
    .returning({ id: payments.id });
  return rows.length > 0;
}

/** Найти платёж по charge id (для рефанда). */
export async function findPaymentByChargeId(chargeId: string): Promise<Payment | undefined> {
  const [row] = await db
    .select()
    .from(payments)
    .where(eq(payments.telegramPaymentChargeId, chargeId))
    .limit(1);
  return row;
}

/**
 * Атомарно «застолбить» рефанд: помечаем refunded_at ТОЛЬКО если он ещё пуст (test-and-set одним UPDATE).
 * Возвращает строку платежа, если заявку выиграли (можно звать refundStarPayment), либо null — платёж
 * не найден ИЛИ уже возвращается/возвращён (дубль/гонка двух админов). Снимает TOCTOU без отдельного чтения.
 */
export async function claimRefund(chargeId: string, exec: Executor = db): Promise<Payment | null> {
  const [row] = await exec
    .update(payments)
    .set({ refundedAt: sql`now()` })
    .where(and(eq(payments.telegramPaymentChargeId, chargeId), isNull(payments.refundedAt)))
    .returning();
  return row ?? null;
}

/** Откатить застолблённую заявку (refundStarPayment упал) — чтобы рефанд можно было повторить. */
export async function releaseRefundClaim(chargeId: string, exec: Executor = db): Promise<void> {
  await exec
    .update(payments)
    .set({ refundedAt: null })
    .where(eq(payments.telegramPaymentChargeId, chargeId));
}
