import { chatJson } from '../ai/llm.js';
import { CLASSIFY_SYSTEM, classifyPrompt } from '../ai/prompts.js';
import { buildClassifySignal, type Indexable } from './extract.js';

/**
 * L1-классификация по дешёвому сигналу: одна короткая категория (§5 Level 1).
 * Это «ощущение порядка» для человека, НЕ механизм поиска (поиск — по эмбеддингам).
 * В вехе 4 поверх этого появятся кластеры; промах тут не критичен.
 */
export async function classify(it: Indexable, userId: number): Promise<string> {
  const signal = buildClassifySignal(it);
  if (!signal.trim()) return 'Разное';

  try {
    const { category } = await chatJson<{ category: string }>(classifyPrompt(signal), {
      system: CLASSIFY_SYSTEM,
      temperature: 0,
      userId,
      maxTokens: 64,
    });
    const cleaned = category?.trim();
    return cleaned && cleaned.length <= 40 ? cleaned : 'Разное';
  } catch (err) {
    console.error('classify error:', err);
    return 'Разное';
  }
}
