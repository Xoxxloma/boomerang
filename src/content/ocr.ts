import { createWorker, type Worker } from 'tesseract.js';

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
