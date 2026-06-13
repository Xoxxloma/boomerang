import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/**
 * Сборка Telegram Mini App. Исходники — src/web, выход — dist/web (его раздаёт Hono в проде).
 * dev:web проксирует /api на локальный HTTP-сервер бота (WEB_PORT). Для реальных данных в dev нужен
 * валидный initData — обычно гоняем через Telegram/туннель; чистый браузер видит UI на мок-данных.
 */
export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('./dist/web', import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      // Должно совпадать с WEB_PORT в .env (см. .env.example).
      '/api': 'http://localhost:8787',
    },
    // Для теста в Telegram через cloudflared (npm run dev:tg): пускаем запросы с домена туннеля.
    // allowedHosts=true безвреден и для обычного dev:web (просто отключает проверку Host).
    allowedHosts: true,
    // HMR-сокет на https-порт 443 нужен ТОЛЬКО под туннелем (страница по https); для локального
    // dev:web это сломало бы HMR (браузер на localhost), поэтому включаем лишь по флагу из dev-tunnel.
    ...(process.env.TUNNEL ? { hmr: { clientPort: 443 } } : {}),
  },
});
