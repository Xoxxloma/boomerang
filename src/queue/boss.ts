import { PgBoss } from 'pg-boss';
import { env } from '../config/env.js';

/** Имена очередей L2. */
export const Q_PROCESS = 'l2-process';
export const Q_FLUSH_ALBUM = 'l2-flush-album';
export const Q_BURST_FLUSH = 'l2-burst-flush';
/** Dead-letter для l2-process: сюда pg-boss копирует задачу, исчерпавшую ретраи (реальный сбой). */
export const Q_PROCESS_DLQ = 'l2-process-dlq';
/** Cron-sweep напоминаний: раз в минуту забираем созревшие (remind_at <= now) и доставляем. */
export const Q_REMIND_SWEEP = 'reminders-sweep';

let boss: PgBoss | null = null;

/** Singleton pg-boss поверх той же Postgres (своя схема `pgboss`). */
export function getBoss(): PgBoss {
  if (!boss) {
    // pg-boss использует драйвер pg — SSL задаётся объектом (не строкой, как у postgres.js).
    boss = new PgBoss({
      connectionString: env.DATABASE_URL,
      ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
    });
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
  await b.createQueue(Q_REMIND_SWEEP);
  // Раз в минуту кладём пустую задачу в Q_REMIND_SWEEP — воркер забирает созревшие напоминания из БД.
  // Идемпотентно по имени очереди: повторный schedule на старте просто обновляет расписание.
  await b.schedule(Q_REMIND_SWEEP, '* * * * *');
  return b;
}

/** Остановить, дождавшись текущих задач. */
export async function stopBoss(): Promise<void> {
  if (boss) await boss.stop({ graceful: true });
}
