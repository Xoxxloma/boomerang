import { readFile } from 'node:fs/promises';
import OpenAI from 'openai';
import { env } from '../config/env.js';
import { tuning } from '../config/tuning.js';
import { enforce, recordVisionUsage } from './usage.js';
import { alertIfUsageMissing } from '../bot/alerts.js';
import { VISION_SYSTEM, visionPrompt } from './prompts.js';
import { cleanCategory } from '../ingest/classify.js';

/**
 * Vision-аннотация картинок (L2): один дешёвый вызов возвращает описание + категорию + заголовок.
 * Описание — «сырьё» в индекс (items.description, юзеру не показывается — как OCR/транскрипт),
 * категория — сид тематического кластера, заголовок — в выдачу. Vision НЕ заменяет OCR: при
 * detail:'low' картинка ужимается до 512px и плотный текст скринов не читается — дословные строки
 * (промокоды/адреса) даёт tesseract. Модель — константа: при смене сверить visionPrice* в tuning.ts.
 */
const VISION_MODEL = 'gpt-4o-mini';

/** Ленивый клиент: создаём при первом вызове. */
let client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  }
  return client;
}

export interface VisionContext {
  /** Подпись пользователя к картинке (может быть шумной). */
  caption?: string;
  /** OCR-выжимка (обрезанная) — подсказка для текста, который low-detail vision не прочитает. */
  ocr?: string;
  /** Имя источника (канал/чат). */
  source?: string;
}

export interface ImageAnnotation {
  description: string;
  category: string;
  title: string | null;
}

/**
 * Аннотировать картинку по локальному пути. Бюджет-гард ДО вызова (enforce), учёт расхода после.
 * Файл уходит base64 data-URL'ом (фото Telegram — всегда jpeg): telegram file URL передавать
 * НЕЛЬЗЯ — он содержит BOT_TOKEN и засветил бы его стороннему API. detail:'low' — OpenAI сам
 * ресайзит до 512px, фиксированная цена. Ошибки бросает (как transcribe) — различает вызывающий.
 */
export async function describeImage(
  path: string,
  ctx: VisionContext,
  userId?: number,
): Promise<ImageAnnotation> {
  enforce(userId ?? null);

  const b64 = (await readFile(path)).toString('base64');
  const res = await getClient().chat.completions.create({
    model: VISION_MODEL,
    messages: [
      { role: 'system', content: VISION_SYSTEM },
      {
        role: 'user',
        content: [
          { type: 'text', text: visionPrompt(ctx) },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}`, detail: 'low' } },
        ],
      },
    ],
    temperature: 0,
    max_tokens: tuning.visionMaxTokens,
    response_format: { type: 'json_object' },
  });

  const promptTokens = res.usage?.prompt_tokens ?? 0;
  const completionTokens = res.usage?.completion_tokens ?? 0;
  recordVisionUsage(userId ?? null, promptTokens, completionTokens);
  // Нет usage → учёт ослеп. Норма (usage есть) — выходит мгновенно, латентности не добавляет.
  await alertIfUsageMissing('vision', promptTokens, completionTokens);

  const text = res.choices[0]?.message?.content?.trim() ?? '';
  let parsed: { description?: string; category?: string; title?: string };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    throw new Error(`Vision вернул не-JSON: ${text.slice(0, 200)}`);
  }

  return {
    description: (parsed.description ?? '').trim().slice(0, 500),
    category: cleanCategory(parsed.category),
    title: parsed.title?.trim().slice(0, 80) || null,
  };
}
