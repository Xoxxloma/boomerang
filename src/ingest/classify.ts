import { chatJson } from '../ai/llm.js';
import { CLASSIFY_SYSTEM, classifyPrompt, CLASSIFY_TITLE_SYSTEM, classifyTitlePrompt } from '../ai/prompts.js';
import { LINKS_SHELF } from '../cluster/assign.js';
import { buildClassifySignal, isContentlessLink, type Indexable } from './extract.js';

/**
 * L1-классификация по дешёвому сигналу: одна короткая категория (§5 Level 1).
 * Это «ощущение порядка» для человека, НЕ механизм поиска (поиск — по эмбеддингам).
 * В вехе 4 поверх этого появятся кластеры; промах тут не критичен.
 */
export async function classify(it: Indexable, userId: number): Promise<string> {
  // Ссылка-пустышка (ни подписи, ни OG, в URL только хост): темы нет — не зовём LLM гадать по
  // домену (avito → ложная «Недвижимость»), кладём на нейтральную полку. Бесплатно и честно.
  if (isContentlessLink(it)) return LINKS_SHELF;

  const signal = buildClassifySignal(it);
  if (!signal.trim()) return 'Разное';

  try {
    const { category } = await chatJson<{ category: string }>(classifyPrompt(signal), {
      system: CLASSIFY_SYSTEM,
      temperature: 0,
      userId,
      maxTokens: 64,
    });
    return cleanCategory(category);
  } catch (err) {
    console.error('classify error:', err);
    return 'Разное';
  }
}

/** Валидация категории из LLM: общая для classify/classifyWithTitle/vision, чтобы правила не разошлись. */
export function cleanCategory(category: string | undefined): string {
  const cleaned = category?.trim();
  return cleaned && cleaned.length <= 40 ? cleaned : 'Разное';
}

/**
 * Категория + заголовок ОДНИМ LLM-вызовом — для голосовых/видео после транскрипции (L2):
 * у них нет своего названия, без title запись в выдаче — пустышка. Один вызов вместо двух —
 * дешевле и не дублирует прогон того же сигнала. Фолбэк как у classify: любой сбой →
 * {'Разное', null} — пайплайн не падает (STT уже отработал, индекс по транскрипту ценен и так).
 */
export async function classifyWithTitle(
  it: Indexable,
  userId: number,
): Promise<{ category: string; title: string | null }> {
  const signal = buildClassifySignal(it);
  if (!signal.trim()) return { category: 'Разное', title: null };

  try {
    const res = await chatJson<{ category: string; title: string }>(classifyTitlePrompt(signal), {
      system: CLASSIFY_TITLE_SYSTEM,
      temperature: 0,
      userId,
      maxTokens: 128,
    });
    const title = res.title?.trim().slice(0, 80) || null;
    return { category: cleanCategory(res.category), title };
  } catch (err) {
    console.error('classifyWithTitle error:', err);
    return { category: 'Разное', title: null };
  }
}
