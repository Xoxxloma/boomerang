import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';

/** Верхняя граница извлекаемого текста: 2–10 стр. влезают; защита от гигантских файлов. */
const MAX_DOC_CHARS = 40_000;

/**
 * Извлечь текст документа (§3.3). Поддержка PDF и Word (.docx).
 * Редкий «дорогой край» — читаем целиком при сохранении (по токенам терпимо).
 */
export async function readDocument(path: string): Promise<string> {
  const ext = extname(path).toLowerCase();
  try {
    if (ext === '.pdf') {
      const buf = await readFile(path);
      const parser = new PDFParse({ data: buf });
      try {
        const data = await parser.getText();
        return clip(data.text);
      } finally {
        await parser.destroy();
      }
    }
    if (ext === '.docx') {
      const { value } = await mammoth.extractRawText({ path });
      return clip(value);
    }
    if (ext === '.txt' || ext === '.md') {
      return clip(await readFile(path, 'utf8'));
    }
  } catch (err) {
    console.error('readDocument error:', err);
  }
  return '';
}

function clip(s: string): string {
  return s.replace(/\s+\n/g, '\n').trim().slice(0, MAX_DOC_CHARS);
}
