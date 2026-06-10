import type { Bot } from 'grammy';
import { bufferAlbumPart } from '../../ingest/album.js';
import { saveItem, label, duplicateText } from '../../ingest/save.js';
import { maybeBufferBurst } from '../../import/burst.js';
import { isExportDocument, handleExport } from '../../import/export.js';
import { IMAGE_SHELF } from '../../cluster/assign.js';
import { fixKeyboard, sourceKeyboard } from './callbacks.js';

/**
 * Приём контента — Level 1 (синхронно, §5):
 * 1) мгновенное «Принял»; 2) дешёвый сигнал; 3) сохранение item; 4) категория; 5) edit с
 * авто-категорией; 6) тяжёлое — в фон (L2). Альбомы (media group) склеиваются в один пост.
 */
export function registerIngest(bot: Bot): void {
  bot.on('message', async (ctx) => {
    const rawText = ctx.message.text ?? ctx.message.caption ?? '';
    if (rawText.startsWith('/')) return; // команды — отдельно

    // JSON-экспорт Saved Messages → батч-залив. Если .json оказался НЕ экспортом Telegram —
    // handleExport вернёт false, и файл уйдёт в обычный приём ниже (сохранится как документ).
    if (isExportDocument(ctx.message) && (await handleExport(ctx.api, ctx.message))) {
      return;
    }

    // Идёт сессия заливки (явная /import или авто-старт по всплеску) → копим ВСЁ в один буфер,
    // включая члены альбома. Проверяем РАНЬШЕ ветки альбома, чтобы альбомы не уходили своим путём.
    if (await maybeBufferBurst(ctx.api, ctx.message)) return;

    // Альбом вне заливки → склейка по media_group (свой «Принял» и debounce-флаш).
    if (ctx.message.media_group_id) {
      await bufferAlbumPart(ctx.api, ctx.message);
      return;
    }

    const ack = await ctx.reply('Принял ✅', {
      reply_parameters: { message_id: ctx.message.message_id },
    });

    try {
      // Координаты ack-сообщения → L2 сможет отредактировать его при сбое индексации (1.4).
      const ackRef = { chatId: ack.chat.id, messageId: ack.message_id };
      const { item, category, duplicate } = await saveItem(ctx.api, ctx.from.id, ctx.message, ackRef);
      if (duplicate) {
        // Тот же пост уже сохранён → не задвоили; даём перейти к оригиналу (§ тезис: дубли не копим).
        await ctx.api.editMessageText(ack.chat.id, ack.message_id, duplicateText(item, category), {
          reply_markup: sourceKeyboard(item),
        });
      } else if (category === IMAGE_SHELF) {
        // Картинки детерминированно идут на полку «Изображения» — сразу финал, без «предварительно».
        await ctx.api.editMessageText(ack.chat.id, ack.message_id, `✅ Положил в ${label(item.title, category)}`, {
          reply_markup: fixKeyboard(item.id),
        });
      } else {
        // L1-метка предварительна: реальную полку определит L2 (assignCluster по эмбеддингу) и
        // финализирует это сообщение шагом «Положил в …» с кнопками (см. queue/worker.ts).
        // БЕЗ клавиатуры: «Не та тема»/«Удалить» появятся только на финале — пока тема не определена,
        // править/лочить категорию нечего (заодно нет гонки lock-до-L2).
        await ctx.api.editMessageText(
          ack.chat.id,
          ack.message_id,
          `🔖 Принял, определяю тему… (предварительно «${category}»)`,
        );
      }
    } catch (err) {
      console.error('ingest error:', err);
      await ctx.api
        .editMessageText(ack.chat.id, ack.message_id, '✅ Принял (категорию определю чуть позже)')
        .catch(() => {});
    }
  });
}
