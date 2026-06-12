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

Только одноразовая обвязка — `npm ci`, миграции и запуск делает `scripts/deploy.sh` (шаг 4),
чтобы не дублировать команды.

```sh
# 1. Владение папкой — деплой-пользователю
sudo chown -R <user> /opt/boomerang
cd /opt/boomerang

# 2. Прод-окружение (НЕ в git). Скопируй структуру из .env.example и заполни:
#    BOT_TOKEN=<токен прод-бота>
#    DATABASE_URL=<Neon direct endpoint>?sslmode=require
#    DATABASE_SSL=true
#    OPENAI_API_KEY=... STT_API_KEY=... ADMIN_IDS=... (все поля обязательны)
nano .env.production

# 3. systemd-сервис: ставим и включаем (enable без --now — запустит уже deploy.sh в шаге 4)
sudo cp deploy/boomerang.service /etc/systemd/system/boomerang.service
sudo nano /etc/systemd/system/boomerang.service   # подставить User / WorkingDirectory / путь к npm
sudo systemctl daemon-reload
sudo systemctl enable boomerang

# 4. Установка зависимостей + миграции + первый запуск
bash scripts/deploy.sh

# 5. Проверка
journalctl -u boomerang -f          # ждём строку «🪃 Boomerang запущен»
```

## Обновление (каждый релиз)

1. Доставь новый код в `/opt/boomerang` (сам).
2. `bash scripts/deploy.sh` — единая последовательность: `npm ci` → миграции → рестарт сервиса.

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
