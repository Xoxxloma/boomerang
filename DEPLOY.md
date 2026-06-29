# Деплой Boomerang на стенд

Бот работает на **long polling** — вебхуков нет, с другими сервисами на стенде (другой ТГ-бот,
AmneziaVPN) не конфликтует. БД — **self-host Postgres + pgvector в Docker на самом VPS**
(`docker-compose.prod.yml`), а не облако: free-Neon тарифицирует compute-часы, а бот 24/7 не даёт
БД заснуть → лимит выжигается. Self-host убирает лимит по часам, потолок объёма = диск, БД рядом
с ботом (без egress). Морда для просмотра данных — **pgweb** (наружу через Caddy; логин/пароль
спрашивает сам pgweb). Контейнеры БД и морды поднимает `scripts/deploy.sh` автоматически (вручную
`docker compose` дёргать не нужно). Нужны: Node ≥20 + systemd + Docker (+ апгрейд VPS до ~2 ГБ RAM —
БД делит хост с ботом).

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

Идея: всю рутину (`npm ci`, **подъём контейнеров БД+морды**, миграции схемы, запуск бота) делает
один скрипт `scripts/deploy.sh` (шаг 4). Шаги 1–3 — это разовая обвязка вокруг него.

### Шаг 1. Папка и владелец

```sh
sudo chown -R <user> /opt/boomerang
cd /opt/boomerang
```

### Шаг 2. Файл `.env.production` (НЕ в git)

Скопируй структуру из `.env.example` и заполни **все** поля (`nano .env.production`). Кроме обычных
секретов бота здесь же лежат пароли для контейнеров БД и морды — `docker-compose.prod.yml` читает их
из этого же файла (через `--env-file .env.production`), отдельно нигде вводить не нужно.

```ini
BOT_TOKEN=<токен прод-бота>

# self-host БД на этом же VPS (Docker, порт на loopback). <DB_PASSWORD> = поле DB_PASSWORD ниже.
DATABASE_URL=postgres://boomerang:<DB_PASSWORD>@127.0.0.1:5432/boomerang
DATABASE_SSL=false          # loopback, TLS не нужен

OPENAI_API_KEY=...
STT_API_KEY=...
ADMIN_IDS=...

WEBAPP_URL=https://147.45.152.170.nip.io     # = домен в deploy/Caddyfile
WEB_PORT=8787

# Контейнеры БД и морды (нужны только Docker'у, не Node-приложению):
DB_PASSWORD=<надёжный-пароль-БД>             # тот же, что в DATABASE_URL выше
PGWEB_AUTH_USER=<логин-для-морды>            # этот логин/пароль морда pgweb спросит при входе
PGWEB_AUTH_PASS=<пароль-для-морды>
```

### Шаг 3. systemd-сервис бота и Caddy (TLS)

```sh
# systemd-сервис бота: enable БЕЗ --now — первый запуск сделает deploy.sh в шаге 4
sudo cp deploy/boomerang.service /etc/systemd/system/boomerang.service
sudo nano /etc/systemd/system/boomerang.service   # подставить User / WorkingDirectory / путь к npm
sudo systemctl daemon-reload
sudo systemctl enable boomerang

# Caddy: TLS для Mini App (домен из WEBAPP_URL) и для морды (поддомен db.<домен>).
# Оба домена должны резолвиться на этот VPS, порты 80/443 открыты. basic_auth настраивать НЕ нужно —
# логин на морду проверяет сам pgweb (PGWEB_AUTH_* из .env.production).
sudo apt install -y caddy                          # либо см. https://caddyserver.com/docs/install
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile                     # подставить свой домен (= WEBAPP_URL) и WEB_PORT
sudo systemctl reload caddy
```

### Шаг 4. Запуск (deploy.sh) — поднимет БД, применит схему, стартует бота

```sh
bash scripts/deploy.sh
journalctl -u boomerang -f          # ждём «🪃 Boomerang запущен» и «🌐 Mini App API слушает :8787»
```

