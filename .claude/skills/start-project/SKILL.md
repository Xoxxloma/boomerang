---
name: start-project
description: Поднять локальное окружение Boomerang — контейнер Postgres (pgvector), применить миграции и запустить Telegram-бота в фоне. Использовать, когда пользователь хочет запустить/поднять проект локально ("старт проджект", "start project", "запусти бота", "подними проект").
---

# Start Project — локальный запуск Boomerang

Цель: одной командой поднять БД и запустить бота в фоне, чтобы можно было тестировать в Telegram.
Все шаги выполняй из корня проекта. Для запуска/остановки процессов используй **PowerShell** (надёжное детачивание + PID-файл).

## Шаги

1. **Поднять БД (Postgres + pgvector).** Через Bash или PowerShell:
   ```
   docker compose up -d
   ```
   Если docker daemon не запущен (ошибка `docker_engine`/`daemon is not running`) — попросить пользователя запустить Docker Desktop и остановиться, не продолжать.

2. **Дождаться готовности БД** (до ~20 с). PowerShell:
   ```powershell
   foreach ($i in 1..20) { docker exec boomerang-db pg_isready -U boomerang -d boomerang 2>$null | Out-Null; if ($LASTEXITCODE -eq 0) { 'DB ready'; break }; Start-Sleep -Seconds 1 }
   ```

3. **Применить миграции** (идемпотентно — уже применённые пропускаются):
   ```
   npm run db:migrate
   ```

4. **Проверить, что бот уже не запущен.** Если есть `.bot.pid` и процесс жив — сообщить, что бот уже работает, и не запускать второй экземпляр (иначе конфликт getUpdates у Telegram).

5. **Запустить бота в фоне** (PowerShell, отдельный процесс node + PID-файл):
   ```powershell
   New-Item -ItemType Directory -Force data | Out-Null
   $proc = Start-Process node -ArgumentList '--import','tsx','src/index.ts' -PassThru -WindowStyle Hidden -RedirectStandardOutput 'data\bot.out.log' -RedirectStandardError 'data\bot.err.log'
   Set-Content -Path '.bot.pid' -Value $proc.Id
   "Bot PID: $($proc.Id)"
   ```

6. **Подтвердить старт.** Подождать ~3 с и показать лог:
   ```powershell
   Start-Sleep -Seconds 3; Get-Content data\bot.out.log -Tail 15; Get-Content data\bot.err.log -Tail 15
   ```
   Успех — строка `🪃 Boomerang запущен`. Если в err-логе ошибка (напр. невалидный `.env`, занятый токен) — показать её пользователю и предложить починить.

## Итог
Сообщить: бот запущен (PID в `.bot.pid`, логи в `data/bot.out.log` / `data/bot.err.log`), можно писать боту в Telegram. Остановить — командой `/stop-project`.
