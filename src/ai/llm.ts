import OpenAI from 'openai';
import { env } from '../config/env.js';
import { tuning } from '../config/tuning.js';
import { enforce, recordUsage } from './usage.js';
import { alertIfUsageMissing } from '../bot/alerts.js';

/**
 * LLM-клиент на OpenAI SDK. В v0.1 — OpenAI gpt-4o-mini.
 * Клиент OpenAI-совместим: смена на DeepSeek/Qwen = LLM_BASE_URL + LLM_MODEL в .env, без кода.
 */
const client = new OpenAI({
  apiKey: env.LLM_API_KEY,
  baseURL: env.LLM_BASE_URL,
});

export interface ChatOptions {
  system?: string;
  temperature?: number;
  /** Запросить строгий JSON-объект в ответе. */
  json?: boolean;
  /** Кому отнести расход (бюджет-гарды): персональный потолок + атрибуция стоимости. */
  userId?: number;
  /** Потолок выходных токенов (worst-case bound). Нет — дефолт из tuning. */
  maxTokens?: number;
}

/** Однократный chat-вызов, возвращает текст ответа. */
export async function chat(prompt: string, opts: ChatOptions = {}): Promise<string> {
  // Бюджет-гард ДО обращения к API: paused → стоп всему, персональный потолок → стоп юзеру.
  enforce(opts.userId ?? null);

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: prompt });

  const res = await client.chat.completions.create({
    model: env.LLM_MODEL,
    messages,
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.maxTokens ?? tuning.llmMaxTokensDefault,
    ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
  });

  const promptTokens = res.usage?.prompt_tokens ?? 0;
  const completionTokens = res.usage?.completion_tokens ?? 0;
  recordUsage(opts.userId ?? null, 'llm', promptTokens, completionTokens);
  // Нет usage → учёт ослеп. На нормальном пути (usage есть) выходит мгновенно, латентности не добавляет.
  await alertIfUsageMissing('llm', promptTokens, completionTokens);

  return res.choices[0]?.message?.content?.trim() ?? '';
}

/** chat + парсинг JSON-ответа. Бросает, если ответ не распарсился. */
export async function chatJson<T>(prompt: string, opts: Omit<ChatOptions, 'json'> = {}): Promise<T> {
  const text = await chat(prompt, { ...opts, json: true });
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`LLM вернул не-JSON: ${text.slice(0, 200)}`);
  }
}
