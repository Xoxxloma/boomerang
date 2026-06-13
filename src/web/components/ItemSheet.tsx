import { useEffect } from 'react';
import type { ItemDTO } from '../lib/types.js';
import { TYPE_GLYPH, TYPE_LABEL, relDate } from '../lib/format.js';
import { openLink, hapticImpact } from '../lib/telegram.js';
import { IconBoomerang, IconClose } from './Icons.js';

/**
 * Нижний лист с карточкой записи. Показываем заголовок + СВОЙ текст пользователя (rawText, усечён на
 * сервере) — НЕ машинную аннотацию/OCR/транскрипт (правило проекта). Действие — открыть источник.
 */
export function ItemSheet({ item, onClose }: { item: ItemDTO; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={item.name}>
        <div className="sheet-grip" />
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
          <button className="btn-secondary" onClick={onClose}>
            <IconClose /> Закрыть
          </button>
        </div>
      </div>
    </>
  );
}
