import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';

/** Верхняя граница извлекаемого текста: 2–10 стр. влезают; защита от гигантских файлов. */
const MAX_DOC_CHARS = 40_000;

/**
 * Извлечь текст документа (§3.3). Поддержка PDF, Word (.docx) и Excel (.xlsx).
 * Редкий «дорогой край» — читаем целиком при сохранении (по токенам терпимо).
 * Легаси .xls сознательно не поддержан (экзотика; exceljs его не читает) — пустой результат
 * честно превратится в «⚠️ прочитать не смог» (docUnreadable в L2), а не в тихую пустышку.
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
    if (ext === '.xlsx') {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(path);
      const sheets: string[] = [];
      wb.eachSheet((sheet) => {
        const rows: string[] = [];
        sheet.eachRow((row) => {
          // row.values — массив с дыркой в [0]; значения ячеек приводим к строкам, объекты
          // (формулы/гиперссылки/richText) — через их text/result, иначе JSON-шум в индексе.
          const cells = (row.values as unknown[])
            .slice(1)
            .map((v) => cellText(v))
            .filter((s) => s !== '');
          if (cells.length) rows.push(cells.join('\t'));
        });
        if (rows.length) sheets.push(`[${sheet.name}]\n${rows.join('\n')}`);
      });
      return clip(sheets.join('\n\n'));
    }
    if (ext === '.txt' || ext === '.md') {
      return clip(await readFile(path, 'utf8'));
    }
  } catch (err) {
    console.error('readDocument error:', err);
  }
  return '';
}

/** Ячейка exceljs → текст: примитивы как есть, формулы/гиперссылки/richText — их видимое значение. */
function cellText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v).trim();
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const o = v as { text?: unknown; result?: unknown; richText?: { text: string }[] };
    if (o.richText) return o.richText.map((r) => r.text).join('').trim();
    if (o.text != null) return cellText(o.text);
    if (o.result != null) return cellText(o.result);
  }
  return '';
}

function clip(s: string): string {
  return s.replace(/\s+\n/g, '\n').trim().slice(0, MAX_DOC_CHARS);
}
