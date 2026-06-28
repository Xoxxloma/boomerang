import { useEffect, useState } from 'react';
import type { ItemDTO } from '../lib/types.js';
import { Sheet } from './Sheet.js';
import { ItemRow } from './ItemRow.js';
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
 * Блок «Рядом» — семантические соседи (item-kNN): тап переключает лист на соседа (ассоциативная
 * навигация по архиву), без закрытия. Внешняя смена `item` сбрасывает текущую запись.
 */
export function ItemSheet({ item, onClose }: { item: ItemDTO; onClose: () => void }) {
  const [current, setCurrent] = useState(item);
  const [similar, setSimilar] = useState<ItemDTO[]>([]);

  useEffect(() => setCurrent(item), [item]);

  useEffect(() => {
    let alive = true;
    setSimilar([]);
    api
      .similar(current.id)
      .then((r) => alive && setSimilar(r.similar))
      .catch(() => {
        /* тихо: блок «Рядом» просто не покажем */
      });
    return () => {
      alive = false;
    };
  }, [current.id]);

  return (
    <Sheet label={current.name} onClose={onClose}>
      <div className="echo-kind">
          <span aria-hidden>{TYPE_GLYPH[current.type]}</span> {TYPE_LABEL[current.type]}
        </div>
        <h2 className="title" style={{ fontSize: '1.2rem', lineHeight: 1.35 }}>
          {current.title ?? current.name}
        </h2>
        <div className="item-meta" style={{ marginTop: 'var(--s2)' }}>
          {current.sourceChat && <span className="meta">{current.sourceChat}</span>}
          <span className="meta">{current.sourceChat ? '· ' : ''}{relDate(current.createdAt)}</span>
        </div>

        {current.text &&
          (current.url && current.text.trim() === current.url.trim() ? (
            // Голый URL (ссылка без подписи): одной строкой с многоточием — не растягиваем карточку.
            <span className="url-line" style={{ marginTop: 'var(--s4)' }} title={current.text}>
              {current.text}
            </span>
          ) : (
            <p className="body" style={{ marginTop: 'var(--s4)', color: 'var(--ink)' }}>
              {current.text}
            </p>
          ))}

        <div className="sheet-actions">
          {current.url && (
            <button
              className="return-btn"
              onClick={() => {
                hapticImpact('light');
                openLink(current.url!);
              }}
            >
              <IconBoomerang /> Открыть источник
            </button>
          )}
          {/* key — чтобы при переходе на соседа панель напоминания пересоздалась и не несла
              состояние (savedIso/open) прошлой записи: иначе напоминание можно поставить не на ту. */}
          <RemindPanel key={current.id} itemId={current.id} />
          <button className="btn-secondary" onClick={onClose}>
            <IconClose /> Закрыть
          </button>
        </div>

        {similar.length > 0 && (
          <div className="similar" style={{ marginTop: 'var(--s4)' }}>
            <div className="echo-kind" style={{ marginBottom: 'var(--s2)' }}>
              <span aria-hidden>🪐</span> Рядом
            </div>
            {similar.map((s) => (
              <ItemRow key={s.id} item={s} onOpen={(it) => setCurrent(it)} />
            ))}
          </div>
        )}
    </Sheet>
  );
}
