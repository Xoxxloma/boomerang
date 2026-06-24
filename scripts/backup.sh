#!/usr/bin/env sh
# Ночной бэкап self-host БД Boomerang: pg_dump из контейнера → gzip-файл с датой, ротация, копия наружу.
# Бэкапы — на нас (плата за self-host вместо managed Neon). Без копии НАРУЖУ потеря VPS = потеря данных.
#
# Запуск вручную:   bash scripts/backup.sh
# Обычно дёргается systemd-таймером deploy/boomerang-backup.timer (ежедневно).
set -eu

BACKUP_DIR="${BACKUP_DIR:-/opt/boomerang/backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
CONTAINER="${DB_CONTAINER:-boomerang-db}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/boomerang-$STAMP.sql.gz"

mkdir -p "$BACKUP_DIR"

echo "→ pg_dump → $OUT"
# --no-owner: восстановление не требует тех же ролей. Расширение vector и HNSW-индексы попадают в дамп.
docker exec "$CONTAINER" pg_dump -U boomerang -d boomerang --no-owner | gzip > "$OUT"

echo "→ ротация: удаляем дампы старше $KEEP_DAYS дней"
find "$BACKUP_DIR" -name 'boomerang-*.sql.gz' -mtime "+$KEEP_DAYS" -delete

# --- Копия НАРУЖУ (обязательна; раскомментировать и настроить под своё хранилище) ---
# Локальная копия лежит на том же диске, что и БД — это НЕ бэкап от потери VPS.
# rclone copy "$OUT" remote:boomerang-backups/      # S3/Backblaze B2/Google Drive через rclone
# scp "$OUT" user@backup-host:/path/                # либо на второй хост

echo "✓ бэкап готов: $OUT"
