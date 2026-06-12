import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import OpenAI, { toFile } from 'openai';
import { env } from '../config/env.js';
import { enforce, recordSttSeconds } from './usage.js';
import { notifyAdmins } from '../bot/alerts.js';

/**
 * STT-клиент (транскрипция голосовых/аудио/видео): Groq whisper-large-v3-turbo,
 * endpoint OpenAI-совместим (/audio/transcriptions). Провайдер и модель — константы:
 * при смене сверить sttPricePerMinute в tuning.ts, иначе учёт расхода «поедет».
 */
const STT_BASE_URL = 'https://api.groq.com/openai/v1';
const STT_MODEL = 'whisper-large-v3-turbo';

/** Потолок длины транскрипта (символы) — зеркало MAX_DOC_CHARS: защита индекса от многочасовых записей. */
const MAX_TRANSCRIPT_CHARS = 40_000;

/**
 * Консервативная оценка длительности по размеру файла, если провайдер не вернул duration:
 * 32 kbps (≈4000 байт/с) — НИЖНЯЯ граница битрейта сжатого аудио, оценка завышает секунды,
 * значит бюджет-гард не недосчитает (безопасно в сторону перерасхода учёта, не денег).
 */
const FALLBACK_BYTES_PER_SECOND = 4000;

/** Ленивый клиент: создаём при первом вызове. */
let client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({ apiKey: env.STT_API_KEY, baseURL: STT_BASE_URL });
  }
  return client;
}

/**
 * Telegram отдаёт голосовые как .oga — Groq это расширение не принимает (формат тот же ogg/opus).
 * Переименовываем ТОЛЬКО имя при upload, сам файл не трогаем.
 */
function uploadName(path: string): string {
  const name = basename(path);
  return name.endsWith('.oga') ? name.slice(0, -4) + '.ogg' : name;
}

/**
 * Транскрибирует аудио(дорожку) файла. Бюджет-гард ДО вызова (enforce), учёт расхода после —
 * по duration из ответа (verbose_json); нет duration → оценка по размеру + алерт админам
 * (иначе учёт STT молча слепнет — паттерн alertIfUsageMissing).
 * Язык не передаём — whisper определяет сам (контент бывает любым).
 */
export async function transcribe(path: string, userId?: number): Promise<string> {
  enforce(userId ?? null);

  const file = await toFile(createReadStream(path), uploadName(path));
  const res = (await getClient().audio.transcriptions.create({
    file,
    model: STT_MODEL,
    response_format: 'verbose_json',
    temperature: 0,
    // SDK типизирует verbose_json без duration — приводим к фактической форме ответа.
  })) as unknown as { text?: string; duration?: number };

  let seconds = res.duration;
  if (!(typeof seconds === 'number' && seconds > 0)) {
    const { size } = await stat(path).catch(() => ({ size: 0 }));
    seconds = size / FALLBACK_BYTES_PER_SECOND;
    await notifyAdmins(
      'usage-missing:stt',
      '⚠️ Бюджет-гард: ответ STT-API без поля duration. Расход посчитан оценкой по размеру файла ' +
        `(завышенной) — проверь провайдера STT (${STT_MODEL}, stt.ts).`,
    );
  }
  recordSttSeconds(userId ?? null, seconds);

  return (res.text ?? '').trim().slice(0, MAX_TRANSCRIPT_CHARS);
}
