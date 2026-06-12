import { createWorker, type Worker } from 'tesseract.js';
import { tuning } from '../config/tuning.js';

/**
 * OCR картинок (§3.4). Это механическое считывание букв, НЕ понимание смысла.
 * Результат идёт ТОЛЬКО в индекс (ocr_text), пользователю не показывается.
 * Воркер тяжёлый — держим ленивый синглтон и переиспользуем.
 */
let workerPromise: Promise<Worker> | null = null;

function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    // rus+eng — наш контент (мемы со словами, скрины) почти всегда с текстом.
    workerPromise = createWorker(['rus', 'eng']);
  }
  return workerPromise;
}

/** Распознать текст с картинки по локальному пути. Пустая строка — ожидаемо для фото без текста. */
export async function ocrImage(path: string): Promise<string> {
  try {
    const worker = await getWorker();
    const { data } = await worker.recognize(path);
    // Гейт уверенности: на фото без текста tesseract «вычитывает» мусор из текстур, и без фильтра
    // он течёт в эмбеддинг и в LLM-синтез (источник галлюцинаций). У мусора confidence низкий,
    // у настоящего текста со скринов — высокий.
    if (data.confidence < tuning.ocrMinConfidence) return '';
    return data.text.trim();
  } catch (err) {
    console.error('OCR error:', err);
    return '';
  }
}

/** Корректное завершение воркера при остановке процесса. */
export async function terminateOcr(): Promise<void> {
  if (workerPromise) {
    const w = await workerPromise;
    await w.terminate();
    workerPromise = null;
  }
}
