#!/usr/bin/env sh
# Передеплой Boomerang на стенде ПОСЛЕ того, как новый код уже доставлен в рабочую папку
# (доставка кода — отдельный шаг, вне этого скрипта).
#
# Запуск из корня проекта:  bash scripts/deploy.sh
set -eu

cd "$(dirname "$0")/.."

# На стенде 1 ГБ RAM: останавливаем бота ДО npm ci, чтобы освободить память,
# иначе npm убивает OOM killer. Рестарт в конце поднимет его обратно.
echo "→ останавливаем сервис (освобождаем RAM под npm ci)"
sudo systemctl stop boomerang

echo "→ npm ci (только прод-зависимости; тулинг из devDependencies проду не нужен)"
npm ci --omit=dev --no-audit --no-fund

echo "→ миграции на прод-БД (идемпотентно: drizzle пропустит применённые)"
npm run db:migrate:prod

echo "→ запуск сервиса"
sudo systemctl restart boomerang

echo "→ статус"
sudo systemctl --no-pager status boomerang
