import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { initApp } from './lib/telegram.js';
import './styles/global.css';

// Развернуть Mini App, применить тему Telegram до первого кадра.
initApp();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
