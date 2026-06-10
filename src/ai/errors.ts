/**
 * Типизированные ошибки бюджет-гардов (§ бюджет-ядро). Бросаются в обёртках llm/embeddings
 * ДО обращения к API. Через instanceof их ловят воркер L2 и хендлеры, чтобы показать точное
 * сообщение вместо обезличенного сбоя.
 */

/** Юзер исчерпал персональный дневной потолок ($). resetsAt — когда обнулится (полночь UTC). */
export class QuotaExceededError extends Error {
  readonly resetsAt: Date;
  constructor(resetsAt: Date) {
    super('Дневной лимит расхода исчерпан');
    this.name = 'QuotaExceededError';
    this.resetsAt = resetsAt;
  }
}

/** Глобальный circuit breaker в состоянии paused — общий дневной бюджет исчерпан, стоп всему. */
export class BudgetExhaustedError extends Error {
  constructor() {
    super('Глобальный дневной бюджет исчерпан');
    this.name = 'BudgetExhaustedError';
  }
}
