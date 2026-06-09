import { getBoss, Q_PROCESS, Q_FLUSH_ALBUM, Q_BURST_FLUSH, Q_PROCESS_DLQ } from './boss.js';

/** Координаты сообщения-квитанции поста (в личке chatId === userId) — чтобы L2 мог его править. */
export interface AckRef {
  chatId: number;
  messageId: number;
}

export interface ProcessJob {
  itemId: string;
  seedCategory: string;
  /** Сообщение «✅ Положил…» этого поста — правим его при сбое/успехе (есть только у одиночных пересылок). */
  ack?: AckRef;
  /** Повторная обработка по кнопке — при УСПЕХЕ обновить сообщение на «доиндексировал». */
  notifyOnSuccess?: boolean;
}

export interface FlushAlbumJob {
  gid: string;
}

export interface BurstFlushJob {
  userId: number;
}

/**
 * Окно debounce авто-флаша заливки (сек): срабатывает через столько после последней пересылки.
 * Длинное (30 мин) — чтобы паузы на пере-выделение очередной пачки по 100 не рвали сессию на куски.
 * Основной способ завершить заливку — кнопка «Готово»; этот таймаут лишь страховка от забытой сессии.
 */
const BURST_DEBOUNCE_SEC = 1800;

/**
 * Поставить L2-обработку item в фон (эмбеддинг/OCR/чтение док/кластер).
 * singletonKey=itemId дедупит повторные постановки одного item.
 */
export async function enqueueProcess(
  itemId: string,
  seedCategory: string,
  ack?: AckRef,
  notifyOnSuccess = false,
): Promise<void> {
  await getBoss().send(
    Q_PROCESS,
    { itemId, seedCategory, ack, notifyOnSuccess } satisfies ProcessJob,
    // deadLetter: исчерпав ретраи, задача копируется в Q_PROCESS_DLQ → оттуда правим сообщение поста.
    // retryDelay 8с: даём временному сбою (rate-limit/сеть) шанс, но не тянем — сбой всплывёт за ~25с.
    { singletonKey: itemId, retryLimit: 3, retryDelay: 8, deadLetter: Q_PROCESS_DLQ },
  );
}

/**
 * Запланировать флаш альбома с debounce: каждая новая часть продлевает окно, задача срабатывает
 * через ~2с после последней части. Один job на media_group_id.
 */
export async function enqueueAlbumFlush(gid: string): Promise<void> {
  await getBoss().sendDebounced(Q_FLUSH_ALBUM, { gid } satisfies FlushAlbumJob, { retryLimit: 2 }, 2, gid);
}

/**
 * Запланировать батч-флаш всплеска пересылок с debounce: каждая новая пересылка продлевает окно,
 * флаш срабатывает через BURST_DEBOUNCE_SEC после последней. Один job на пользователя.
 */
export async function enqueueBurstFlush(userId: number): Promise<void> {
  await getBoss().sendDebounced(
    Q_BURST_FLUSH,
    { userId } satisfies BurstFlushJob,
    { retryLimit: 2 },
    BURST_DEBOUNCE_SEC,
    String(userId),
  );
}
