import { run } from '@grammyjs/runner';
import { createBot } from './bot/index.js';
import { queryClient } from './db/client.js';
import { terminateOcr } from './content/ocr.js';
import { setBotApi } from './bot/api.js';
import { startBoss, stopBoss } from './queue/boss.js';
import { startWorkers } from './queue/worker.js';

async function main() {
  const bot = createBot();
  setBotApi(bot.api); // воркерам нужен Telegram API (флаш альбома, скачивание файлов в L2)

  // Меню команд в клиенте Telegram (кнопка «/» и список). Без этого команд не видно.
  await bot.api.setMyCommands([
    { command: 'find', description: 'Поиск по сохранённому' },
    { command: 'import', description: 'Залить много старого из «Избранного»' },
    { command: 'folders', description: 'Папки: категории и каналы' },
    { command: 'digest', description: 'Темы за последнее время' },
    { command: 'settings', description: 'Напоминания из архива' },
    { command: 'start', description: 'О боте' },
  ]);

  // Профиль бота: текст на пустом экране чата (description) и в карточке (short_description).
  await bot.api.setMyDescription(
    '🪃 Boomerang — как «Избранное», только умное.\n' +
      'Пересылай статьи, посты, картинки и документы — без тегов и папок.\n' +
      'Сам разложу по полкам и верну связным ответом со ссылками, когда понадобится.\n' +
      'Нажми «Начать».',
  );
  await bot.api.setMyShortDescription(
    'Как «Избранное», только умное: пересылай — найду и верну связным ответом, когда понадобится. Без тегов и сортировки.',
  );

  // Очередь L2 (pg-boss поверх Postgres) + воркеры до старта приёма апдейтов.
  await startBoss();
  await startWorkers();

  // @grammyjs/runner — конкурентная обработка апдейтов.
  const runner = run(bot);
  console.log('🪃 Boomerang запущен');

  const stop = async () => {
    console.log('\nОстанавливаюсь…');
    if (runner.isRunning()) await runner.stop();
    await stopBoss().catch(() => {}); // дождаться текущих L2-задач
    await terminateOcr().catch(() => {});
    await queryClient.end({ timeout: 5 });
    process.exit(0);
  };

  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch((err) => {
  console.error('❌ Фатальная ошибка запуска:', err);
  process.exit(1);
});
