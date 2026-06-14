import { InlineKeyboard } from 'grammy';
import { getBoss, Q_PROCESS, Q_FLUSH_ALBUM, Q_BURST_FLUSH, Q_PROCESS_DLQ, Q_REMIND_SWEEP } from './boss.js';
import type { ProcessJob, FlushAlbumJob, BurstFlushJob } from './index.js';
import { processItem, type ProcessResult } from './jobs/process.js';
import { flushAlbum, notifyAlbumFlushFailed } from '../ingest/album.js';
import { flushBurst, notifyBurstFlushFailed, reapEmptyImport } from '../import/burst.js';
import { getItem, itemDisplayName } from '../db/items.js';
import { label } from '../ingest/save.js';
import { getBotApi } from '../bot/api.js';
import { notifyAdmins } from '../bot/alerts.js';
import { QuotaExceededError, BudgetExhaustedError } from '../ai/errors.js';
import { formatResetUtc } from '../ai/usage.js';
import { claimDueReminders, getReminderSettings } from '../db/reminders.js';
import { deliverReminder } from '../reminders/deliver.js';
import { formatRemindAt } from '../reminders/format.js';
import { tuning } from '../config/tuning.js';
import type { Item } from '../db/schema.js';

/**
 * Строка возврата для финального сообщения поста, если на item стоит активное напоминание. Reminder
 * показываем ВПЕРВЫЕ именно здесь (L1-ack не трогаем — там ещё идёт обработка). Без неё L2 затёр бы
 * подтверждение возврата.
 */
async function remindLine(item: Item): Promise<string> {
  if (!item.remindAt || item.remindStatus !== 'pending') return '';
  const { tz } = await getReminderSettings(item.userId);
  return `\n🪃 Верну ${formatRemindAt(item.remindAt, tz)}`;
}

/**
 * Регистрирует воркеры L2. Живут в процессе бота: флаш альбома использует Telegram API (getBotApi).
 * processItem — self-contained (без Telegram).
 */
export async function startWorkers(): Promise<void> {
  const boss = getBoss();

  await boss.work<ProcessJob>(Q_PROCESS, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      let res: ProcessResult = { clusterName: null, docUnreadable: false };
      try {
        res = await processItem(job.data.itemId, job.data.seedCategory);
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
      // Документ остался без тела (скан/неподдержанный формат) — честно предупреждаем, а не
      // делаем вид, что всё проиндексировано: найдётся он только по имени файла и подписи.
      // Аналогично голос/видео >20MB (Bot API не отдаёт ботам): сохранили без расшифровки —
      // скажем прямо, иначе юзер будет ждать от поиска содержимое ролика и не понимать промахи.
      const warn =
        (res.docUnreadable
          ? '\n⚠️ Содержимое файла прочитать не смог — найду его только по имени и подписи.'
          : '') +
        (job.data.sttSkipReason === 'too_big'
          ? '\n⚠️ Файл больше 20MB — Telegram не отдаёт такие ботам, сохранил без расшифровки: найду по подписи и названию.'
          : '');

      // Успех ПОВТОРНОЙ обработки (по кнопке) → честно обновляем сообщение поста: теперь найдётся.
      const { ack, notifyOnSuccess, itemId, seedCategory } = job.data;
      if (notifyOnSuccess && ack) {
        const item = await getItem(itemId);
        const name = item ? itemDisplayName(item) : 'запись';
        await getBotApi()
          .editMessageText(ack.chatId, ack.messageId, `✅ Доиндексировал «${name}» — теперь найду в поиске.${warn}`)
          .catch(() => {});
        continue;
      }

      // Шаг 3: финализируем «предварительно «X»» → реальная полка. Только одиночные пересылки (есть ack),
      // не вручную перенесённые (их сообщение уже финализировано fix-флоу — «Перенёс в…», не затираем).
      // Картинки тоже финализируются здесь: vision (L2) даёт реальную тему; без темы clusterName null →
      // фоллбэк на seedCategory («Изображения»), чтобы сообщение не зависло на «предварительно».
      if (ack) {
        const item = await getItem(itemId);
        if (item && !item.clusterLocked) {
          const finalName = res.clusterName ?? seedCategory;
          // Если на item стоит напоминание — дописываем строку возврата (иначе затёрли бы L1-постановку).
          const remind = await remindLine(item);
          // Без кнопок: управление записью (напомнить/перенести/удалить) живёт в карточке события
          // (cardKeyboard), а не на сообщении-приёме. Финал — просто честный статус.
          await getBotApi()
            .editMessageText(ack.chatId, ack.messageId, `✅ Положил в ${label(item.title, finalName)}${warn}${remind}`)
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
      const { gid } = job.data;
      try {
        await flushAlbum(getBotApi(), gid);
      } catch (err) {
        // У Q_FLUSH_ALBUM нет DLQ: без этого падение флаша было «слепым» — части навсегда висят в
        // album_part, а ack замер на «Принял ✅» (юзер думает, что альбом сохранён). Правим ack на
        // честный статус + алерт админам. Части/сессия целы (flushAlbum при броске их не трогает).
        console.error('album flush failed', { gid, err });
        await notifyAlbumFlushFailed(getBotApi(), gid).catch(() => {});
        void notifyAdmins(
          'album-flush-failed',
          `⚠️ Флаш альбома ${gid} упал. Части сохранены, но итог не доехал — проверь логи (сеть/БД).`,
        );
        throw err; // пробрасываем: pg-boss доретраит (retryLimit:2)
      }
    }
  });

  await boss.work<BurstFlushJob>(Q_BURST_FLUSH, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      const { userId, reap } = job.data;
      // «Жнец» забытой пустой сессии (enqueueBurstReap): не флашит — гасит сессию, если в неё так и
      // не пришло ни одной пересылки. Идемпотентен и безопасен для начатой заливки (проверки внутри).
      if (reap) {
        await reapEmptyImport(getBotApi(), userId).catch((err: unknown) =>
          console.error('burst reap failed', { userId, err }),
        );
        continue;
      }
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
            `проверь логи (сеть/embed-API). Дольётся сам ретраем/следующей пересылкой.`,
        );
        throw err; // пробрасываем: pg-boss доретраит (retryLimit:2)
      }
    }
  });

  // Sweep напоминаний: минутный cron (boss.schedule в boss.ts) кладёт пустую задачу — забираем
  // созревшие напоминания (claim под row-lock) и доставляем. batchSize:1 — задачи не копятся, тик лёгкий.
  await boss.work(Q_REMIND_SWEEP, { batchSize: 1 }, async () => {
    const due = await claimDueReminders(new Date(), tuning.remindSweepBatch);
    for (const item of due) {
      await deliverReminder(item);
    }
  });

  console.log('🛠  L2-воркеры запущены');
}
