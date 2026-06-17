import { InlineKeyboard } from 'grammy';
import { LINKS_SHELF, type AssignResult } from '../cluster/assign.js';
import type { Item } from '../db/schema.js';
import { getBotApi } from '../bot/api.js';
import { getProactiveMode, type ProactiveMode } from '../db/users.js';
import { getCluster, bumpClusterMaturity } from '../db/clusters.js';
import { findOlderSiblingInCluster, listClusterContentFields } from '../db/items.js';
import { hasRealContent } from '../ingest/extract.js';
import { logSurfacing, wasItemSurfacedRecently, countSurfacedToday } from '../db/surfacing.js';
import { tuning } from '../config/tuning.js';

/**
 * Пороги проактивного всплытия (режим 2). Подбираются эмпирически на своём корпусе (§12),
 * настраиваются через RESONANCE_MIN_AGE_DAYS / RESONANCE_SURFACE_COOLDOWN_DAYS / MATURITY_THRESHOLD в .env.
 */
/** Резонанс показываем только если «старому соседу» уже хотя бы столько дней. */
const RESONANCE_MIN_AGE_DAYS = tuning.resonanceMinAgeDays;
/** Не показывать один и тот же старый item проактивно чаще, чем раз в столько дней. */
const RESONANCE_SURFACE_COOLDOWN_DAYS = tuning.resonanceSurfaceCooldownDays;
/** Шаг порога «тема созрела»: шлём на каждом кратном (5, 10, 15…) числе содержательных записей. */
export const MATURITY_THRESHOLD = tuning.maturityThreshold;

export type Trigger = 'maturity' | 'resonance';

/** Кратный порогу рубеж, достигнутый данным числом содержательных записей (вниз): 7→5, 12→10, 4→0. */
export function maturityMilestoneFor(contentfulSize: number): number {
  return Math.floor(contentfulSize / MATURITY_THRESHOLD) * MATURITY_THRESHOLD;
}

/**
 * Чистая логика выбора триггера (без БД/сети — тестируется отдельно).
 * Максимум один на входящий item; maturity приоритетнее resonance.
 * - новый кластер → ничего (всплытие только когда новое легло к старому);
 * - СОДЕРЖАТЕЛЬНЫХ записей пересекло новый кратный порогу рубеж (выше уже отправленного) → maturity;
 * - иначе (дополнили существующий) → resonance-кандидат.
 * contentfulSize — число записей кластера с реальным содержимым (hasRealContent): пустышки
 * (только имя файла/URL) не должны «дозревать» тему — сводить по ним нечего (инцидент с «Недвижимостью»).
 * lastMilestone — последний кратный, на котором уже слали maturity (clusters.maturity_milestone, 0 — ни разу).
 * Повтор на каждом новом кратном: floor-рубеж текущего счёта строго больше отправленного → созрело снова.
 * Скачок (5→15 за раз) объявляем один раз на достигнутом рубеже (15), промежуточный 10 не дублируем.
 */
export function pickTrigger(result: AssignResult, lastMilestone: number, contentfulSize: number): Trigger | null {
  if (result.isNew) return null;
  const milestone = maturityMilestoneFor(contentfulSize);
  if (milestone >= MATURITY_THRESHOLD && milestone > lastMilestone) return 'maturity';
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

    // Полка «Ссылки» — пустышки без темы: ни «созревание» (сводить нечего), ни резонанс
    // («ты уже сохранял: avito.ru» — мусорное напоминание) по ней не шлём.
    if (cluster.name === LINKS_SHELF) return;

    // Пустышки (только имя/URL) тему не «зреют» — сводить по ним нечего. Считаем содержательные
    // ТОЛЬКО когда общий size дорос до СЛЕДУЮЩЕГО кратного порогу рубежа (дешёвая верхняя оценка) —
    // вне окна селект не делаем.
    let contentful = 0;
    if (!result.isNew && result.size >= cluster.maturityMilestone + MATURITY_THRESHOLD) {
      const fields = await listClusterContentFields(item.userId, cluster.id);
      contentful = fields.filter(hasRealContent).length;
    }

    const trigger = pickTrigger(result, cluster.maturityMilestone, contentful);
    if (!trigger) return;

    if (trigger === 'maturity') {
      // Созревание — на каждом новом кратном порогу, дневным лимитом НЕ режем. Кнопка «📋 Свести» вместо /find.
      // В тексте — число СОДЕРЖАТЕЛЬНЫХ (не обещаем 5 материалов, когда читаемых 3).
      const text = `У тебя накопилось ${contentful} материалов в теме «${cluster.name}». Свести в один ответ?`;
      // Сначала ОТПРАВКА, потом маркировка/лог: если send упал (403 — юзер заблокировал бота, сеть),
      // рубеж НЕ поднимется → «тема созрела» не потеряется, дойдёт со следующим item.
      // Риск нового порядка (send прошёл, bump упал → повтор) безобиднее молчаливой потери.
      await send(item.userId, text, null, mode, cluster.id);
      await bumpClusterMaturity(cluster.id, maturityMilestoneFor(contentful));
      await logSurfacing({
        userId: item.userId,
        kind: 'maturity',
        clusterId: cluster.id,
        triggerItemId: item.id,
      });
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
    // Дневной лимит резонанса (анти-спам): не больше PROACTIVE_DAILY_CAP в сутки. Созревание (выше) и
    // первый opt-in-образец не страдают (на чистом дне count=0). Maturity-сообщения тоже считаются.
    if ((await countSurfacedToday(item.userId)) >= tuning.proactiveDailyCap) return;

    const text = `Кстати, по этой теме ты уже сохранял: ${titleOf(old)}`;
    // Сначала ОТПРАВКА, потом лог: упавший send (403/сеть) не должен ни «съедать» дневной лимит
    // резонанса (countSurfacedToday считает логи), ни помечать old как недавно показанный.
    await send(item.userId, text, old, mode);
    await logSurfacing({
      userId: item.userId,
      kind: 'resonance',
      itemId: old.id,
      clusterId: cluster.id,
      triggerItemId: item.id,
    });
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
  synthClusterId?: string,
): Promise<void> {
  const kb = new InlineKeyboard();
  let hasButtons = false;

  if (resonanceItem?.tgMessageId) {
    kb.text('↑ Источник', `src:${resonanceItem.id}`).row();
    hasButtons = true;
  }

  // Созревание: кнопка сразу сводит тему в ответ (режим 1) — без ручного набора /find.
  if (synthClusterId) {
    kb.text('📋 Свести', `synth:${synthClusterId}`).row();
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
