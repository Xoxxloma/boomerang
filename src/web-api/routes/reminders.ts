import { Hono } from 'hono';
import { IANAZone } from 'luxon';
import { listUpcoming, setReminder, clearReminder, setReminderSettings } from '../../db/reminders.js';
import { enqueueRemindNow } from '../../queue/index.js';
import { toItemDTO } from '../serialize.js';
import type { AuthVars } from '../server.js';

export const remindersRoutes = new Hono<{ Variables: AuthVars }>();

/** Ближайшие напоминания пользователя — для экрана «Скоро вернётся». remindAt отдаём ISO рядом с DTO. */
remindersRoutes.get('/upcoming', async (c) => {
  const userId = c.get('userId');
  const rows = await listUpcoming(userId, 50);
  return c.json({
    reminders: rows.map((it) => ({ ...toItemDTO(it), remindAt: it.remindAt!.toISOString() })),
  });
});

/** Распарсить и провалидировать абсолютное время из тела (вебапп считает пресеты в браузерной tz). */
function parseFuture(remindAt: unknown): Date | null {
  if (typeof remindAt !== 'string') return null;
  const at = new Date(remindAt);
  if (Number.isNaN(at.getTime()) || at.getTime() <= Date.now()) return null;
  return at;
}

/** Создать/перенести напоминание на item (кнопка «Напомнить» / перенос в «Скоро»). setReminder сам по userId. */
remindersRoutes.post('/reminders', async (c) => {
  const userId = c.get('userId');
  const body = await c.req
    .json<{ itemId?: unknown; remindAt?: unknown }>()
    .catch(() => ({}) as { itemId?: unknown; remindAt?: unknown });
  if (typeof body.itemId !== 'string') return c.json({ error: 'no-item' }, 400);
  const at = parseFuture(body.remindAt);
  if (!at) return c.json({ error: 'bad-time' }, 400);
  const ok = await setReminder(body.itemId, userId, at);
  return ok ? c.json({ ok: true, remindAt: at.toISOString() }) : c.json({ error: 'not-found' }, 404);
});

remindersRoutes.post('/reminders/:id/reschedule', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<{ remindAt?: unknown }>().catch(() => ({}) as { remindAt?: unknown });
  const at = parseFuture(body.remindAt);
  if (!at) return c.json({ error: 'bad-time' }, 400);
  const ok = await setReminder(c.req.param('id'), userId, at);
  return ok ? c.json({ ok: true, remindAt: at.toISOString() }) : c.json({ error: 'not-found' }, 404);
});

remindersRoutes.post('/reminders/:id/cancel', async (c) => {
  const userId = c.get('userId');
  const ok = await clearReminder(c.req.param('id'), userId);
  return ok ? c.json({ ok: true }) : c.json({ error: 'not-found' }, 404);
});

/** «Вернуть сейчас»: помечаем созревшим (now) и немедленно дёргаем sweep, не дожидаясь минутного cron. */
remindersRoutes.post('/reminders/:id/now', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const ok = await setReminder(id, userId, new Date());
  if (!ok) return c.json({ error: 'not-found' }, 404);
  await enqueueRemindNow(id);
  return c.json({ ok: true });
});

/** Таймзона юзера из Mini App (Intl.timeZone) — нужна бот-стороне для пресетов напоминаний. */
remindersRoutes.post('/settings/tz', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<{ tz?: unknown }>().catch(() => ({}) as { tz?: unknown });
  if (typeof body.tz !== 'string' || !IANAZone.isValidZone(body.tz)) {
    return c.json({ error: 'bad-tz' }, 400);
  }
  await setReminderSettings(userId, { tz: body.tz });
  return c.json({ ok: true });
});
