import { getBoss, Q_PROCESS, Q_FLUSH_ALBUM, Q_BURST_FLUSH } from './boss.js';
import type { ProcessJob, FlushAlbumJob, BurstFlushJob } from './index.js';
import { processItem } from './jobs/process.js';
import { flushAlbum } from '../ingest/album.js';
import { flushBurst } from '../import/burst.js';
import { getBotApi } from '../bot/api.js';

/**
 * Регистрирует воркеры L2. Живут в процессе бота: флаш альбома использует Telegram API (getBotApi).
 * processItem — self-contained (без Telegram).
 */
export async function startWorkers(): Promise<void> {
  const boss = getBoss();

  await boss.work<ProcessJob>(Q_PROCESS, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      await processItem(job.data.itemId, job.data.seedCategory);
    }
  });

  await boss.work<FlushAlbumJob>(Q_FLUSH_ALBUM, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      await flushAlbum(getBotApi(), job.data.gid);
    }
  });

  await boss.work<BurstFlushJob>(Q_BURST_FLUSH, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      await flushBurst(getBotApi(), job.data.userId);
    }
  });

  console.log('🛠  L2-воркеры запущены');
}
