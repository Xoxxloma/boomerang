# Архитектура Boomerang — как работает пайплайн

Карта потоков данных от пересылки до ответа. Тезис: продаём **извлечение, а не хранение**
(см. [CLAUDE.md](CLAUDE.md), [boomerang-bot-spec.md](boomerang-bot-spec.md)).

## Запуск и каркас

[src/index.ts](src/index.ts) поднимает бота через grammY **runner** (конкурентная обработка апдейтов),
ловит SIGINT/SIGTERM для аккуратной остановки (OCR-воркер, пул БД).

[src/bot/index.ts](src/bot/index.ts) навешивает middleware и хендлеры **в строгом порядке**:

1. `ensureUser` — на любое сообщение upsert пользователя в БД по tg-id.
2. `registerCommands` — `/start`, `/help`, `/digest`.
3. `registerCallbacks` — инлайн-кнопки (напомнить, удалить, переход к источнику).
4. `registerSearch` — ловит вопросы. **Регистрируется ДО приёма**, иначе вопрос «что я сохранял…»
   сохранился бы как заметка вместо поиска.
5. `registerIngest` — всё остальное → сохранение.

## Три уровня обработки (чтобы UX не тормозил)

- **L1 — синхронно:** мгновенное «Принял ✅» → (живой приём) детект «напомни …» → постановка L2.
- **L2 — фон (очередь):** OCR/vision, чтение документов, STT, эмбеддинги; заголовок → финал «✅ Принял — …».
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
- медиа без подписи → `image` / `video`;
- есть URL → `link`; переслано → `tg_post`; иначе → `text`.

**Дешёвый сигнал по типу** (внутри `saveItem`):
- **Ссылка** → [src/content/og.ts](src/content/og.ts) тянет `title` + OG-описание. **Тело статьи НЕ
  читаем** — дёшево и быстро.
- **Картинка** → [src/content/files.ts](src/content/files.ts) скачивает файл (OCR будет в L2).
- **Документ** → скачивает файл; имя файла → заголовок-сигнал.

**Запись в БД** — [src/db/items.ts](src/db/items.ts) `insertItem`: `raw_text` (подпись/текст), `url`,
`title`, `description`, `file_path`, **`tg_message_id`** (id исходного сообщения — для перехода к
источнику).

**Детект напоминания** — на живом одиночном приёме text/link/doc [src/ingest/classify.ts](src/ingest/classify.ts)
`detectReminder` тем же дешёвым LLM-вызовом ловит «напомни …» (категорий нет — только напоминание).

**Edit сообщения:** финал делает L2 — бот редактирует «Принял» → **«✅ Принял — «{заголовок}»»**
(заголовок: OG-title ссылки, имя файла, vision/STT-резюме). Без кнопок: управление записью — в карточке.

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
3. **Голос/видео** → STT [src/ai/stt.ts](src/ai/stt.ts) (Groq whisper) → `transcript` (скрытый) +
   LLM-заголовок (`classifyWithTitle`), на живом приёме — заодно детект «напомни …».
4. **Эмбеддинг** → `buildIndexText` (title+desc+raw+ocr+transcript+url, БЕЗ источника, до 8000 симв.) →
   [src/ai/embeddings.ts](src/ai/embeddings.ts) (OpenAI `text-embedding-3-small`, вектор **1536**) →
   запись в `embedding` + `indexed_at`. Кластеризации/категорий нет — организация по источнику, поиск по вектору.

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

- **Папки по источнику** `/folders` ([src/bot/handlers/browse.ts](src/bot/handlers/browse.ts)): список
  каналов (`sourceChat`) + «📥 Загружено вручную» (`sourceChat IS NULL`). Детерминированно, без ярлыков.
- **Дайджест** `/digest` ([src/retrieval/digest.ts](src/retrieval/digest.ts)): простой список последней
  активности за 7 дней (свежие сверху, со ссылками), без тем и LLM.

---

## Хранилище

Postgres + pgvector, Drizzle ([src/db/schema.ts](src/db/schema.ts)):

- **users** — `id` (tg user id), `settings` (jsonb), `import_done`.
- **items** — `type`, `raw_text`, `url`, `title`, `description`, `ocr_text` (скрытый), `transcript`
  (скрытый), `embedding` (vector 1536), `source_chat`, `tg_message_id`, `indexed_at`, `remind_*`.
- Индексы: **HNSW** на `items.embedding` (`vector_cosine_ops`) — быстрый семантический поиск (и item-kNN
  рёбра созвездия).

---

## AI-провайдер

Единый ключ **OpenAI**: LLM `gpt-4o-mini` (классификация/синтез/дайджест) + эмбеддинги
`text-embedding-3-small` (1536). Клиенты OpenAI-совместимы ([src/ai/llm.ts](src/ai/llm.ts),
[src/ai/embeddings.ts](src/ai/embeddings.ts)) — смена провайдера = `.env`, без правок кода.
Бот хостится на зарубежном VPS (OpenAI блокирует РФ по гео-IP).

## Локальный запуск

`/start-project` и `/stop-project` (скиллы в `.claude/skills/`) поднимают/гасят БД-контейнер и бота.
Подробности — [README.md](README.md).
