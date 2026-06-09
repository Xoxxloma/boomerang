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
} as const;
