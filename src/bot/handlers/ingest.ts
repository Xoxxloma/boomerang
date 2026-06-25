import { InlineKeyboard, type Bot } from 'grammy';
import { bufferAlbumPart } from '../../ingest/album.js';
import { detect } from '../../ingest/detect.js';
import { saveItem, duplicateText } from '../../ingest/save.js';
import { maybeBufferBurst } from '../../import/burst.js';
import { isExportDocument, handleExport } from '../../import/export.js';
import { duplicateKeyboard } from './callbacks.js';

/**
 * Приём контента — Level 1 (синхронно, §5):
 * 1) мгновенное «Принял»; 2) сохранение item; 3) тяжёлое — в фон (L2), который добывает заголовок
 * и финализирует сообщение «✅ Принял — «заголовок»». Альбомы (media group) склеиваются в один пост.
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

    // Сырой набранный текст (юзер напечатал сам — без ссылки, пересыла, медиа): намерение неоднозначно
    // (заметка или поиск?). Вместо немедленного сохранения — развилка «Найти / Сохранить» (обработка
    // в callbacks.ts: fork:*). Пересылы, ссылки, файлы, фото-с-подписью, голос идут прежним путём
    // (намерение «сохранить» очевидно). text!=null отсекает фото-с-подписью (её текст лежит в caption).
    const det = detect(ctx.message);
    const typed = ctx.message.text?.trim();
    if (det.type === 'text' && ctx.message.text != null && !ctx.message.forward_origin && !det.url && typed) {
      await ctx.reply('Что делаем?', {
        reply_parameters: { message_id: ctx.message.message_id },
        reply_markup: new InlineKeyboard().text('🔍 Найти', 'fork:search').text('💾 Сохранить', 'fork:save'),
      });
      return;
    }

    const ack = await ctx.reply('Принял ✅', {
      reply_parameters: { message_id: ctx.message.message_id },
    });

    try {
      // Координаты ack-сообщения → L2 сможет отредактировать его при сбое индексации (1.4).
      const ackRef = { chatId: ack.chat.id, messageId: ack.message_id };
      // detectReminder только здесь — живой одиночный приём. Альбом/burst/импорт зовут saveItem без флага.
      const { item, duplicate } = await saveItem(ctx.api, ctx.from.id, ctx.message, ackRef, {
        detectReminder: true,
      });
      if (duplicate) {
        // Тот же пост уже сохранён → не задвоили; даём перейти к оригиналу (§ тезис: дубли не копим).
        await ctx.api.editMessageText(ack.chat.id, ack.message_id, duplicateText(item), {
          reply_markup: duplicateKeyboard(item),
        });
      } else {
        // L2 добудет заголовок (vision/STT/OG) и финализирует это сообщение «✅ Принял — «заголовок»»
        // (см. queue/worker.ts). Промежуточный статус — честное «обрабатываю». Голос/видео под
        // транскрипцию идут дольше — отдельная формулировка.
        const transcribing = (item.type === 'voice' || item.type === 'video') && item.tgFileId;
        await ctx.api.editMessageText(
          ack.chat.id,
          ack.message_id,
          transcribing ? '🎙 Принял, расшифровываю…' : '🔖 Принял, обрабатываю…',
        );
      }
    } catch (err) {
      console.error('ingest error:', err);
      await ctx.api
        .editMessageText(ack.chat.id, ack.message_id, '✅ Принял (доиндексирую чуть позже)')
        .catch(() => {});
    }
  });
}
