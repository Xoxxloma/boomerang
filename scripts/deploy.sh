#!/usr/bin/env sh
# Передеплой Boomerang на стенде ПОСЛЕ того, как новый код уже доставлен в рабочую папку
# (доставка кода — отдельный шаг, вне этого скрипта).
#
# Запуск из корня проекта:  bash scripts/deploy.sh
set -eu

cd "$(dirname "$0")/.."

# На стенде 1 ГБ RAM: останавливаем бота ДО npm ci, чтобы освободить память,
# иначе npm убивает OOM killer. Рестарт в конце поднимет его обратно.
echo "→ останавливаем сервис (освобождаем RAM под npm ci/сборку)"
sudo systemctl stop boomerang

# Vite/React лежат в devDependencies — для сборки Mini App ставим ВСЕ зависимости, после билда
# отрежем dev (npm prune ниже), чтобы вернуть память: рантайму нужен только Hono + прод-стек.
echo "→ npm ci (все зависимости: тулинг сборки фронта)"
npm ci --no-audit --no-fund

echo "→ сборка Mini App (Vite → dist/web; раздаётся Hono-сервером в проде)"
npm run build:web

echo "→ поднимаем self-host БД (Postgres+pgvector) и морду pgweb"
# Идемпотентно: если контейнеры уже запущены — no-op. Секреты берутся из .env.production (--env-file).
# Контейнеры с restart:unless-stopped, поэтому переживают reboot независимо от systemd-сервиса бота.
docker compose --env-file .env.production -f docker-compose.prod.yml up -d

echo "→ миграции на прод-БД (идемпотентно: drizzle пропустит применённые)"
npm run db:migrate:prod

echo "→ отрезаем dev-зависимости (возвращаем RAM; фронт уже собран в dist/web)"
npm prune --omit=dev --no-audit --no-fund

echo "→ запуск сервиса"
sudo systemctl restart boomerang

echo "→ статус"
sudo systemctl --no-pager status boomerang
