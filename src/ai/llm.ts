import OpenAI from 'openai';
import { env } from '../config/env.js';

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
}

/** Однократный chat-вызов, возвращает текст ответа. */
export async function chat(prompt: string, opts: ChatOptions = {}): Promise<string> {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: prompt });

  const res = await client.chat.completions.create({
    model: env.LLM_MODEL,
    messages,
    temperature: opts.temperature ?? 0.3,
    ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
  });

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
