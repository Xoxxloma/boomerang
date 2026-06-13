// Локальное тестирование Mini App ВНУТРИ Telegram через cloudflared (trycloudflare).
//
// Почему cloudflared, а не ngrok: ngrok блокирует датацентр/VPN-IP (ERR_NGROK_9040), а dev тут под VPN
// (OpenAI гео-блок). Cloudflare quick tunnel работает под VPN и без страницы-заглушки — webview Telegram
// грузит Mini App сразу.
//
// Что делает (БЕЗ сборки — живой dev с HMR):
//   1. поднимает Vite dev (5173) — фронт с HMR; /api он проксирует на бота (WEB_PORT, см. vite.config);
//   2. поднимает cloudflared-туннель на 5173, берёт https://*.trycloudflare.com;
//   3. ВПИСЫВАЕТ этот URL в .env (WEBAPP_URL=…);
//   4. запускает бота (tsx watch) — он читает .env и ставит menu-button «🪃 Открыть» на туннель.
// Открой dev-бота в Telegram → кнопка-меню. Меняешь фронт — HMR подхватывает на лету.
//
// Запуск:  npm run dev:tg     (Ctrl+C гасит vite, cloudflared и бота)
//
// Предусловия: локальный Postgres (skill «start-project»); VPN (OpenAI); в .env — токен ОТДЕЛЬНОГО
// dev-бота (один getUpdates на токен, не пересекаться с продом).

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const WIN = process.platform === 'win32';
const ENV_PATH = new URL('../.env', import.meta.url);
const VITE_PORT = 5173; // см. server.port в vite.config.ts

function resolveCloudflared() {
  if (process.env.CLOUDFLARED) return process.env.CLOUDFLARED;
  if (WIN) {
    const candidates = [
      'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
      'C:\\Program Files\\cloudflared\\cloudflared.exe',
      `${process.env.LOCALAPPDATA}\\Microsoft\\WinGet\\Links\\cloudflared.exe`,
    ];
    for (const p of candidates) if (existsSync(p)) return p;
  }
  return 'cloudflared';
}

const children = [];
function cleanup() {
  for (const c of children) {
    try {
      c.kill();
    } catch {
      /* уже мёртв */
    }
  }
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    cleanup();
    process.exit(0);
  });
}

/** Вписать WEBAPP_URL в .env (заменить строку или добавить), сохранив остальное. */
function writeWebappUrl(url) {
  let text = '';
  try {
    text = readFileSync(ENV_PATH, 'utf8');
  } catch {
    /* нет .env — создадим минимальный (маловероятно: бот без секретов не стартует) */
  }
  const line = `WEBAPP_URL=${url}`;
  text = /^\s*WEBAPP_URL\s*=.*$/m.test(text)
    ? text.replace(/^\s*WEBAPP_URL\s*=.*$/m, line)
    : `${text.replace(/\s*$/, '')}\n${line}\n`;
  writeFileSync(ENV_PATH, text);
}

function main() {
  // 1. Vite dev (фронт + проксирование /api на бота).
  console.log('→ Vite dev на :' + VITE_PORT + ' (HMR)…');
  const vite = spawn('npx', ['vite', '--port', String(VITE_PORT), '--strictPort'], {
    stdio: 'inherit',
    shell: WIN,
    env: { ...process.env, TUNNEL: '1' }, // включает hmr.clientPort=443 в vite.config (https-туннель)
  });
  children.push(vite);

  // 2. cloudflared-туннель на Vite. URL ловим из вывода.
  const cf = resolveCloudflared();
  console.log('→ cloudflared tunnel → :' + VITE_PORT + '…');
  // cloudflared — настоящий .exe: под shell:true путь с пробелом («C:\Program Files…») рвётся на пробеле.
  // Полный путь запускаем БЕЗ shell; bare-имя из PATH на Windows — через shell (поиск по PATHEXT).
  // --protocol http2 (TCP) вместо дефолтного quic (UDP): через VPN (AmneziaVPN) UDP/QUIC рвётся
  // («control stream failure»), а http2 идёт по TCP и держится.
  const tunnel = spawn(
    cf,
    ['tunnel', '--url', `http://localhost:${VITE_PORT}`, '--protocol', 'http2', '--no-autoupdate'],
    { stdio: ['ignore', 'pipe', 'pipe'], shell: WIN && cf === 'cloudflared' },
  );
  children.push(tunnel);
  tunnel.on('error', (e) => {
    console.error('cloudflared не запустился:', e.message);
    cleanup();
    process.exit(1);
  });

  let started = false;
  const onChunk = (buf) => {
    const s = buf.toString();
    process.stdout.write(s); // показываем лог cloudflared
    const m = s.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (m && !started) {
      started = true;
      const url = m[0];
      writeWebappUrl(url);
      console.log(`\n🌐 Mini App: ${url}  (вписан в .env как WEBAPP_URL)`);
      console.log('   Открой dev-бота в Telegram → кнопка-меню «🪃 Открыть».\n');

      // 3. Бот: читает обновлённый .env, ставит menu-button на туннель, API на WEB_PORT.
      console.log('→ Запуск бота (tsx watch)…');
      const bot = spawn('npx', ['tsx', 'watch', 'src/index.ts'], { stdio: 'inherit', shell: WIN });
      children.push(bot);
      bot.on('exit', (code) => {
        cleanup();
        process.exit(code ?? 0);
      });
    }
  };
  tunnel.stdout.on('data', onChunk);
  tunnel.stderr.on('data', onChunk); // cloudflared печатает URL в stderr
}

main();
