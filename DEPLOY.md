# Деплой Boomerang на стенд

Бот работает на **long polling** — входящих портов/вебхуков нет, с другими сервисами на
стенде (другой ТГ-бот, AmneziaVPN) не конфликтует. БД — облачная **Neon** (Postgres + pgvector),
поэтому на стенде Postgres/docker не нужны: только Node ≥20 + systemd.

> Доставка кода на стенд — **на твоей стороне** (git/scp/rsync — как удобно). Этот runbook
> считает, что код уже лежит в рабочей папке (далее `/opt/boomerang`).

## Предусловия

- **Отдельный прод-бот.** Создай бота у [@BotFather](https://t.me/BotFather) и используй его токен
  на стенде. Telegram допускает только один `getUpdates`-поллер на токен — если на стенде и
  локально (dev) будет один и тот же `BOT_TOKEN`, словишь конфликт 409.
- **Node ≥20** (`node -v`). Если нет/старый — поставь Node 20 LTS из nodesource (системный Node
  удобнее для systemd, чем nvm).

## Первичная установка (один раз)

```sh
# 1. Владение папкой — деплой-пользователю
sudo chown -R <user> /opt/boomerang
cd /opt/boomerang

# 2. Зависимости (детерминированно из lock-файла)
npm ci

# 3. Прод-окружение (НЕ в git). Скопируй структуру из .env.example и заполни:
#    BOT_TOKEN=<токен прод-бота>
#    DATABASE_URL=<Neon direct endpoint>?sslmode=require
#    DATABASE_SSL=true
#    OPENAI_API_KEY=... (+ остальные ключи)
nano .env.production

# 4. Схема БД (идемпотентно: ставит расширение vector, создаёт таблицы/индексы/схему pgboss)
npm run db:migrate:prod

# 5. systemd-сервис
sudo cp deploy/boomerang.service /etc/systemd/system/boomerang.service
sudo nano /etc/systemd/system/boomerang.service   # подставить User / WorkingDirectory / путь к npm
sudo systemctl daemon-reload
sudo systemctl enable --now boomerang

# 6. Проверка
systemctl status boomerang
journalctl -u boomerang -f          # ждём строку «🪃 Boomerang запущен»
```

## Обновление (каждый релиз)

1. Доставь новый код в `/opt/boomerang` (сам).
2. `bash scripts/deploy.sh` — `npm ci` → миграции → рестарт сервиса.

## Операционные команды

```sh
sudo systemctl restart boomerang     # перезапуск
sudo systemctl stop boomerang        # остановить
journalctl -u boomerang -f           # логи в реальном времени
journalctl -u boomerang --since "10 min ago"
```

## Проверка после деплоя (E2E)

1. Переслать прод-боту сообщение → приходит мгновенное «принял» → edit с авто-классификацией.
2. Через секунды L2 (pg-boss) создаёт эмбеддинг в Neon (в логах нет ошибок).
3. `/find <запрос>` или вопрос → связный синтез со ссылками на источники.
4. Устойчивость: `sudo systemctl restart boomerang` и `sudo reboot` — сервис поднимается сам.
