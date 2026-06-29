import { describe, it, expect } from 'vitest';
import {
  SuccessfulPaymentSchema,
  parseInvoicePayload,
} from '../src/billing/payments-validate.js';
import { tuning } from '../src/config/tuning.js';

describe('SuccessfulPaymentSchema', () => {
  const valid = {
    currency: 'XTR',
    total_amount: 129,
    invoice_payload: 'pass_1m:42',
    telegram_payment_charge_id: 'ch_123',
  };

  it('валидный XTR-платёж принимается', () => {
    expect(SuccessfulPaymentSchema.safeParse(valid).success).toBe(true);
  });

  it('неверная валюта (RUB) отвергается', () => {
    expect(SuccessfulPaymentSchema.safeParse({ ...valid, currency: 'RUB' }).success).toBe(false);
  });

  it('без charge id отвергается', () => {
    const { telegram_payment_charge_id, ...rest } = valid;
    void telegram_payment_charge_id;
    expect(SuccessfulPaymentSchema.safeParse(rest).success).toBe(false);
  });
});

describe('parseInvoicePayload', () => {
  it('валидный payload → продукт + userId', () => {
    expect(parseInvoicePayload('pass_3m:777')).toEqual({ product: 'pass_3m', userId: 777 });
  });

  it('неизвестный продукт → null', () => {
    expect(parseInvoicePayload('lifetime:1')).toBeNull();
  });

  it('мусор без userId → null', () => {
    expect(parseInvoicePayload('pass_1m:')).toBeNull();
    expect(parseInvoicePayload('garbage')).toBeNull();
  });

  it('цена разового месяца соответствует tuning (защита pre_checkout)', () => {
    expect(tuning.starsPass1mPrice).toBeGreaterThan(0);
  });
});
