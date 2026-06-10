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

export const tuning = {
  /** Косинус-близость к центроиду, ниже которой заводим новый кластер (cluster/assign). */
  clusterThreshold: num('CLUSTER_THRESHOLD', 0.45),
  /** Порог семантической похожести в поиске; ниже — отсекаем как нерелевантное (retrieval/search). */
  searchMinSimilarity: num('SEARCH_MIN_SIMILARITY', 0.15),
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

  // --- Бюджет-гарды на LLM-расходы (учёт стоимости, потолки, breaker). Цены $/1k токенов. ---
  /** Цена входных токенов LLM $/1k. Дефолт — gpt-4o-mini; СВЕРИТЬ с актуальным прайсом LLM_MODEL. */
  llmPricePromptPer1k: num('LLM_PRICE_PROMPT_PER_1K', 0.00015),
  /** Цена выходных токенов LLM $/1k (gpt-4o-mini). */
  llmPriceCompletionPer1k: num('LLM_PRICE_COMPLETION_PER_1K', 0.0006),
  /** Цена эмбеддингов $/1k (text-embedding-3-small). */
  embeddingPricePer1k: num('EMBEDDING_PRICE_PER_1K', 0.00002),
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
