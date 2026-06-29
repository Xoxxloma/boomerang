import { sql } from 'drizzle-orm';
import {
  pgTable,
  pgEnum,
  uuid,
  bigint,
  text,
  boolean,
  integer,
  jsonb,
  timestamp,
  vector,
  index,
  uniqueIndex,
  primaryKey,
  date,
  numeric,
} from 'drizzle-orm/pg-core';

/**
 * Размерность эмбеддингов (OpenAI text-embedding-3-small = 1536).
 * Задаётся здесь, а не импортом из config/env — drizzle-kit грузит этот файл напрямую
 * и не должен тянуть валидацию окружения. Значение продублировано в config/env.ts (EMBEDDING_DIM);
 * при смене модели эмбеддингов менять в обоих местах (и пересоздавать миграцию).
 */
const EMBEDDING_DIM = 1536;

/** Тип единицы контента (см. §9 спеки). */
export const itemType = pgEnum('item_type', [
  'link',
  'tg_post',
  'document',
  'image',
  'video',
  'text',
  'voice',
]);

/**
 * Статус пользовательского напоминания на item («верни мне это в момент T»).
 * pending — ждёт срабатывания; sent — отдано пользователю (claim под row-lock);
 * done — пользователь нажал «Готово»; cancelled — снято. NULL у item без напоминания.
 */
export const remindStatus = pgEnum('remind_status', ['pending', 'sent', 'done', 'cancelled']);

export const users = pgTable('users', {
  id: bigint('id', { mode: 'number' }).primaryKey(), // tg user id
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  importDone: boolean('import_done').default(false).notNull(),
  // jsonb-настройки пользователя: { reminder: {...}, tz } — параметры доставки напоминаний
  settings: jsonb('settings').$type<Record<string, unknown>>().default({}).notNull(),
});

export const items = pgTable(
  'items',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    // id исходного сообщения пользователя — для reply-jump к оригиналу в ленте бота.
    tgMessageId: bigint('tg_message_id', { mode: 'number' }),
    sourceChat: text('source_chat'), // откуда переслано (опц.)
    type: itemType('type').notNull(),
    rawText: text('raw_text'), // текст поста / подписи / своя мысль
    url: text('url'),
    title: text('title'), // title / og:title
    description: text('description'), // og:description
    ocrText: text('ocr_text'), // ТОЛЬКО под капотом, не показывать пользователю
    transcript: text('transcript'), // voice / опц. видео
    // Дочитанное тело статьи по ссылке (readability) — ТОЛЬКО в индекс, как ocr_text/transcript.
    // bodyStatus: NULL — ещё не пробовали; 'ok' — прочитано; 'unreadable' — заглушка/SPA/пейвол/skip-домен
    // (кэш отказа: больше не дёргаем + идемпотентность ретрая L2, как гейт !ocrText / !indexedAt).
    bodyText: text('body_text'),
    bodyStatus: text('body_status'),
    // Идентификаторы файла в Telegram. Сам файл на диске НЕ храним (хранение ≠ ценность);
    // байты качаем во временный файл по требованию (L2 OCR/чтение документа) и удаляем.
    tgFileId: text('tg_file_id'), // для повторного скачивания через getFile (может протухать со временем)
    tgFileUniqueId: text('tg_file_unique_id'), // стабильный id для дедупа (скачать по нему нельзя)
    // media_group_id альбома (общий у всех членов); NULL у не-альбомных. Признак «эта группа уже стала
    // постом» — чтобы опоздавший член-осколок не уехал отдельной картинкой на полку (см. groupsAlreadyPosted).
    mediaGroupId: text('media_group_id'),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIM }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    indexedAt: timestamp('indexed_at', { withTimezone: true }), // когда прошёл L2
    // Пользовательское напоминание («верни в момент T»): источник истины для cron-sweep раз в минуту.
    // remind_at — когда вернуть (UTC); remind_status — жизненный цикл (NULL = напоминания нет).
    remindAt: timestamp('remind_at', { withTimezone: true }),
    remindStatus: remindStatus('remind_status'),
    remindCreatedAt: timestamp('remind_created_at', { withTimezone: true }),
  },
  (t) => [
    index('items_user_idx').on(t.userId),
    index('items_user_media_group_idx').on(t.userId, t.mediaGroupId),
    index('items_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
    // Частичный индекс под sweep «отдай созревшие напоминания»: покрывает только строки с remind_at.
    index('items_remind_due_idx')
      .on(t.remindStatus, t.remindAt)
      .where(sql`${t.remindAt} is not null`),
  ],
);

export type Item = typeof items.$inferSelect;
export type NewItem = typeof items.$inferInsert;
export type User = typeof users.$inferSelect;

/**
 * Сессия ввода «Своё время» для напоминания: к какому item относится force_reply-ответ.
 * По образцу edit_pending — состояние в БД (durable, работает при нескольких инстансах бота).
 * Ключ — координаты сообщения-приглашения бота, на которое пользователь отвечает.
 */
