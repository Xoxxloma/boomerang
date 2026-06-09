# Архитектура Boomerang — как работает пайплайн

Карта потоков данных от пересылки до ответа. Тезис: продаём **извлечение, а не хранение**
(см. [CLAUDE.md](CLAUDE.md), [boomerang-bot-spec.md](boomerang-bot-spec.md)).

## Запуск и каркас

[src/index.ts](src/index.ts) поднимает бота через grammY **runner** (конкурентная обработка апдейтов),
ловит SIGINT/SIGTERM для аккуратной остановки (OCR-воркер, пул БД).

[src/bot/index.ts](src/bot/index.ts) навешивает middleware и хендлеры **в строгом порядке**:

1. `ensureUser` — на любое сообщение upsert пользователя в БД по tg-id.
2. `registerCommands` — `/start`, `/help`, `/digest`.
3. `registerCallbacks` — инлайн-кнопки (правка категории, переход к источнику).
4. `registerSearch` — ловит вопросы. **Регистрируется ДО приёма**, иначе вопрос «что я сохранял…»
   сохранился бы как заметка вместо поиска.
5. `registerIngest` — всё остальное → сохранение.

## Три уровня обработки (чтобы UX не тормозил)

- **L1 — синхронно:** мгновенное «Принял ✅» → дешёвая классификация → edit сообщения.
- **L2 — фон (очередь):** OCR, чтение документов, эмбеддинги, отнесение к кластеру.
- **L3 — по требованию:** глубокое чтение. *На текущий момент документы читаются сразу в L2
  (eager), а не лениво — это упрощение, см. ROADMAP.*

---

## Путь А: приём контента (пользователь что-то прислал)

### L1 — мгновенно (синхронно)

[src/bot/handlers/ingest.ts](src/bot/handlers/ingest.ts), `bot.on('message')`:

1. Если это **альбом** (`media_group_id`) → буфер [src/ingest/album.ts](src/ingest/album.ts) ждёт
   ~1.5с остальные части и обрабатывает группу как одно целое. Иначе — сразу.
2. Бот отвечает **«Принял ✅»** (микро-ценность мгновенно).
3. `saveItem` делает основную работу L1.

**Определение типа** — [src/ingest/detect.ts](src/ingest/detect.ts) `detect()`, по **самому дешёвому
сигналу**, без чтения файлов:
- документ / голос → свои типы;
- **медиа (фото/видео) + содержательная подпись** (`hasMeaningfulCaption`: ≥16 символов или ≥3 слов)
  → это **пост** (`tg_post`/`text`), классифицируем по подписи;
- медиа без подписи → `image` (полка «Изображения») / `video` (медиа-полка);
- есть URL → `link`; переслано → `tg_post`; иначе → `text`.

**Дешёвый сигнал по типу** (внутри `saveItem`):
- **Ссылка** → [src/content/og.ts](src/content/og.ts) тянет `title` + OG-описание. **Тело статьи НЕ
  читаем** — дёшево и быстро.
- **Картинка** → [src/content/files.ts](src/content/files.ts) скачивает файл (OCR будет в L2).
- **Документ** → скачивает файл; имя файла → заголовок-сигнал.

**Запись в БД** — [src/db/items.ts](src/db/items.ts) `insertItem`: `raw_text` (подпись/текст), `url`,
`title`, `description`, `file_path`, **`tg_message_id`** (id исходного сообщения — для перехода к
источнику).

**Классификация** — [src/ingest/classify.ts](src/ingest/classify.ts): дешёвый LLM-вызов
(`gpt-4o-mini`, строгий JSON) по первым ~500 символам сигнала ([src/ingest/extract.ts](src/ingest/extract.ts)
`buildClassifySignal`) → короткая категория. Картинки без подписи LLM не зовут — сразу полка «Изображения».

**Edit сообщения:** бот редактирует своё «Принял» → **«✅ Положил в «Категория»»** + кнопка
«🔀 Не та категория». Выглядит, будто бот подумал.

**Альбомы** ([src/ingest/album.ts](src/ingest/album.ts)): есть подпись в группе → создаётся **ОДИН**
пост по подписи (медиа-файлы игнорируем); подписи нет → каждый член отдельно.

### L2 — тяжёлое в фоне

`enqueueProcess` кладёт задачу в очередь [src/queue/index.ts](src/queue/index.ts) — **pg-boss**
поверх Postgres (durable, ретраи, переживает рестарт, работает при нескольких инстансах). Воркеры —
[src/queue/worker.ts](src/queue/worker.ts). [src/queue/jobs/process.ts](src/queue/jobs/process.ts)
`processItem` по порядку:

