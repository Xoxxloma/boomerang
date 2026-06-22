import { and, desc, eq, gt, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { items, type Item } from '../db/schema.js';

export interface Digest {
  text: string;
}

const MAX_ITEMS = 15; // материалов в дайджесте

/** Экранирование для parse_mode: HTML — текстовый узел (& < >). */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
/** Экранирование значения href (& и "). */
function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/** Человекочитаемый заголовок материала для строки дайджеста (≤80 симв., в одну строку). */
function titleOf(it: Item): string {
  // У картинок заголовок даёт vision-аннотация (L2); сырой OCR/description показывать нельзя (§3.4),
  // поэтому без title — типизированный плейсхолдер.
  if (it.type === 'image') {
    const t = it.title?.trim();
    return t ? `🖼 ${t.replace(/\s+/g, ' ').slice(0, 77)}` : '🖼 Изображение';
  }
  const raw = it.title ?? it.rawText ?? it.url ?? 'без названия';
  return raw.trim().replace(/\s+/g, ' ').slice(0, 80);
}

/** Строка-материал: кликабельная ссылка, если есть url; иначе просто экранированный заголовок. */
function renderItem(it: Item): string {
  const name = escapeHtml(titleOf(it));
  return it.url ? ` • <a href="${escapeAttr(it.url)}">${name}</a>` : ` • ${name}`;
}

/**
 * Режим 3 (§6): дайджест «вот что стоит вернуть за период» — простой список последней активности
 * (свежие сверху, со ссылками для клика-возврата). Категорий/тем больше нет (организация по источнику,
 * поиск по вектору), поэтому без группировки и без кнопок «Свести» — связный синтез доступен в поиске.
 */
export async function buildDigest(userId: number, days = 7): Promise<Digest> {
  const rows = await db
    .select()
    .from(items)
    .where(and(eq(items.userId, userId), gt(items.createdAt, sql`now() - (${days} || ' days')::interval`)))
    .orderBy(desc(items.createdAt))
    .limit(MAX_ITEMS);

  const [c] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(items)
    .where(and(eq(items.userId, userId), gt(items.createdAt, sql`now() - (${days} || ' days')::interval`)));
  const total = c?.total ?? 0;

  if (total === 0) {
    return {
      text: `За последние ${days} дн. ты ничего не сохранял. Перешли что-нибудь — и спроси (🔍 Найти).`,
    };
  }

  const head = `За последние ${days} дн. — ${total} материалов. Вот что стоит вернуть:`;
  const list = rows.map(renderItem).join('\n');
  const tail =
    total > rows.length ? `\n\n…и ещё ${total - rows.length}. Спроси точечно — 🔍 Найти или /find.` : '';
  const text = `${head}\n\n${list}${tail}`.slice(0, 4096);
  return { text };
}
