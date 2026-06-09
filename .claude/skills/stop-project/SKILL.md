---
name: stop-project
description: Остановить локальное окружение Boomerang — убить процесс бота и остановить контейнер Postgres. Использовать, когда пользователь хочет остановить/погасить проект локально ("стоп проджект", "stop project", "останови бота", "погаси проект").
---

# Stop Project — остановить Boomerang

Цель: аккуратно погасить бота и контейнер БД. Выполняй из корня проекта.

## Шаги

1. **Остановить бота по PID-файлу** (PowerShell — точечно, чтобы не задеть другие node-процессы):
   ```powershell
   if (Test-Path .bot.pid) {
     $botPid = Get-Content .bot.pid
     Stop-Process -Id $botPid -Force -ErrorAction SilentlyContinue
     Remove-Item .bot.pid -Force
     "Бот остановлен (PID $botPid)"
   } else { 'PID-файл не найден — бот, возможно, не запущен этим скиллом.' }
   ```
   Если `.bot.pid` нет, но пользователь уверен, что бот висит — найти процесс: `Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*node*' }` и уточнить у пользователя перед kill (не убивать node вслепую).

2. **Остановить контейнер БД** (контейнер и данные сохраняются, это `stop`, не `down`):
   ```
   docker compose stop
   ```

## Итог
Сообщить: бот остановлен, контейнер БД остановлен (данные сохранены в volume). Поднять снова — `/start-project`.

> Примечание: используем `docker compose stop`, а НЕ `down`, чтобы не удалять volume с накопленными item/кластерами.