> **Переезжаешь с Neon?** Сразу после шага 4 выполни раздел [«Перенос данных с Neon»](#перенос-данных-с-neon-один-раз)
> — на этот момент БД и схема уже есть, таблицы пустые, данные зальются чисто.

### Шаг 5. Авто-бэкап БД

Бэкапы self-host БД — на нас. Сначала настрой копию **наружу** в `scripts/backup.sh` (раскомментируй
`rclone`/`scp` — иначе дамп лежит на том же диске, что и БД, и не спасает от потери VPS). Затем:

```sh
sudo cp deploy/boomerang-backup.service /etc/systemd/system/boomerang-backup.service
sudo cp deploy/boomerang-backup.timer   /etc/systemd/system/boomerang-backup.timer
sudo nano /etc/systemd/system/boomerang-backup.service   # подставить WorkingDirectory
sudo systemctl daemon-reload
sudo systemctl enable --now boomerang-backup.timer
systemctl list-timers boomerang-backup.timer             # проверить, что следующий запуск назначен
```

## Перенос данных с Neon (один раз)

Выполняется при переезде, **после шага 4** (БД поднята, схема создана `db:migrate:prod`). Переносим
только данные приложения: расширение `vector`, таблицы и HNSW-индексы уже создала миграция, а очередь
pg-boss мигрировать не нужно — она пересоздаст свою схему `pgboss` сама.

```sh
cd /opt/boomerang

# 1) Дамп ТОЛЬКО данных из Neon (одноразовый контейнер с pg17-клиентом). NEON_DATABASE_URL — старый
#    DATABASE_URL из прежнего .env.production (с ?sslmode=require).
docker run --rm pgvector/pgvector:pg17 \
  pg_dump "<NEON_DATABASE_URL>" --data-only --no-owner --schema=public > data.sql

# 2) Залить дамп в self-host БД (контейнер уже поднят deploy.sh).
docker exec -i boomerang-db psql -U boomerang -d boomerang < data.sql

# 3) Сверка: число записей должно совпасть с Neon.
docker exec boomerang-db psql -U boomerang -d boomerang -c 'select count(*) from items;'
```

> Neon-проект НЕ удалять сразу — оставь на несколько дней как откат; снеси после стабильной работы.

## Обновление (каждый релиз)

1. Доставь новый код в `/opt/boomerang` (сам).
2. `bash scripts/deploy.sh` — единая последовательность: `npm ci` → сборка Mini App (`build:web`) →
   подъём контейнеров БД+морды (идемпотентно) → миграции → отрезание dev-зависимостей (`npm prune`) →
   рестарт сервиса.

## Операционные команды

```sh
sudo systemctl restart boomerang     # перезапуск
sudo systemctl stop boomerang        # остановить
journalctl -u boomerang -f           # логи в реальном времени
journalctl -u boomerang --since "10 min ago"
```

## Проверка после деплоя (E2E)

1. Переслать прод-боту сообщение → приходит мгновенное «принял» → edit с авто-классификацией.
2. Через секунды L2 (pg-boss) создаёт эмбеддинг в self-host БД (в логах нет ошибок соединения/SSL).
3. `/find <запрос>` или вопрос → связный синтез со ссылками на источники.
4. Устойчивость: `sudo systemctl restart boomerang` и `sudo reboot` — сервис и контейнеры БД
   (`restart: unless-stopped`) поднимаются сами; `free -h` — RAM в пределах, swap не лавиной.
5. **Морда БД:** открой `https://db.<домен>` → pgweb спросит логин/пароль (PGWEB_AUTH_*) → видно таблицу `items`.
6. **Бэкап:** `bash scripts/backup.sh` → дамп создан в `backups/` + ушла копия наружу;
   `systemctl list-timers boomerang-backup.timer` — следующий запуск назначен.
7. **Mini App:** открой `https://<домен>/healthz` → `ok` (Caddy + сервер живы). В боте нажми
   кнопку-меню «🪃 Открыть» → грузится вебапп; вкладки Эхо / Поиск / Карта отдают данные, тема
   всегда тёмная независимо от оформления Telegram (проверь при светлой теме клиента — апп остаётся
   тёмным на всех экранах). Запрос к `/api/*` без подписи Telegram → 401.
