import { tuning } from '../config/tuning.js';

/**
 * Каталог платных продуктов (Telegram Stars). Чистый модуль: только tuning, без БД/env — безопасен в
 * тестах. Цены/сроки — константы в tuning (env-override). Монетизация одна — снятие потолка ёмкости
 * (billing/capacity); продукты — разовые пассы, различающиеся лишь сроком доступа (авто-подписок нет).
 */
export type ProductKey = 'pass_1m' | 'pass_3m' | 'pass_6m' | 'pass_12m';

/** Как выдаётся доступ: только разовый пасс с фиксированным сроком (авто-продления нет). */
export type PlanSource = 'pass';

export interface Plan {
  key: ProductKey;
  /** Заголовок инвойса (Telegram показывает юзеру). */
  title: string;
  /** Описание инвойса. */
  description: string;
  /** Цена в Stars (валюта XTR). */
  stars: number;
  source: PlanSource;
  /** Окно доступа в секундах (на сколько продлеваем activeUntil). */
  durationSec: number;
}

/** Заголовок инвойса — короткий бренд + срок; выгоду выносим в описание (не дублируем в title). */
const PRO = 'Boomerang Pro';
/** Описание инвойса: первая строка — ценность, вторая — условие оплаты (срок подставляется). */
function proDescription(period: string): string {
  return `Безлимитное хранилище: сохраняй и возвращай сколько угодно.\nДоступ на ${period}, разовый платёж.`;
}

/** Все продукты, собранные из текущего tuning (вызывать в рантайме, не кэшировать на импорте). */
export function allPlans(): Plan[] {
  return [
    {
      key: 'pass_1m',
      title: `${PRO} — 1 месяц`,
      description: proDescription('1 месяц'),
      stars: tuning.starsPass1mPrice,
      source: 'pass',
      durationSec: tuning.starsPass1mDurationSec,
    },
    {
      key: 'pass_3m',
      title: `${PRO} — 3 месяца`,
      description: proDescription('3 месяца'),
      stars: tuning.starsPass3mPrice,
      source: 'pass',
      durationSec: tuning.starsPass3mDurationSec,
    },
    {
      key: 'pass_6m',
      title: `${PRO} — 6 месяцев`,
      description: proDescription('6 месяцев'),
      stars: tuning.starsPass6mPrice,
      source: 'pass',
      durationSec: tuning.starsPass6mDurationSec,
    },
    {
      key: 'pass_12m',
      title: `${PRO} — 12 месяцев`,
      description: proDescription('12 месяцев'),
      stars: tuning.starsPass12mPrice,
      source: 'pass',
      durationSec: tuning.starsPass12mDurationSec,
    },
  ];
}

export function planByKey(key: string): Plan | null {
  return allPlans().find((p) => p.key === key) ?? null;
}

/** Payload инвойса: `${productKey}:${userId}`. Привязка платежа к юзеру + продукту (валидируем на успехе). */
export function buildInvoicePayload(key: ProductKey, userId: number): string {
  return `${key}:${userId}`;
}
