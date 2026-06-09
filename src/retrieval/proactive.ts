import { InlineKeyboard } from 'grammy';
import type { AssignResult } from '../cluster/assign.js';
import type { Item } from '../db/schema.js';
import { getBotApi } from '../bot/api.js';
import { getProactiveMode, type ProactiveMode } from '../db/users.js';
import { getCluster, setClusterMatured } from '../db/clusters.js';
import { findOlderSiblingInCluster } from '../db/items.js';
import { logSurfacing, wasItemSurfacedRecently } from '../db/surfacing.js';
import { tuning } from '../config/tuning.js';

/**
 * Пороги проактивного всплытия (режим 2). Подбираются эмпирически на своём корпусе (§12),
 * настраиваются через RESONANCE_MIN_AGE_DAYS / RESONANCE_SURFACE_COOLDOWN_DAYS / MATURITY_THRESHOLD в .env.
 */
/** Резонанс показываем только если «старому соседу» уже хотя бы столько дней. */
const RESONANCE_MIN_AGE_DAYS = tuning.resonanceMinAgeDays;
/** Не показывать один и тот же старый item проактивно чаще, чем раз в столько дней. */
const RESONANCE_SURFACE_COOLDOWN_DAYS = tuning.resonanceSurfaceCooldownDays;
/** На каком размере кластера шлём «тема созрела» (один раз). */
export const MATURITY_THRESHOLD = tuning.maturityThreshold;

export type Trigger = 'maturity' | 'resonance';

/**
 * Чистая логика выбора триггера (без БД/сети — тестируется отдельно).
 * Максимум один на входящий item; maturity приоритетнее resonance.
 * - новый кластер → ничего (всплытие только когда новое легло к старому);
 * - размер ровно достиг порога и ещё не слали maturity → maturity;
 * - иначе (дополнили существующий) → resonance-кандидат.
 */
export function pickTrigger(result: AssignResult, maturedAt: Date | null): Trigger | null {
  if (result.isNew) return null;
  if (result.size === MATURITY_THRESHOLD && maturedAt === null) return 'maturity';
  return 'resonance';
}

function titleOf(it: Item): string {
  const raw = it.title ?? it.rawText ?? it.url ?? 'без названия';
  return raw.trim().slice(0, 80);
}

/**
 * Проактивное всплытие после отнесения item к кластеру (вызывается в L2-воркере).
 * Никогда не бросает — фон не должен падать из-за всплытия.
 */
export async function maybeSurface(item: Item, result: AssignResult): Promise<void> {
  try {
    const mode = await getProactiveMode(item.userId);
    if (mode === 'off') return;

    const cluster = await getCluster(result.clusterId);
    if (!cluster) return;

    const trigger = pickTrigger(result, cluster.maturedAt);
    if (!trigger) return;

    if (trigger === 'maturity') {
      const text = `🪃 У тебя накопилось ${result.size} материалов в теме «${cluster.name}». Свести? /find ${cluster.name}`;
      await setClusterMatured(cluster.id);
      await logSurfacing({
        userId: item.userId,
        kind: 'maturity',
        clusterId: cluster.id,
        triggerItemId: item.id,
      });
      await send(item.userId, text, null, mode);
      return;
    }

    // resonance: ищем самого похожего старого соседа, мимо тех, что недавно уже показывали.
    const emb = item.embedding as number[] | null;
    if (!emb) return;
    const [old] = await findOlderSiblingInCluster(
      item.userId,
      cluster.id,
      item.id,
      emb,
      RESONANCE_MIN_AGE_DAYS,
    );
    if (!old) return;
    if (await wasItemSurfacedRecently(item.userId, old.id, RESONANCE_SURFACE_COOLDOWN_DAYS)) return;

    const text = `🪃 Кстати, по этой теме ты уже сохранял: ${titleOf(old)}`;
    await logSurfacing({
      userId: item.userId,
      kind: 'resonance',
      itemId: old.id,
      clusterId: cluster.id,
      triggerItemId: item.id,
    });
    await send(item.userId, text, old, mode);
  } catch (err) {
    console.error('maybeSurface error:', err);
  }
}

/**
 * Отправка всплытия. В личке tgUserId === chatId. mode === undefined → первый показ: добавляем
 * opt-in кнопки (один бесплатный образец демонстрирует ценность, дальше — по выбору пользователя).
 */
async function send(
  userId: number,
  text: string,
  resonanceItem: Item | null,
  mode: ProactiveMode | undefined,
): Promise<void> {
  const kb = new InlineKeyboard();
  let hasButtons = false;

  if (resonanceItem?.tgMessageId) {
    kb.text('↑ Источник', `src:${resonanceItem.id}`).row();
    hasButtons = true;
  }

  let body = text;
  if (mode === undefined) {
    body += '\n\nВключить такие напоминания?';
    kb.text('Да, включать', 'optin:on').text('Не надо', 'optin:off');
    hasButtons = true;
  }

  await getBotApi().sendMessage(userId, body, {
    link_preview_options: { is_disabled: true },
    ...(hasButtons ? { reply_markup: kb } : {}),
  });
}
