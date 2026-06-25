import { run } from '@grammyjs/runner';
import { createBot } from './bot/index.js';
import { queryClient } from './db/client.js';
import { terminateOcr } from './content/ocr.js';
import { setBotApi } from './bot/api.js';
import { startBoss, stopBoss } from './queue/boss.js';
import { startWorkers } from './queue/worker.js';
import { rehydrateToday, flushToday } from './db/usage.js';
import { notifyAdmins } from './bot/alerts.js';
import { startWebServer } from './web-api/server.js';

/** Как часто сбрасывать дневной учёт расхода в БД (мс) — чтобы рестарт не обнулял лимиты. */
const USAGE_FLUSH_INTERVAL_MS = 60_000;

async function main() {
  const bot = createBot();
  setBotApi(bot.api); // воркерам нужен Telegram API (флаш альбома, скачивание файлов в L2)

  // Меню команд в клиенте Telegram (кнопка «/» и список). Без этого команд не видно.
  await bot.api.setMyCommands([
    { command: 'find', description: 'Найти по смыслу → связный ответ со ссылками' },
    { command: 'app', description: 'Приложение: карта, переклички, напоминания, поиск' },
    { command: 'folders', description: 'Источники: каналы и загруженное вручную' },
    { command: 'digest', description: 'Свежее за неделю: что стоит вернуть' },
    { command: 'import', description: 'Залить старое из «Избранного» пачкой' },
    { command: 'help', description: 'Написать в поддержку' },
    { command: 'start', description: 'Что умеет бот' },
  ]);

  // Кнопка-меню рядом с полем ввода = СПИСОК КОМАНД (дефолт Telegram). В Mini App входят с постоянной
  // reply-клавиатуры (кнопка «🪃 Приложение», см. search.ts) и из /start — так остаются И команды, И вебапп
  // (одна кнопка-меню не может быть сразу и тем, и другим). Сбрасываем возможный прежний web_app-режим.
  await bot.api.setChatMenuButton({ menu_button: { type: 'commands' } });

  // Профиль бота: текст на пустом экране чата (description) и в карточке (short_description).
  await bot.api.setMyDescription(
    'Boomerang — что отправил, вернётся, когда понадобится.\n' +
      'Пересылай ссылки, посты, картинки, голосовые, видео и документы — без тегов и папок. ' +
      'Бот распознаёт текст на фото и речь в аудио, разложит по источникам и поднимет нужное в момент: ' +
      'найдёт по смыслу со ссылками или напомнит сам.\n' +
      'Нажми «Начать».',
  );
  await bot.api.setMyShortDescription(
    'Пересылай что угодно — найду по смыслу и верну в нужный момент. Фото и голос распознаю. Без тегов и сортировки.',
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

  // HTTP-сервер Mini App (Hono) — в том же процессе; бот на long polling портов не слушает.
  const webServer = startWebServer();

  // @grammyjs/runner — конкурентная обработка апдейтов.
  const runner = run(bot);
  console.log('🪃 Boomerang запущен');

  const stop = async () => {
    console.log('\nОстанавливаюсь…');
    if (runner.isRunning()) await runner.stop();
    webServer.close();
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
