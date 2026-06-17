import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { initApp } from './lib/telegram.js';
import { api } from './lib/api.js';
import './styles/global.css';

// Развернуть Mini App, применить тему Telegram до первого кадра.
initApp();

// Сообщить серверу таймзону браузера (= пояс юзера) — бот-стороне нужна для пресетов напоминаний.
// Best-effort: ошибка/401 в dev-браузере не должна ронять загрузку.
try {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (tz) void api.setTz(tz).catch(() => {});
} catch {
  /* Intl недоступен — игнорируем */
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
