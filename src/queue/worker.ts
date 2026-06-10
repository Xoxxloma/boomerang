import { InlineKeyboard } from 'grammy';
import { getBoss, Q_PROCESS, Q_FLUSH_ALBUM, Q_BURST_FLUSH, Q_PROCESS_DLQ } from './boss.js';
import type { ProcessJob, FlushAlbumJob, BurstFlushJob } from './index.js';
import { processItem } from './jobs/process.js';
import { flushAlbum } from '../ingest/album.js';
import { flushBurst, notifyBurstFlushFailed } from '../import/burst.js';
import { getItem, itemDisplayName } from '../db/items.js';
import { label } from '../ingest/save.js';
import { fixKeyboard } from '../bot/handlers/callbacks.js';
import { getBotApi } from '../bot/api.js';
import { notifyAdmins } from '../bot/alerts.js';
import { QuotaExceededError, BudgetExhaustedError } from '../ai/errors.js';
import { formatResetUtc } from '../ai/usage.js';

/**
 * Регистрирует воркеры L2. Живут в процессе бота: флаш альбома использует Telegram API (getBotApi).
 * processItem — self-contained (без Telegram).
 */
export async function startWorkers(): Promise<void> {
  const boss = getBoss();

  await boss.work<ProcessJob>(Q_PROCESS, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      let clusterName: string | null = null;
      try {
        clusterName = await processItem(job.data.itemId, job.data.seedCategory);
      } catch (err) {
        // Бюджет-гард: персональный потолок / глобальный paused. Ретраить бессмысленно (лимит за
        // ~25с не уйдёт), DLQ дал бы обезличенный «сбой». Правим сообщение точным текстом и НЕ
        // пробрасываем: item остаётся indexedAt=null → переиндексируется кнопкой/reindex после сброса.
        if (err instanceof QuotaExceededError || err instanceof BudgetExhaustedError) {
          const { itemId, seedCategory, ack } = job.data;
          if (ack) {
            const item = await getItem(itemId);
            if (item) {
              const name = itemDisplayName(item);
              const kb = new InlineKeyboard().text('🔄 Повторить', `reidx:${itemId}`);
              const text =
                err instanceof QuotaExceededError
                  ? `⚠️ «${name}» — сохранил в «${seedCategory}», но твой дневной лимит исчерпан. ` +
                    `Проиндексирую после ${formatResetUtc(err.resetsAt)}.`
                  : `⚠️ «${name}» — сохранил в «${seedCategory}», но сервис под повышенной нагрузкой. ` +
                    `Проиндексирую чуть позже.`;
              await getBotApi()
                .editMessageText(ack.chatId, ack.messageId, text, { reply_markup: kb })
                .catch(() => {});
            }
          }
          continue;
        }
        // Логируем с itemId (глобальный хендлер pg-boss его не знает) и пробрасываем —
        // pg-boss ретраит, а исчерпав ретраи, скопирует задачу в Q_PROCESS_DLQ.
        console.error('process failed', { itemId: job.data.itemId, err });
        throw err;
      }
      // Успех ПОВТОРНОЙ обработки (по кнопке) → честно обновляем сообщение поста: теперь найдётся.
      const { ack, notifyOnSuccess, itemId, seedCategory } = job.data;
      if (notifyOnSuccess && ack) {
        const item = await getItem(itemId);
        const name = item ? itemDisplayName(item) : 'запись';
        await getBotApi()
          .editMessageText(ack.chatId, ack.messageId, `✅ Доиндексировал «${name}» — теперь найду в поиске.`)
          .catch(() => {});
        continue;
      }

      // Шаг 3: финализируем «предварительно «X»» → реальная полка. Только одиночные пересылки (есть ack),
      // не картинки (у них сразу финал на L1), не вручную перенесённые (их сообщение уже финализировано
      // fix-флоу — «Перенёс в…», не затираем). clusterName null без locked (нет текста/кластера) →
      // фоллбэк на seedCategory, чтобы сообщение не зависло на «предварительно».
      if (ack) {
        const item = await getItem(itemId);
        if (item && item.type !== 'image' && !item.clusterLocked) {
          const finalName = clusterName ?? seedCategory;
          await getBotApi()
            .editMessageText(ack.chatId, ack.messageId, `✅ Положил в ${label(item.title, finalName)}`, {
              reply_markup: fixKeyboard(itemId),
            })
            .catch(() => {});
        }
      }
    }
  });

  // Dead-letter: задача l2-process исчерпала ретраи (реальный сбой, напр. embed-API).
  // Правим САМО сообщение поста («✅ Положил…» → честный статус) + кнопка повтора. Без обезличенных
  // уведомлений: ack есть только у одиночных пересылок (у альбома/заливки общий ack — пропускаем).
  await boss.work<ProcessJob>(Q_PROCESS_DLQ, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      const { itemId, seedCategory, ack } = job.data;
      if (!ack) continue;
      const item = await getItem(itemId);
      if (!item) continue;
      const kb = new InlineKeyboard().text('🔄 Повторить', `reidx:${itemId}`);
      await getBotApi()
        .editMessageText(
          ack.chatId,
          ack.messageId,
          `⚠️ «${itemDisplayName(item)}» — сохранил в «${seedCategory}», но не смог проиндексировать. ` +
            `В поиске пока не найду.`,
          { reply_markup: kb },
        )
        .catch(() => {});
    }
  });

  await boss.work<FlushAlbumJob>(Q_FLUSH_ALBUM, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      await flushAlbum(getBotApi(), job.data.gid);
    }
  });

  await boss.work<BurstFlushJob>(Q_BURST_FLUSH, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      const { userId } = job.data;
      try {
        await flushBurst(getBotApi(), userId);
      } catch (err) {
        // Бюджет-стоп flushBurst обрабатывает сам (правит прогресс). Сюда долетают прочие сбои
        // (сеть/embed-API): у Q_BURST_FLUSH нет DLQ, и без этого падение авто-флаша было «слепым» —
        // ни юзер, ни админ не узнавали. Буфер/сессия целы (flushBurst при броске их не трогает).
        console.error('burst flush failed', { userId, err });
        await notifyBurstFlushFailed(getBotApi(), userId).catch(() => {});
        void notifyAdmins(
          'burst-flush-failed',
          `⚠️ Авто-флаш заливки упал у пользователя ${userId}. Буфер сохранён, но итог не доехал — ` +
            `проверь логи (сеть/embed-API). Юзер может дожать кнопкой «Готово».`,
        );
        throw err; // пробрасываем: pg-boss доретраит (retryLimit:2)
      }
    }
  });

  console.log('🛠  L2-воркеры запущены');
}
