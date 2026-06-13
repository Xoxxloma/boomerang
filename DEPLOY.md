# Деплой Boomerang на стенд

Бот работает на **long polling** — вебхуков нет, с другими сервисами на стенде (другой ТГ-бот,
AmneziaVPN) не конфликтует. БД — облачная **Neon** (Postgres + pgvector), поэтому на стенде
Postgres/docker не нужны: только Node ≥20 + systemd.

**Telegram Mini App** (вебапп Карта / Поиск / Эхо) поднимается в том же процессе: HTTP-сервер
(Hono) слушает `WEB_PORT` локально, а наружу его публикует **Caddy** (TLS, авто-сертификат
Let's Encrypt). Это добавляет входящие порты **80/443** и требует **публичный домен** на VPS.
Long polling по-прежнему портов не слушает — конфликта нет.

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
#    WEBAPP_URL=https://<твой-домен>   WEB_PORT=8787   (Mini App; домен = домен в Caddyfile)
nano .env.production

# 3. systemd-сервис: ставим и включаем (enable без --now — запустит уже deploy.sh в шаге 4)
sudo cp deploy/boomerang.service /etc/systemd/system/boomerang.service
sudo nano /etc/systemd/system/boomerang.service   # подставить User / WorkingDirectory / путь к npm
sudo systemctl daemon-reload
sudo systemctl enable boomerang

# 4. Caddy (TLS для Mini App): домен должен резолвиться на этот VPS, порты 80/443 открыты
sudo apt install -y caddy                          # либо см. https://caddyserver.com/docs/install
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile                     # подставить свой домен (= WEBAPP_URL) и WEB_PORT
sudo systemctl reload caddy

# 5. Установка зависимостей + сборка Mini App + миграции + первый запуск
bash scripts/deploy.sh

# 6. Проверка
journalctl -u boomerang -f          # ждём «🪃 Boomerang запущен» и «🌐 Mini App API слушает :8787»
```

## Обновление (каждый релиз)

1. Доставь новый код в `/opt/boomerang` (сам).
2. `bash scripts/deploy.sh` — единая последовательность: `npm ci` → сборка Mini App (`build:web`) →
   миграции → отрезание dev-зависимостей (`npm prune`) → рестарт сервиса.

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
5. **Mini App:** открой `https://<домен>/healthz` → `ok` (Caddy + сервер живы). В боте нажми
   кнопку-меню «🪃 Открыть» → грузится вебапп; вкладки Эхо / Поиск / Карта отдают данные, тема
   совпадает с темой Telegram (light/dark). Запрос к `/api/*` без подписи Telegram → 401.