export const remindPending = pgTable(
  'remind_pending',
  {
    chatId: bigint('chat_id', { mode: 'number' }).notNull(),
    messageId: bigint('message_id', { mode: 'number' }).notNull(),
    itemId: uuid('item_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.chatId, t.messageId] })],
);

/** Альбом (media group): метаданные группы + ack-сообщение «Принял». */
export const albumSession = pgTable('album_session', {
  mediaGroupId: text('media_group_id').primaryKey(),
  ackChatId: bigint('ack_chat_id', { mode: 'number' }),
  ackMessageId: bigint('ack_message_id', { mode: 'number' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/** Альбом: отдельные сообщения-части (накапливаются до флаша). */
export const albumPart = pgTable(
  'album_part',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    mediaGroupId: text('media_group_id').notNull(),
    message: jsonb('message').$type<unknown>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('album_part_gid_idx').on(t.mediaGroupId)],
);

/**
 * Всплеск пересылок: когда пользователь шлёт контент пачкой (частота входящих > порога), не спамим
 * поштучным «Принял», а копим и обрабатываем батчем. Зеркало album_session/album_part, но ключ — userId
 * (не media_group_id). progress_* — одно сообщение-счётчик, которое редактируем по ходу.
 */
export const burstSession = pgTable('burst_session', {
  userId: bigint('user_id', { mode: 'number' }).primaryKey(),
  progressChatId: bigint('progress_chat_id', { mode: 'number' }),
  progressMessageId: bigint('progress_message_id', { mode: 'number' }),
  count: integer('count').default(0).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/** Всплеск: буфер сообщений пользователя до батч-флаша (по образцу album_part). */
export const burstPart = pgTable(
  'burst_part',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    message: jsonb('message').$type<unknown>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('burst_part_user_idx').on(t.userId)],
);

/**
 * Дневной учёт LLM/эмбеддинг-расхода (бюджет-гарды). Счётчики живут в памяти (ai/usage.ts),
 * сюда периодически флашатся и регидрируются на старте — чтобы рестарт/деплой не обнулял лимиты.
 * userId === 0 — глобальный агрегат (tg id всегда > 0). Источник истины для дневных сумм — память;
 * флаш перезаписывает строку целиком (upsert).
 */
export const usageDaily = pgTable(
  'usage_daily',
  {
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    day: date('day').notNull(),
    llmPromptTokens: bigint('llm_prompt_tokens', { mode: 'number' }).default(0).notNull(),
    llmCompletionTokens: bigint('llm_completion_tokens', { mode: 'number' }).default(0).notNull(),
    embeddingTokens: bigint('embedding_tokens', { mode: 'number' }).default(0).notNull(),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).default('0').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.day] })],
);

/** Эффективный тариф юзера. Источник истины «Pro» — entitlements.activeUntil > now() (см. billing/entitlement). */
export const entitlementTier = pgEnum('entitlement_tier', ['free', 'pro']);
/** Чем выдан текущий Pro-доступ: триал, нативная подписка, разовый пасс. */
export const entitlementSource = pgEnum('entitlement_source', ['trial', 'subscription', 'pass']);

/**
 * Источник истины «Pro» — 1 строка на юзера (§ монетизация по ёмкости базы). Эффективный тариф
 * ВЫВОДИТСЯ из activeUntil > now() (лениво, без крона): NULL/прошлое = free, будущее = pro.
 * tier хранится для отладки/выборок, но решает activeUntil. Гранты атомарны (UPSERT с GREATEST),
 * триал выдаётся один раз (ON CONFLICT DO NOTHING).
 */
export const entitlements = pgTable('entitlements', {
  userId: bigint('user_id', { mode: 'number' }).primaryKey(), // tg user id, 1:1 с users.id
  tier: entitlementTier('tier').default('free').notNull(),
  activeUntil: timestamp('active_until', { withTimezone: true }), // NULL = доступа не было
  source: entitlementSource('source'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Неизменяемый журнал платежей Telegram Stars + ключ идемпотентности. Вебхук successful_payment
 * Telegram ретраит — дедуп по telegram_payment_charge_id (UNIQUE): грант выдаётся только при выигранном
 * INSERT ... ON CONFLICT DO NOTHING RETURNING. Хранит окно, на которое выдан доступ, и факт рефанда.
 */
export const payments = pgTable(
  'payments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    telegramPaymentChargeId: text('telegram_payment_charge_id').notNull(),
    providerPaymentChargeId: text('provider_payment_charge_id'),
    product: text('product').notNull(), // ProductKey из billing/plans
    starsAmount: integer('stars_amount').notNull(), // total_amount в XTR
    invoicePayload: text('invoice_payload').notNull(),
    isRecurring: boolean('is_recurring').default(false).notNull(),
    isFirstRecurring: boolean('is_first_recurring').default(false).notNull(),
    grantedFrom: timestamp('granted_from', { withTimezone: true }).notNull(),
    grantedUntil: timestamp('granted_until', { withTimezone: true }).notNull(),
    refundedAt: timestamp('refunded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('payments_charge_uq').on(t.telegramPaymentChargeId),
    index('payments_user_idx').on(t.userId),
  ],
);

export type Entitlement = typeof entitlements.$inferSelect;
export type Payment = typeof payments.$inferSelect;

/**
 * Дедуп отправленных напоминаний об окончании доступа. Ключ (user_id, active_until, kind) UNIQUE:
 * каждое окно доступа (activeUntil) получает свой комплект напоминаний d3/d1/d0 ровно по разу
 * (claim через INSERT ... ON CONFLICT DO NOTHING). Продление двигает activeUntil → свежее окно.
 */
export const accessReminders = pgTable(
  'access_reminders',
  {
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    activeUntil: timestamp('active_until', { withTimezone: true }).notNull(),
    kind: text('kind').notNull(), // 'd3' | 'd1' | 'd0'
    sentAt: timestamp('sent_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('access_reminders_uq').on(t.userId, t.activeUntil, t.kind)],
);

export type AccessReminder = typeof accessReminders.$inferSelect;
