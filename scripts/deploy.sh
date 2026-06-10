#!/usr/bin/env sh
# Передеплой Boomerang на стенде ПОСЛЕ того, как новый код уже доставлен в рабочую папку
# (доставка кода — отдельный шаг, вне этого скрипта).
#
# Запуск из корня проекта:  bash scripts/deploy.sh
set -eu

cd "$(dirname "$0")/.."

echo "→ npm ci (детерминированная установка из package-lock.json)"
npm ci

echo "→ миграции на прод-БД (идемпотентно: drizzle пропустит применённые)"
npm run db:migrate:prod

echo "→ рестарт сервиса"
sudo systemctl restart boomerang

echo "→ статус"
sudo systemctl --no-pager status boomerang
