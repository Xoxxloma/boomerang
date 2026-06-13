---
name: start-project
description: Поднять локальное окружение Boomerang — контейнер Postgres (pgvector), миграции, и запустить весь стек для теста в Telegram (бот + фронт Mini App на Vite + cloudflared-туннель). Использовать, когда пользователь хочет запустить/поднять проект локально ("старт проджект", "start project", "запусти бота", "подними проект").
---

# Start Project — локальный запуск Boomerang

Цель: одной командой поднять БД и весь стек для теста Mini App **внутри Telegram** — бот (Hono API),
фронт на Vite (HMR) и публичный **cloudflared**-туннель. Всё крутит `scripts/dev-tunnel.mjs`
(`npm run dev:tg`): поднимает Vite на :5173, cloudflared-туннель на него, **вписывает URL в `.env`**
(`WEBAPP_URL`), запускает бота — он ставит menu-button «🪃 Открыть» на этот URL.

Все шаги — из корня проекта. Процессы запускаем/останавливаем через **PowerShell** (детач + PID-файл).

## Предусловия (проверить/напомнить)
- **Docker Desktop** запущен (для БД).
- **VPN включён** — OpenAI гео-блок (иначе Поиск/синтез не отработают; UI/Карта/Эхо откроются и без него).
- В `.env` — токен **отдельного dev-бота** (один getUpdates на токен; не пересекаться с продом) и все
  обязательные поля, включая `WEBAPP_URL`/`WEB_PORT` (URL перезапишется туннелем, но поле должно быть).
- `cloudflared` установлен (`cloudflared --version`). Нет — поставить: `winget install Cloudflare.cloudflared`.

## Шаги

1. **Поднять БД (Postgres + pgvector):**
   ```
   docker compose up -d
   ```
   Если docker daemon не запущен (`daemon is not running`) — попросить запустить Docker Desktop и
   остановиться, не продолжать.

2. **Дождаться готовности БД** (до ~20 с). PowerShell:
   ```powershell
   foreach ($i in 1..20) { docker exec boomerang-db pg_isready -U boomerang -d boomerang 2>$null | Out-Null; if ($LASTEXITCODE -eq 0) { 'DB ready'; break }; Start-Sleep -Seconds 1 }
   ```

3. **Применить миграции** (идемпотентно):
   ```
   npm run db:migrate
   ```

4. **Проверить, что стек уже не запущен** (не только по `.bot.pid` — стек могли поднять и вручную).
   Если жив PID из файла, ИЛИ занят :5173 (Vite), ИЛИ есть процесс cloudflared — сообщить, что проект
   уже работает, и НЕ запускать второй экземпляр (иначе 409 getUpdates у Telegram и конфликт порта):
   ```powershell
   $busy = $false
   if ((Test-Path .bot.pid) -and (Get-Process -Id (Get-Content .bot.pid).Trim() -ErrorAction SilentlyContinue)) { $busy = $true }
   if (Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue) { $busy = $true }
   if (Get-Process cloudflared -ErrorAction SilentlyContinue) { $busy = $true }
   if ($busy) { 'УЖЕ ЗАПУЩЕНО — сначала /stop-project' } else { 'свободно, можно стартовать' }
   ```
   Если занято — остановиться и предложить `/stop-project`, не плодить второй стек.

5. **Запустить весь стек в фоне** (PowerShell, отдельный node-процесс = `dev-tunnel.mjs` + PID-файл).
   Запускаем напрямую node (не `npm`, чтобы PID был чистым родителем дерева vite/cloudflared/бот):
   ```powershell
   New-Item -ItemType Directory -Force data | Out-Null
   $proc = Start-Process node -ArgumentList 'scripts/dev-tunnel.mjs' -PassThru -WindowStyle Hidden -RedirectStandardOutput 'data\bot.out.log' -RedirectStandardError 'data\bot.err.log'
   Set-Content -Path '.bot.pid' -Value $proc.Id
   "Stack PID: $($proc.Id)"
   ```

6. **Подтвердить старт.** cloudflared встаёт ~10–25 с. Подождать и показать ключевые строки:
   ```powershell
   foreach ($i in 1..40) { if ((Test-Path data\bot.out.log) -and (Select-String -Path data\bot.out.log -Pattern 'Boomerang запущен' -Quiet)) { break }; Start-Sleep -Seconds 1 }
   Select-String -Path data\bot.out.log -Pattern 'Mini App:|Boomerang запущен|Mini App API слушает|trycloudflare' | Select-Object -Last 6
   Get-Content data\bot.err.log -Tail 10
   ```
   Успех — есть строка `🪃 Boomerang запущен` и URL `https://…trycloudflare.com`. **Показать этот URL
   пользователю.** Если в логе ошибка `.env`, занятый токен (409), или cloudflared не встаёт
   (под VPN держится только `--protocol http2`, он уже зашит в скрипт) — показать и предложить починку.

## Итог
Сообщить: проект поднят (PID в `.bot.pid`, логи `data/bot.out.log` / `data/bot.err.log`), дать
**URL туннеля**. В Telegram открыть dev-бота → кнопка-меню «🪃 Открыть» → Mini App (Карта/Поиск/Эхо).
Правки фронта подхватываются HMR без перезапуска. Остановить — `/stop-project`.

> Нужен только бот без вебаппа/туннеля (быстрый бэкенд-тест)? Запускать по-старому одиночным процессом:
> `node --import tsx src/index.ts` (тогда Mini App открывается лишь по статике из `dist/web`, без HMR/туннеля).