1. **Картинка** → OCR [src/content/ocr.ts](src/content/ocr.ts) (tesseract, rus+eng) → текст в
   `ocr_text`. **Только в индекс, пользователю не показываем** (там бывает «каша»).
2. **Документ** → [src/content/documents.ts](src/content/documents.ts) читает PDF/Word/txt целиком →
   дописывает в `raw_text` (один раз, до индексации).
3. **Эмбеддинг** → `buildIndexText` (title+desc+raw+ocr+transcript+url, до 8000 симв.) →
   [src/ai/embeddings.ts](src/ai/embeddings.ts) (OpenAI `text-embedding-3-small`, вектор **1536**) →
   запись в `embedding` + `indexed_at`.
4. **Кластер** → [src/cluster/assign.ts](src/cluster/assign.ts): картинки → полка «Изображения»;
   остальное → ближайший центроид по косинусу (`assignCluster`, порог ≥0.45) **или** новый кластер.
   Центроид обновляется бегущим средним ([src/cluster/math.ts](src/cluster/math.ts)).

> Голос (`voice`) в MVP не транскрибируется (Whisper отложен) → остаётся без текста и не индексируется.

---

## Путь Б: извлечение (пользователь задал вопрос) — ядро продукта

[src/bot/handlers/search.ts](src/bot/handlers/search.ts):

1. Печатный текст (не пересланный, без ссылок), похожий на вопрос (`looksLikeQuery`), **или** `/find`
   → это запрос. Иначе текст ушёл бы в приём.
2. `search` ([src/retrieval/search.ts](src/retrieval/search.ts)): эмбеддит запрос → **pgvector**
   косинусный поиск по item пользователя → топ-8 с похожестью **≥ 0.28**. Поиск идёт **по эмбеддингам,
   не по тегам** (включая `ocr_text` под капотом).
3. `synthesize` ([src/retrieval/synthesize.ts](src/retrieval/synthesize.ts)): нумерует найденное
   `[1..n]` → LLM собирает **связный ответ со ссылками [n]**, опираясь только на эти материалы
   (не список!).
4. `extractCitedIndices` → под ответом инлайн-кнопки **только реально процитированных** источников.
5. Тап по кнопке `src:<id>` → [src/bot/handlers/callbacks.ts](src/bot/handlers/callbacks.ts) делает
   **reply на исходное сообщение** → по цитате лента скроллит к оригиналу. (Прямой ссылки на сообщение
   в личке Telegram не даёт — reply единственный нативный способ.)

---

## Побочные потоки

- **Правка категории** ([src/bot/handlers/callbacks.ts](src/bot/handlers/callbacks.ts)): кнопка «🔀» →
  список кластеров → перенос + `cluster_locked=true` (ручная правка учит систему, подтягивает центроид).
  Это «ров» из спеки.
- **Дайджест** `/digest` ([src/retrieval/digest.ts](src/retrieval/digest.ts)): группирует сохранённое
  за 7 дней по кластерам → LLM формулирует «вот темы, что тебя зацепили» (режим 3).

---

## Хранилище

Postgres + pgvector, Drizzle ([src/db/schema.ts](src/db/schema.ts)):

- **users** — `id` (tg user id), `settings` (jsonb), `import_done`.
- **clusters** — `name` (имя кластера), `centroid` (vector 1536), `size`.
- **items** — `type`, `raw_text`, `url`, `title`, `description`, `ocr_text` (скрытый),
  `embedding` (vector 1536), `cluster_id`, `cluster_locked`, `tg_message_id`, `indexed_at`.
- Индексы: **HNSW** на `items.embedding` и `clusters.centroid` (`vector_cosine_ops`) — быстрый
  семантический поиск.

---

## AI-провайдер

Единый ключ **OpenAI**: LLM `gpt-4o-mini` (классификация/синтез/дайджест) + эмбеддинги
`text-embedding-3-small` (1536). Клиенты OpenAI-совместимы ([src/ai/llm.ts](src/ai/llm.ts),
[src/ai/embeddings.ts](src/ai/embeddings.ts)) — смена провайдера = `.env`, без правок кода.
Бот хостится на зарубежном VPS (OpenAI блокирует РФ по гео-IP).

## Локальный запуск

`/start-project` и `/stop-project` (скиллы в `.claude/skills/`) поднимают/гасят БД-контейнер и бота.
Подробности — [README.md](README.md).
