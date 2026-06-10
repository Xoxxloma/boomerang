import { run } from '@grammyjs/runner';
import { createBot } from './bot/index.js';
import { queryClient } from './db/client.js';
import { terminateOcr } from './content/ocr.js';
import { setBotApi } from './bot/api.js';
import { startBoss, stopBoss } from './queue/boss.js';
import { startWorkers } from './queue/worker.js';
import { rehydrateToday, flushToday } from './db/usage.js';
import { notifyAdmins } from './bot/alerts.js';

/** Как часто сбрасывать дневной учёт расхода в БД (мс) — чтобы рестарт не обнулял лимиты. */
const USAGE_FLUSH_INTERVAL_MS = 60_000;

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

  // Очередь L2 (pg-boss поверх Postgres). Создаём очереди ДО регидрации и воркеров.
  await startBoss();

  // Подтянуть сегодняшний учёт расхода из БД (бюджет-гарды) — ОБЯЗАТЕЛЬНО до старта воркеров. L2-джобы
  // (эмбеддинги) тоже тратят бюджет и зовут enforce/recordUsage; если поднять воркеров раньше,
  // забэкложенные на старте джобы прошли бы мимо лимитов (in-memory счётчики = 0), а их расход затёрла бы
  // регидрация (hydrateUsage перезаписывает буферы). Сбой регидрации = старт со счётчиками 0 → лимиты и
  // breaker сброшены на этот UTC-день. Старт НЕ блокируем (бот без учёта лучше, чем не поднявшийся), но
  // шумим в лог И зовём админов — молчаливый сброс лимитов недопустим. Срабатывает только на старте.
  await rehydrateToday().catch((err) => {
    console.error('usage rehydrate error:', err);
    void notifyAdmins(
      'rehydrate-failed',
      '⚠️ Не удалось поднять дневной учёт расхода из БД на старте — лимиты стартуют с нуля на этот ' +
        'UTC-день (бюджет-гард ослаблен). Проверь БД / таблицу usage_daily.',
    );
  });

  // Воркеры L2 — только ПОСЛЕ регидрации (см. выше) + периодический флаш учёта в БД.
  await startWorkers();
  const usageFlushTimer = setInterval(() => {
    flushToday().catch((err) => console.error('usage flush error:', err));
  }, USAGE_FLUSH_INTERVAL_MS);

  // @grammyjs/runner — конкурентная обработка апдейтов.
  const runner = run(bot);
  console.log('🪃 Boomerang запущен');

  const stop = async () => {
    console.log('\nОстанавливаюсь…');
    if (runner.isRunning()) await runner.stop();
    clearInterval(usageFlushTimer);
    await flushToday().catch(() => {}); // финальный флаш учёта, чтобы не потерять день
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
