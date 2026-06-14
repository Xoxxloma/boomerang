import { getBoss, Q_PROCESS, Q_FLUSH_ALBUM, Q_BURST_FLUSH, Q_PROCESS_DLQ, Q_REMIND_SWEEP } from './boss.js';

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
  /**
   * Голос/видео сохранён БЕЗ расшифровки по известной на L1 причине (файл >20MB — Bot API не отдаст).
   * Worker честно допишет это к «Положил…». В payload, а не вычислением в L2: там по отсутствию
   * tgFileId большой файл неотличим от gif (у которого нет аудиодорожки и предупреждать не о чем).
   */
  sttSkipReason?: 'too_big';
}

export interface FlushAlbumJob {
  gid: string;
}

export interface BurstFlushJob {
  userId: number;
  /** true — это «жнец» забытой пустой сессии (reapEmptyImport), а не флаш буфера. */
  reap?: boolean;
}

/**
 * Кикофф авто-флаша заливки: первая пересылка ставит флаш через BURST_KICKOFF_SEC, дальше трейлинг-
 * завершение «через N секунд тишины» ведут гейт оседания (tuning.burstSettleMs) + само-перезапуск
 * enqueueBurstReflush в import/burst.ts. НЕ используем sendDebounced: его слот привязан к 30-мин окну,
 * и второй /import в том же окне не получал бы задачу (singleton-слот занят). singletonKey без
 * singletonSeconds допускает новую задачу, как только прошлая завершилась — по задаче на сессию.
 */
const BURST_KICKOFF_SEC = 3;

/** Короткий добор флаша: пока на момент флаша ещё «сыпались» части, дольём через столько секунд. */
const BURST_REFLUSH_SEC = 3;

/** «Жнец» пустой сессии: гасим забытый /import без единой пересылки через столько секунд после старта. */
const BURST_REAP_SEC = 300;

/**
 * Поставить L2-обработку item в фон (эмбеддинг/OCR/чтение док/кластер).
 * singletonKey=itemId дедупит повторные постановки одного item.
 */
export async function enqueueProcess(
  itemId: string,
  seedCategory: string,
  ack?: AckRef,
  notifyOnSuccess = false,
  sttSkipReason?: 'too_big',
): Promise<void> {
  await getBoss().send(
    Q_PROCESS,
    { itemId, seedCategory, ack, notifyOnSuccess, sttSkipReason } satisfies ProcessJob,
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
 * Кикофф батч-флаша всплеска пересылок (leading-edge, см. коммент к BURST_DEBOUNCE_SEC): первая
 * пересылка запускает флаш почти сразу, дальше завершение ведёт гейт оседания + reflush. Один job на юзера.
 */
export async function enqueueBurstFlush(userId: number): Promise<void> {
  await getBoss().send(Q_BURST_FLUSH, { userId } satisfies BurstFlushJob, {
    startAfter: BURST_KICKOFF_SEC,
    singletonKey: `flush:${userId}`,
    retryLimit: 2,
  });
}

/**
 * Короткий добор флаша заливки: ставится, когда флаш отложен из-за ещё «оседающих» частей (пришли
 * только что). Отдельный singletonKey, чтобы не конфликтовать с дебаунс-флашем (ключ = userId).
 */
export async function enqueueBurstReflush(userId: number): Promise<void> {
  await getBoss().send(Q_BURST_FLUSH, { userId } satisfies BurstFlushJob, {
    startAfter: BURST_REFLUSH_SEC,
    singletonKey: `reflush:${userId}`,
    retryLimit: 2,
  });
}

/**
 * «Жнец» забытой пустой сессии: ставится на старте /import. Через BURST_REAP_SEC reapEmptyImport
 * закроет сессию, только если в неё так и не пришло ни одной пересылки (начатую заливку не трогает).
 * БЕЗ singletonKey — каждый /import ставит свой таймер; лишние срабатывания идемпотентны (гасим лишь
 * пустую и достаточно старую сессию). retryLimit:1 — пропуск не критичен.
 */
export async function enqueueBurstReap(userId: number): Promise<void> {
  await getBoss().send(Q_BURST_FLUSH, { userId, reap: true } satisfies BurstFlushJob, {
    startAfter: BURST_REAP_SEC,
    retryLimit: 1,
  });
}

/**
 * Отложенный флаш заливки на конкретный момент: авто-возобновление после сброса дневного лимита
 * расхода (бюджет-стоп оставил часть буфера). singletonKey гасит дубли постановки.
 */
export async function enqueueBurstFlushAt(userId: number, startAfterSec: number): Promise<void> {
  await getBoss().send(Q_BURST_FLUSH, { userId } satisfies BurstFlushJob, {
    startAfter: Math.max(1, Math.floor(startAfterSec)),
    singletonKey: `resume:${userId}`,
    retryLimit: 2,
  });
}

/**
 * «Вернуть сейчас» (кнопка в вебаппе): немедленно дёргаем sweep, не дожидаясь минутного cron.
 * Само напоминание уже помечено созревшим (setReminder с now) выше по стеку — воркер заберёт его
 * тем же claimDueReminders. singletonKey по itemId гасит дубль-тапы. retryLimit:0 — пропуск тика
 * не критичен (минутный cron подберёт следом).
 */
export async function enqueueRemindNow(itemId: string): Promise<void> {
  await getBoss().send(Q_REMIND_SWEEP, {}, { singletonKey: `now:${itemId}`, retryLimit: 0 });
}
