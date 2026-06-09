import { PgBoss } from 'pg-boss';
import { env } from '../config/env.js';

/** Имена очередей L2. */
export const Q_PROCESS = 'l2-process';
export const Q_FLUSH_ALBUM = 'l2-flush-album';
export const Q_BURST_FLUSH = 'l2-burst-flush';
/** Dead-letter для l2-process: сюда pg-boss копирует задачу, исчерпавшую ретраи (реальный сбой). */
export const Q_PROCESS_DLQ = 'l2-process-dlq';

let boss: PgBoss | null = null;

/** Singleton pg-boss поверх той же Postgres (своя схема `pgboss`). */
export function getBoss(): PgBoss {
  if (!boss) {
    boss = new PgBoss({ connectionString: env.DATABASE_URL });
    boss.on('error', (err: unknown) => console.error('❌ pg-boss error:', err));
  }
  return boss;
}

/** Запустить pg-boss и создать очереди (нужно до send/work в v12). */
export async function startBoss(): Promise<PgBoss> {
  const b = getBoss();
  await b.start();
  // DLQ создаём до Q_PROCESS — на него ссылается deadLetter в enqueueProcess.
  await b.createQueue(Q_PROCESS_DLQ);
  await b.createQueue(Q_PROCESS);
  await b.createQueue(Q_FLUSH_ALBUM);
  await b.createQueue(Q_BURST_FLUSH);
  return b;
}

/** Остановить, дождавшись текущих задач. */
export async function stopBoss(): Promise<void> {
  if (boss) await boss.stop({ graceful: true });
}
