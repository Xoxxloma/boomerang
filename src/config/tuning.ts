import 'dotenv/config';

/**
 * Пороги и параметры качества (§12). Вынесены из кода, чтобы подбирать на своём корпусе через .env
 * без правок и пересборки. В отличие от env.ts (обязательные секреты, падаем если нет) — здесь всё
 * опционально и со здравыми дефолтами: модуль НИКОГДА не бросает, поэтому безопасен в юнит-тестах
 * (чистые функции вроде clusterMatch не должны тянуть валидацию секретов).
 */
function num(key: string, def: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}

function str(key: string, def: string): string {
  const raw = process.env[key];
  return raw === undefined || raw.trim() === '' ? def : raw.trim();
}

export const tuning = {
  /** Косинус-близость к центроиду, ниже которой заводим новый кластер (cluster/assign). */
  clusterThreshold: num('CLUSTER_THRESHOLD', 0.45),
  /** Порог семантической похожести в поиске; ниже — отсекаем как нерелевантное (retrieval/search). */
  searchMinSimilarity: num('SEARCH_MIN_SIMILARITY', 0.15),
  /** Мягкий порог косинуса для recall-пути по категории (retrieval/search). Ниже основного
   *  searchMinSimilarity: recall существует ради «растворённой темы» (низкий косинус), но не
   *  должен тащить случайных соседей по кластеру (мусор того же домена). Калибруется на корпусе. */
  recallMinSimilarity: num('RECALL_MIN_SIMILARITY', 0.1),
  /** Триграммная близость имени кластера к слову запроса для recall-пути (retrieval/clusterMatch). */
  clusterNameMatchThreshold: num('CLUSTER_NAME_MATCH_THRESHOLD', 0.45),
  /** Размер кластера, на котором шлём «тема созрела» (режим 2, один раз). */
  maturityThreshold: num('MATURITY_THRESHOLD', 5),
  /** Резонанс показываем, только если «старому соседу» уже хотя бы столько дней (режим 2). */
  resonanceMinAgeDays: num('RESONANCE_MIN_AGE_DAYS', 10),
  /** Не показывать один и тот же старый item проактивно чаще, чем раз в столько дней (режим 2). */
  resonanceSurfaceCooldownDays: num('RESONANCE_SURFACE_COOLDOWN_DAYS', 30),
  /** Режим 2: максимум проактивных РЕЗОНАНСОВ в сутки на юзера (созревание не ограничиваем). */
  proactiveDailyCap: num('PROACTIVE_DAILY_CAP', 2),

  /**
   * Окно «тишины» (мс) авто-завершения заливки: если столько не приходило новых частей — флашим
   * буфер и закрываем сессию (import/burst → гейт оседания + enqueueBurstReflush). Покрывает и альбомы.
   */
  burstSettleMs: num('BURST_SETTLE_MS', 2500),

  // --- Напоминания («верни в момент T»): дефолт времени, snooze, sweep. ---
  /** Час (по tz юзера), на который ставим напоминание, если время не указано явно («напомни завтра»). */
  remindDefaultHour: num('REMIND_DEFAULT_HOUR', 9),
  /** Сколько минут добавляет кнопка «Отложить +1ч». */
  remindSnoozeHourMin: num('REMIND_SNOOZE_HOUR_MIN', 60),
  /** Сколько минут добавляет кнопка «Отложить +1д». */
  remindSnoozeDayMin: num('REMIND_SNOOZE_DAY_MIN', 1440),
  /** Сколько созревших напоминаний забираем за один тик cron-sweep (bound на пачку доставки). */
  remindSweepBatch: num('REMIND_SWEEP_BATCH', 50),
  /** IANA-таймзона по умолчанию, пока юзер не открыл Mini App (оттуда прилетает Intl.timeZone). */
  remindDefaultTz: str('REMIND_DEFAULT_TZ', 'Europe/Moscow'),

  // --- Карта «Созвездие»: рёбра по реальным мостам между записями, не по центроидам кластеров. ---
  /** Сколько ближайших соседей из ДРУГИХ кластеров берём на каждую запись при подсчёте мостов. */
  bridgeKnn: num('BRIDGE_KNN', 4),
  /** Порог item-похожести, ниже которой пара записей не считается «мостом» между темами. Выше
   *  recallMinSimilarity (там ловим растворённую тему), ниже clusterThreshold: мост — это реальная
   *  общая нить, а не случайный сосед по домену. Калибруется на корпусе (косинусы на русском низкие). */
  bridgeMinItemSim: num('BRIDGE_MIN_ITEM_SIM', 0.45),

  // --- Бюджет-гарды на LLM-расходы (учёт стоимости, потолки, breaker). Цены $/1k токенов. ---
  /** Цена входных токенов LLM $/1k (gpt-4o-mini); СВЕРИТЬ при смене модели в ai/llm.ts. */
  llmPricePromptPer1k: num('LLM_PRICE_PROMPT_PER_1K', 0.00015),
  /** Цена выходных токенов LLM $/1k (gpt-4o-mini). */
  llmPriceCompletionPer1k: num('LLM_PRICE_COMPLETION_PER_1K', 0.0006),
  /** Цена эмбеддингов $/1k (text-embedding-3-small). */
  embeddingPricePer1k: num('EMBEDDING_PRICE_PER_1K', 0.00002),
  /** Цена транскрипции $/минута аудио — Groq whisper-large-v3-turbo ($0.04/час);
   *  СВЕРИТЬ при смене модели/провайдера в ai/stt.ts. */
  sttPricePerMinute: num('STT_PRICE_PER_MINUTE', 0.000667),
  /** Цена входных токенов vision $/1k (gpt-4o-mini; prompt_tokens ответа уже включает image-токены,
   *  low detail ≈ 2.8k). СВЕРИТЬ при смене модели в ai/vision.ts. */
  visionPricePromptPer1k: num('VISION_PRICE_PROMPT_PER_1K', 0.00015),
  /** Цена выходных токенов vision $/1k (gpt-4o-mini). */
  visionPriceCompletionPer1k: num('VISION_PRICE_COMPLETION_PER_1K', 0.0006),
  /** Потолок выходных токенов vision-аннотации (описание + категория + заголовок). */
  visionMaxTokens: num('VISION_MAX_TOKENS', 250),
  /** Средняя уверенность tesseract (0–100), НИЖЕ которой OCR-текст считаем мусором из текстур
   *  (фото без текста) и не пишем в индекс — иначе шум течёт в эмбеддинг и в LLM-синтез. */
  ocrMinConfidence: num('OCR_MIN_CONFIDENCE', 40),
  /** Дефолтный потолок выходных токенов на один chat-вызов (worst-case bound). */
  llmMaxTokensDefault: num('LLM_MAX_TOKENS', 700),
  /** Потолок токенов на синтез ответа (режим 1). */
  synthMaxTokens: num('SYNTH_MAX_TOKENS', 700),
  /** Сколько источников максимум отдаём в синтез (bound на размер промпта). */
  synthMaxSources: num('SYNTH_MAX_SOURCES', 8),
  /** Потолок символов на источник в контексте синтеза (коротким типам хватает — подпись/title/OG). */
  synthSnippetChars: num('SYNTH_SNIPPET_CHARS', 600),
  /** Потолок символов на ОДИН документ в контексте синтеза (у тела до 40k шапки мало — даём фактуру). */
  synthDocChars: num('SYNTH_DOC_CHARS', 3000),
  /** Персональный дневной потолок расхода ($/юзер/день). Превышение → стоп этому юзеру до полуночи UTC. */
  userDailyCostCeilingUsd: num('USER_DAILY_COST_CEILING_USD', 0.5),
  /** Мягкий общий дневной порог ($): выше — degraded (режем дорогую генерацию). */
  globalDailySoftLimitUsd: num('GLOBAL_DAILY_SOFT_LIMIT_USD', 5),
  /** Жёсткий общий дневной порог ($): выше — paused (стоп всему). */
  globalDailyHardLimitUsd: num('GLOBAL_DAILY_HARD_LIMIT_USD', 10),
} as const;
