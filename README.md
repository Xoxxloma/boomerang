# 🪃 Boomerang

Telegram-бот «второй мозг»: пересылаешь контент → он возвращается к тебе в нужный момент.
Продукт продаёт **извлечение, а не хранение** (см. [CLAUDE.md](CLAUDE.md), [boomerang-bot-spec.md](boomerang-bot-spec.md)).

## Что умеет (MVP v0.1)

- **Приём** пересланного: ссылки (title + OG), текст, документы (PDF/Word/txt), картинки, видео (берёт подпись).
- **L1** — мгновенное «Принял ✅» → авто-категория → правка категории в один тап.
- **L2** (фон) — эмбеддинги, OCR картинок, отнесение к кластеру.
- **Извлечение (режим 1)** — спроси «что я сохранял про X» → **связный синтез со ссылками**, а не список.
- **Категории** всплывают снизу через кластеризацию (не захардкожены).
- **Дайджест** — `/digest`: темы за неделю.

Что отложено — в [ROADMAP.md](ROADMAP.md).

## Стек

TypeScript (strict) · grammY + runner · PostgreSQL + pgvector · Drizzle · OpenAI (gpt-4o-mini + text-embedding-3-small) · tesseract.js · open-graph-scraper · pdf-parse + mammoth · pg-boss (очередь на Postgres).

## Запуск

```bash
# 1. Поднять Postgres + pgvector
docker compose up -d

# 2. Зависимости
npm install

# 3. Настроить .env (скопировать из .env.example) — ВСЕ поля обязательны:
#    BOT_TOKEN (у @BotFather), OPENAI_API_KEY, STT_API_KEY (Groq), ADMIN_IDS
cp .env.example .env   # затем вписать ключи

# 4. Применить миграции
npm run db:migrate

# 5. Запустить бота
npm run dev
```

Дальше — переслать боту несколько ссылок/постов и спросить «что я сохранял про …».

## Команды разработки

| Команда | Что делает |
|---|---|
| `npm run dev` | запуск с авто-перезагрузкой (tsx watch) |
| `npm start` | запуск без watch |
| `npm run typecheck` | строгая проверка типов |
| `npm test` | юнит-тесты (vitest) |
| `npm run db:generate` | сгенерировать миграцию из схемы |
| `npm run db:migrate` | применить миграции |
| `npm run db:studio` | drizzle studio |

## Архитектура (кратко)

> Полный разбор пайплайна — в [ARCHITECTURE.md](ARCHITECTURE.md).


```
src/
  config/env.ts        — валидация окружения (zod)
  db/                  — Drizzle: schema, client, репозитории items/clusters/users
  ai/                  — llm.ts (chat), embeddings.ts, prompts.ts
  content/             — og, ocr, documents, files (скачивание из Telegram)
  ingest/              — detect (тип), extract (индекс-текст/сигнал), classify (L1)
  cluster/             — math (cosine/centroid), assign (отнесение/полка картинок)
  retrieval/           — search (pgvector), synthesize (синтез), digest (режим 3)
  queue/               — pg-boss (boss/index/worker) + jobs/process (L2: OCR→embed→cluster)
  bot/                 — grammY: handlers (commands, search, callbacks, ingest)
```

Поток одной пересылки: `ingest` (L1: приём → OG/скачивание → сохранение → категория → edit + кнопка)
→ `queue/process` (L2: OCR/чтение док → эмбеддинг → кластер).
Поток вопроса: `search` (эвристика «вопрос?») → `retrieval/search` (pgvector) → `synthesize` (LLM) → ответ со ссылками.
