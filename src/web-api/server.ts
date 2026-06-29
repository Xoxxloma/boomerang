import { Hono } from 'hono';
import { serve, type ServerType } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { env } from '../config/env.js';
import { telegramAuth, type InitDataUser } from './auth.js';
import { searchRoutes } from './routes/search.js';
import { mapRoutes } from './routes/map.js';
import { echoRoutes } from './routes/echo.js';
import { remindersRoutes } from './routes/reminders.js';
import { itemsRoutes } from './routes/items.js';
import { entitlementRoutes } from './routes/entitlement.js';
import { notifyAdmins } from '../bot/alerts.js';

/** Переменные контекста после telegramAuth — общий тип для всех роутов. */
export type AuthVars = { userId: number; tgUser: InitDataUser };

/** Корень собранного фронта (Vite build). Раздаём тем же сервером — один origin, без CORS. */
const WEB_ROOT = './dist/web';

function buildApp(): Hono {
  // Все /api/* под обязательной авторизацией Telegram initData.
  const api = new Hono<{ Variables: AuthVars }>();
  api.use('*', telegramAuth);
  api.route('/', searchRoutes);
  api.route('/', mapRoutes);
  api.route('/', echoRoutes);
  api.route('/', remindersRoutes);
  api.route('/', itemsRoutes);
  api.route('/', entitlementRoutes);

  const app = new Hono();
  app.get('/healthz', (c) => c.text('ok')); // для пробы Caddy/uptime
  app.route('/api', api);

  // Статика фронта + SPA-фолбэк: неизвестный путь (клиентский роут) отдаёт index.html.
  app.use('/*', serveStatic({ root: WEB_ROOT }));
  app.get('*', serveStatic({ path: `${WEB_ROOT}/index.html` }));

  // Глобальный перехват необработанных исключений роутов (сбой БД, неожиданная ошибка в synthesize и
  // т.п.). Без него Hono отдаёт текстовый 500 БЕЗ логирования — админы слепы, а фронт (api.ts парсит
  // тело как JSON) теряет контракт ошибки. Штатные ответы (429-бюджет, 400/404) возвращаются роутами
  // через c.json и сюда не попадают. notifyAdmins троттлит по ключу (путь+класс ошибки) — без флуда.
  app.onError((err, c) => {
    console.error('web-api error:', c.req.method, c.req.path, err);
    const name = err instanceof Error ? err.name : typeof err;
    const detail = err instanceof Error ? err.message : String(err);
    void notifyAdmins(
      `web-api:${c.req.path}:${name}`,
      `❌ web-api ${c.req.method} ${c.req.path}: ${name}: ${detail.slice(0, 300)}`,
    );
    return c.json({ error: 'internal' }, 500);
  });

  return app;
}

/**
 * Поднять HTTP-сервер Mini App в текущем процессе (рядом с ботом и воркерами). Бот на long polling
 * портов не слушает — конфликта нет. TLS снимает Caddy снаружи; сюда приходит plain HTTP на WEB_PORT.
 */
export function startWebServer(): ServerType {
  const app = buildApp();
  return serve({ fetch: app.fetch, port: env.WEB_PORT }, (info) => {
    console.log(`🌐 Mini App API слушает :${info.port}`);
  });
}
