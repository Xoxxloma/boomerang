import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api.js';
import type { ItemDTO, SearchResponse } from '../lib/types.js';
import { SynthBody } from './Answer.js';
import { BeamLoader } from './States.js';
import { IconClose } from './Icons.js';

/** Лист «Свести тему»: синтез по записям кластера (кнопка из Эха/Карты). Один лист за раз — */
/** открытие источника закрывает этот лист и открывает карточку записи (управляет родитель). */
export function SynthSheet({
  clusterId,
  clusterName,
  onOpenItem,
  onClose,
}: {
  clusterId: string;
  clusterName: string;
  onOpenItem: (it: ItemDTO) => void;
  onClose: () => void;
}) {
  const [res, setRes] = useState<SearchResponse | null>(null);
  const [status, setStatus] = useState<'loading' | 'done' | 'error'>('loading');
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    api
      .synthesize(clusterId)
      .then((r) => alive && (setRes(r), setStatus('done')))
      .catch((e) => {
        if (!alive) return;
        setError(
          e instanceof ApiError && e.status === 429
            ? e.reason === 'user'
              ? `Дневной лимит исчерпан. Обновится в ${e.resetsAt ?? 'полночь UTC'}.`
              : 'Свод временно недоступен из-за нагрузки.'
            : 'Не вышло свести — попробуй позже.',
        );
        setStatus('error');
      });
    return () => {
      alive = false;
    };
  }, [clusterId]);

  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={`Свод темы ${clusterName}`}>
        <div className="sheet-grip" />
        <div className="echo-kind" style={{ color: 'var(--beam)' }}>
          Свод темы
        </div>
        <h2 className="title" style={{ fontSize: '1.2rem' }}>
          «{clusterName}»
        </h2>

        <div style={{ marginTop: 'var(--s4)' }}>
          {status === 'loading' && <BeamLoader label="свожу тему в один ответ…" />}
          {status === 'error' && (
            <p className="body" style={{ color: 'var(--muted)' }}>
              {error}
            </p>
          )}
          {status === 'done' && res && <SynthBody res={res} onOpenItem={onOpenItem} />}
        </div>

        <div className="sheet-actions">
          <button className="btn-secondary" onClick={onClose}>
            <IconClose /> Закрыть
          </button>
        </div>
      </div>
    </>
  );
}
