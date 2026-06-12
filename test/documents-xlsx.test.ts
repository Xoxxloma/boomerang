import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import { readDocument } from '../src/content/documents.js';

const path = join(tmpdir(), `boomerang-test-${process.pid}.xlsx`);

beforeAll(async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Смета');
  ws.addRow(['Работы', 'Цена']);
  ws.addRow(['Демонтаж стен', 12000]);
  ws.addRow(['Укладка плитки', 45000]);
  const ws2 = wb.addWorksheet('Контакты');
  ws2.addRow(['Прораб', 'Иван Петрович']);
  await wb.xlsx.writeFile(path);
});

afterAll(async () => {
  await rm(path, { force: true });
});

describe('readDocument .xlsx', () => {
  it('читает все листы: имена листов, текст и числа ячеек', async () => {
    const text = await readDocument(path);
    expect(text).toContain('[Смета]');
    expect(text).toContain('Демонтаж стен');
    expect(text).toContain('45000');
    expect(text).toContain('[Контакты]');
    expect(text).toContain('Иван Петрович');
  });

  it('неподдержанное расширение → пустая строка (превратится в docUnreadable)', async () => {
    expect(await readDocument('whatever.xls')).toBe('');
  });
});
