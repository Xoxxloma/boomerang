import { and, desc, eq, gt, sql } from 'drizzle-orm';
import { InlineKeyboard } from 'grammy';
import { db } from '../db/client.js';
import { items, clusters, type Item } from '../db/schema.js';
import { IMAGE_SHELF } from '../cluster/assign.js';

interface Theme {
  clusterId: string | null;
  name: string;
  count: number;
  examples: Item[];
}

export interface Digest {
  text: string;
  /** Кнопки «Свести» по топ-темам (synth:<clusterId>) — undefined, если сводить нечего. */
  keyboard?: InlineKeyboard;
}

const MAX_THEMES = 5; // тем в дайджесте
const MAX_EXAMPLES = 3; // материалов на тему
const MAX_BUTTONS = 4; // кнопок «Свести»

/** Экранирование для parse_mode: HTML — текстовый узел (& < >). */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
/** Экранирование значения href (& и "). */
function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/** Склонение «изображение» под число (1 изображение / 2 изображения / 5 изображений). */
function imagesPlural(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'изображение';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'изображения';
  return 'изображений';
}

/** Человекочитаемый заголовок материала для строки дайджеста (≤80 симв., в одну строку). */
function titleOf(it: Item): string {
  // У картинок (§3.4) нет человекочитаемого имени, а сырой OCR показывать нельзя — типизированный плейсхолдер.
  if (it.type === 'image') return '🖼 Изображение';
  const raw = it.title ?? it.rawText ?? it.url ?? 'без названия';
  return raw.trim().replace(/\s+/g, ' ').slice(0, 80);
}

/** Строка-материал: кликабельная ссылка, если есть url; иначе просто экранированный заголовок. */
function renderItem(it: Item): string {
  const name = escapeHtml(titleOf(it));
  return it.url ? ` • <a href="${escapeAttr(it.url)}">${name}</a>` : ` • ${name}`;
}

/**
 * Режим 3 (§6): дайджест «вот что стоит вернуть за период». По тезису продукта (retrieval, не storage)
 * это КОНКРЕТНЫЙ индекс: топ-темы → реальные заголовки сохранённого со ссылками (клик → вернуться) +
 * кнопка «📋 Свести» на каждую тему (тап → связный синтез через synth:<clusterId>). Детерминированно,
 * без LLM-прозы — конкретика и есть ценность, синтез отдаём по требованию (кнопка).
 */
export async function buildDigest(userId: number, days = 7): Promise<Digest> {
  const rows = await db
    .select({ item: items, clusterName: clusters.name })
    .from(items)
    .leftJoin(clusters, eq(items.clusterId, clusters.id))
    .where(and(eq(items.userId, userId), gt(items.createdAt, sql`now() - (${days} || ' days')::interval`)))
    .orderBy(desc(items.createdAt));

  if (rows.length === 0) {
    return {
      text: `За последние ${days} дн. ты ничего не сохранял. Перешли что-нибудь — и я начну собирать темы.`,
    };
  }

  // Группируем по кластеру (clusterId как ключ; без кластера → одна полка «Разное», без кнопки).
  const byTheme = new Map<string, Theme>();
  for (const { item, clusterName } of rows) {
    const key = item.clusterId ?? '∅';
    const t = byTheme.get(key) ?? {
      clusterId: item.clusterId,
      name: clusterName ?? 'Разное',
      count: 0,
      examples: [],
    };
    t.count += 1;
    if (t.examples.length < MAX_EXAMPLES) t.examples.push(item);
    byTheme.set(key, t);
  }

  const themes = [...byTheme.values()].sort((a, b) => b.count - a.count).slice(0, MAX_THEMES);

  const head = `За последние ${days} дн. — ${rows.length} материалов в ${byTheme.size} темах. Вот что стоит вернуть:`;
  const blocks = themes.map((t) => {
    const header = `📁 <b>${escapeHtml(t.name)}</b> · ${t.count}`;
    // Полка изображений — все записи безымянны (§3.4): не перечисляем «без названия», даём агрегат.
    const body =
      t.name === IMAGE_SHELF
        ? ` 🖼 ${t.count} ${imagesPlural(t.count)} за период`
        : t.examples.map(renderItem).join('\n');
    return `${header}\n${body}`;
  });

  // Кнопки «Свести» — только темам с кластером (у «Разного» clusterId нет), не больше MAX_BUTTONS.
  const keyboard = new InlineKeyboard();
  let buttons = 0;
  for (const t of themes) {
    // Полку изображений не сводим (нет текста, §3.4) — кнопку не даём, только агрегат-блок выше.
    if (t.clusterId && t.name !== IMAGE_SHELF && buttons < MAX_BUTTONS) {
      keyboard.text(`📋 Свести «${t.name}»`, `synth:${t.clusterId}`).row();
      buttons += 1;
    }
  }

  const footer = buttons > 0 ? '\n\nТапни «Свести», чтобы собрать тему в один связный ответ.' : '';
  const text = `${head}\n\n${blocks.join('\n\n')}${footer}`.slice(0, 4096);

  return { text, keyboard: buttons > 0 ? keyboard : undefined };
}
