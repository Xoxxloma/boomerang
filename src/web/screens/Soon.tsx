import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import type { ItemDTO, ReminderDTO } from '../lib/types.js';
import { EmptyState, BeamLoader } from '../components/States.js';
import { TYPE_GLYPH, remindWhen, localInputToIso } from '../lib/format.js';
import { hapticImpact, hapticTap } from '../lib/telegram.js';

type Status = 'loading' | 'done' | 'error';
type Bucket = 'today' | 'tomorrow' | 'later';

const BUCKET_LABEL: Record<Bucket, string> = {
  today: 'Сегодня',
  tomorrow: 'Завтра',
  later: 'Позже',
};

/** Какая группа таймлайна (по локальной дате). Дублирует format.dayBucket, но на Date — для сортировки. */
function bucketOf(iso: string): Bucket {
  const d = new Date(iso);
  const now = new Date();
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(d) - start(now)) / 86_400_000);
  if (diff <= 0) return 'today';
  if (diff === 1) return 'tomorrow';
  return 'later';
}

export function SoonScreen({ onOpenItem }: { onOpenItem: (it: ItemDTO) => void }) {
  const [reminders, setReminders] = useState<ReminderDTO[] | null>(null);
  const [status, setStatus] = useState<Status>('loading');

  const load = () => {
    setStatus('loading');
    api
      .upcoming()
      .then((r) => {
        setReminders(r.reminders);
        setStatus('done');
      })
      .catch(() => setStatus('error'));
  };

  useEffect(load, []);

  const groups: Bucket[] = ['today', 'tomorrow', 'later'];

  return (
    <div className="screen screen-pad-top">
      <h1 className="display">Скоро вернётся</h1>
      <p className="lede">Что вернётся по твоим напоминаниям — и когда. Можно перенести, отменить или вернуть сейчас.</p>

      {status === 'loading' && <BeamLoader label="смотрю, что на подходе…" />}

      {status === 'error' && (
        <p className="body" style={{ color: 'var(--muted)' }}>
          Не удалось загрузить — попробуй позже.
        </p>
      )}

      {status === 'done' && reminders && reminders.length === 0 && (
        <EmptyState
          glyph="🪃"
          title="Пока ничего не запланировано"
          hint="Открой любую запись и нажми «Напомнить» — она вернётся в нужный момент."
        />
      )}

      {status === 'done' &&
        reminders &&
        reminders.length > 0 &&
        groups.map((b) => {
          const rows = reminders.filter((r) => bucketOf(r.remindAt) === b);
          if (rows.length === 0) return null;
          return (
            <section key={b} style={{ marginTop: 'var(--s6)' }}>
              <div className="echo-kind" style={{ marginBottom: 'var(--s2)' }}>
                {BUCKET_LABEL[b]}
              </div>
              {rows.map((r) => (
                <ReminderRow key={r.id} reminder={r} onOpenItem={onOpenItem} onChanged={load} />
              ))}
            </section>
          );
        })}
    </div>
  );
}

/** Минимум для <input type="datetime-local"> (сейчас) в локальном формате YYYY-MM-DDTHH:MM. */
function nowLocalInput(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function ReminderRow({
  reminder,
  onOpenItem,
  onChanged,
}: {
  reminder: ReminderDTO;
  onOpenItem: (it: ItemDTO) => void;
  onChanged: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      onChanged();
    } catch {
      setBusy(false); // на ошибке остаёмся (onChanged не вызван) — пусть юзер повторит
    }
  };

  const onReschedule = (value: string) => {
    const iso = localInputToIso(value);
    if (!iso) return;
    hapticImpact('light');
    void run(() => api.reschedule(reminder.id, iso));
  };

  return (
    <div className="echo-card" data-kind="resonance">
      <button
        className="item-row"
        style={{ padding: 0, background: 'none', border: 'none' }}
        onClick={() => {
          hapticTap();
          onOpenItem(reminder);
        }}
      >
        <span className="item-glyph" aria-hidden>
          {TYPE_GLYPH[reminder.type]}
        </span>
        <span className="item-main">
          <span className="item-title">{reminder.name}</span>
          <span className="item-meta">
            <span className="meta">🪃 вернётся {remindWhen(reminder.remindAt)}</span>
          </span>
        </span>
      </button>

      <div className="sheet-actions" style={{ marginTop: 'var(--s3)', flexWrap: 'wrap', gap: 'var(--s2)' }}>
        <button className="btn-secondary" disabled={busy} onClick={() => setPicking((v) => !v)}>
          Перенести
        </button>
        <button
          className="btn-secondary"
          disabled={busy}
          onClick={() => {
            hapticImpact('medium');
            void run(() => api.remindNow(reminder.id));
          }}
        >
          Вернуть сейчас
        </button>
        <button
          className="btn-secondary"
          disabled={busy}
          onClick={() => {
            hapticImpact('light');
            void run(() => api.cancelReminder(reminder.id));
          }}
        >
          Отменить
        </button>
      </div>

      {picking && (
        <input
          type="datetime-local"
          className="soon-picker"
          min={nowLocalInput()}
          style={{ marginTop: 'var(--s2)' }}
          onChange={(e) => onReschedule(e.target.value)}
        />
      )}
    </div>
  );
}
