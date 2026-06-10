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

export const users = pgTable('users', {
  id: bigint('id', { mode: 'number' }).primaryKey(), // tg user id
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  importDone: boolean('import_done').default(false).notNull(),
  // напр. { proactive_surfacing: false } — режим 2 выключен по умолчанию
  settings: jsonb('settings').$type<Record<string, unknown>>().default({}).notNull(),
});

export const clusters = pgTable(
  'clusters',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    name: text('name').notNull(), // человеческое имя от LLM
    centroid: vector('centroid', { dimensions: EMBEDDING_DIM }),
    size: integer('size').default(0).notNull(),
    // Когда по кластеру слали maturity-напоминание (проактивное всплытие, режим 2). NULL — ещё не слали.
    maturedAt: timestamp('matured_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('clusters_user_idx').on(t.userId),
    index('clusters_centroid_idx').using('hnsw', t.centroid.op('vector_cosine_ops')),
  ],
);

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
    // Идентификаторы файла в Telegram. Сам файл на диске НЕ храним (хранение ≠ ценность);
    // байты качаем во временный файл по требованию (L2 OCR/чтение документа) и удаляем.
    tgFileId: text('tg_file_id'), // для повторного скачивания через getFile (может протухать со временем)
    tgFileUniqueId: text('tg_file_unique_id'), // стабильный id для дедупа (скачать по нему нельзя)
    // media_group_id альбома (общий у всех членов); NULL у не-альбомных. Признак «эта группа уже стала
    // постом» — чтобы опоздавший член-осколок не уехал отдельной картинкой на полку (см. groupsAlreadyPosted).
    mediaGroupId: text('media_group_id'),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIM }),
    clusterId: uuid('cluster_id').references(() => clusters.id, { onDelete: 'set null' }),
    clusterLocked: boolean('cluster_locked').default(false).notNull(), // правил вручную
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    indexedAt: timestamp('indexed_at', { withTimezone: true }), // когда прошёл L2
  },
  (t) => [
    index('items_user_idx').on(t.userId),
    index('items_cluster_idx').on(t.clusterId),
    index('items_user_media_group_idx').on(t.userId, t.mediaGroupId),
    index('items_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
  ],
);

export type Item = typeof items.$inferSelect;
export type NewItem = typeof items.$inferInsert;
export type Cluster = typeof clusters.$inferSelect;
export type User = typeof users.$inferSelect;

/**
 * Журнал проактивных всплытий (режим 2): что и когда показали боту по своей инициативе.
 * Назначение — дедуп (не показывать один и тот же старый item повторно слишком часто) +
 * минимальная история на будущее (сигнал, аналитика). Реакции/оценки в первой итерации не храним.
 */
export const surfacingKind = pgEnum('surfacing_kind', ['resonance', 'maturity']);

export const surfacingLog = pgTable(
  'surfacing_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    kind: surfacingKind('kind').notNull(),
    itemId: uuid('item_id'), // показанный старый item (для resonance); NULL для maturity
    clusterId: uuid('cluster_id'),
    triggerItemId: uuid('trigger_item_id'), // новое сообщение-повод
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('surfacing_user_idx').on(t.userId),
    index('surfacing_user_item_idx').on(t.userId, t.itemId),
  ],
);

/**
 * Сессия правки категории: какой item правится для конкретного L1-сообщения.
 * Вынесена из памяти процесса в БД (durable + работает при нескольких инстансах бота).
 */
export const editPending = pgTable(
  'edit_pending',
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
