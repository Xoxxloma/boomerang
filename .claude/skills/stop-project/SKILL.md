---
name: stop-project
description: Остановить локальное окружение Boomerang — погасить весь стек (бот + Vite-фронт + cloudflared-туннель) и контейнер Postgres. Использовать, когда пользователь хочет остановить/погасить проект локально ("стоп проджект", "stop project", "останови бота", "погаси проект").
---

# Stop Project — остановить Boomerang

Цель: аккуратно погасить весь стек, поднятый `/start-project` (он запускает `scripts/dev-tunnel.mjs` —
дерево процессов: node → Vite + cloudflared + бот), и контейнер БД. Выполняй из корня проекта.

## Шаги

1. **Погасить дерево процессов по PID-файлу.** `.bot.pid` хранит PID родителя (`dev-tunnel.mjs`);
   убиваем его И всех потомков (Vite/cloudflared/бот) — `taskkill /T` (Stop-Process дерево не валит):
   ```powershell
   if (Test-Path .bot.pid) {
     $treePid = (Get-Content .bot.pid).Trim()
     taskkill /PID $treePid /T /F 2>$null | Out-Null
     Remove-Item .bot.pid -Force
     "Стек остановлен (PID $treePid + потомки)"
   } else { 'PID-файл не найден — проект, возможно, не запущен этим скиллом.' }
   ```

2. **Добить возможные orphan-процессы** (если дерево частично отвязалось): стрелочный cloudflared и
   Vite/бот по их портам — это процессы только нашего проекта, бить безопасно:
   ```powershell
   Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
   foreach ($port in 5173,8787) { Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } }
   'orphan-процессы (cloudflared/:5173/:8787) добиты'
   ```
   Если `.bot.pid` не было, но пользователь уверен, что что-то висит — этого шага достаточно
   (node вслепую по имени НЕ бить).

3. **Остановить контейнер БД** (контейнер и данные сохраняются — `stop`, не `down`):
   ```
   docker compose stop
   ```

## Итог
Сообщить: стек остановлен (бот, Vite, cloudflared-туннель), контейнер БД остановлен (данные в volume
сохранены). Поднять снова — `/start-project` (туннель получит новый URL, он перезапишется в `.env`).

> Используем `docker compose stop`, а НЕ `down`, чтобы не удалять volume с накопленными item/кластерами.
> `WEBAPP_URL` в `.env` остаётся со старым URL туннеля — это норма, следующий старт его перезапишет.
