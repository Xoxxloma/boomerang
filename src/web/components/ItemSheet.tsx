import { useState } from 'react';
import type { ItemDTO } from '../lib/types.js';
import { Sheet } from './Sheet.js';
import {
  TYPE_GLYPH,
  TYPE_LABEL,
  relDate,
  remindWhen,
  presetTomorrow,
  presetEvening,
  presetWeek,
  localInputToIso,
} from '../lib/format.js';
import { api } from '../lib/api.js';
import { openLink, hapticImpact } from '../lib/telegram.js';
import { IconBoomerang, IconClose, IconClock } from './Icons.js';

/** Мин. значение для datetime-local (сейчас, локальный формат). */
function nowLocalInput(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

/** Блок «Напомнить»: пресеты + своё время. После постановки показывает подтверждение. */
function RemindPanel({ itemId }: { itemId: string }) {
  const [open, setOpen] = useState(false);
  const [savedIso, setSavedIso] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = async (iso: string | null) => {
    if (!iso || busy) return;
    setBusy(true);
    hapticImpact('light');
    try {
      await api.createReminder(itemId, iso);
      setSavedIso(iso);
      setOpen(false);
    } catch {
      /* тихо: оставляем панель открытой, юзер повторит */
    } finally {
      setBusy(false);
    }
  };

  if (savedIso) {
    return (
      <p className="meta" style={{ marginTop: 'var(--s3)', color: 'var(--accent)' }}>
        🪃 Вернётся {remindWhen(savedIso)}
      </p>
    );
  }

  if (!open) {
    return (
      <button className="btn-secondary" onClick={() => setOpen(true)}>
        <IconClock /> Напомнить
      </button>
    );
  }

  return (
    <div className="remind-panel" style={{ width: '100%', marginTop: 'var(--s2)' }}>
      <div className="remind-chips" style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s2)' }}>
        <button className="chip" disabled={busy} onClick={() => void set(presetTomorrow())}>
          Завтра 9:00
        </button>
        <button className="chip" disabled={busy} onClick={() => void set(presetEvening())}>
          Вечером
        </button>
        <button className="chip" disabled={busy} onClick={() => void set(presetWeek())}>
          Через неделю
        </button>
      </div>
      <input
        type="datetime-local"
        className="soon-picker"
        min={nowLocalInput()}
        style={{ marginTop: 'var(--s2)' }}
        onChange={(e) => void set(localInputToIso(e.target.value))}
      />
    </div>
  );
}

/**
 * Нижний лист с карточкой записи. Показываем заголовок + СВОЙ текст пользователя (rawText, усечён на
 * сервере) — НЕ машинную аннотацию/OCR/транскрипт (правило проекта). Действие — открыть источник.
 */
export function ItemSheet({ item, onClose }: { item: ItemDTO; onClose: () => void }) {
  return (
    <Sheet label={item.name} onClose={onClose}>
      <div className="echo-kind">
          <span aria-hidden>{TYPE_GLYPH[item.type]}</span> {TYPE_LABEL[item.type]}
        </div>
        <h2 className="title" style={{ fontSize: '1.2rem', lineHeight: 1.35 }}>
          {item.title ?? item.name}
        </h2>
        <div className="item-meta" style={{ marginTop: 'var(--s2)' }}>
          {item.sourceChat && <span className="meta">{item.sourceChat}</span>}
          <span className="meta">{item.sourceChat ? '· ' : ''}{relDate(item.createdAt)}</span>
        </div>

        {item.text &&
          (item.url && item.text.trim() === item.url.trim() ? (
            // Голый URL (ссылка без подписи): одной строкой с многоточием — не растягиваем карточку.
            <span className="url-line" style={{ marginTop: 'var(--s4)' }} title={item.text}>
              {item.text}
            </span>
          ) : (
            <p className="body" style={{ marginTop: 'var(--s4)', color: 'var(--ink)' }}>
              {item.text}
            </p>
          ))}

        <div className="sheet-actions">
          {item.url && (
            <button
              className="return-btn"
              onClick={() => {
                hapticImpact('light');
                openLink(item.url!);
              }}
            >
              <IconBoomerang /> Открыть источник
            </button>
          )}
          <RemindPanel itemId={item.id} />
          <button className="btn-secondary" onClick={onClose}>
            <IconClose /> Закрыть
          </button>
        </div>
    </Sheet>
  );
}
