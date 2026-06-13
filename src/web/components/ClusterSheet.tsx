import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import type { ClusterItemsResponse, ItemDTO } from '../lib/types.js';
import { ItemRow } from './ItemRow.js';
import { BeamLoader } from './States.js';
import { IconBoomerang, IconClose } from './Icons.js';
import { hapticImpact } from '../lib/telegram.js';

/** Лист со спутниками узла-кластера: список записей темы + кнопка «Свести» (синтез по теме). */
export function ClusterSheet({
  clusterId,
  clusterName,
  onOpenItem,
  onSynth,
  onClose,
}: {
  clusterId: string;
  clusterName: string;
  onOpenItem: (it: ItemDTO) => void;
  onSynth: (clusterId: string, name: string) => void;
  onClose: () => void;
}) {
  const [data, setData] = useState<ClusterItemsResponse | null>(null);
  const [status, setStatus] = useState<'loading' | 'done' | 'error'>('loading');

  useEffect(() => {
    let alive = true;
    api
      .clusterItems(clusterId)
      .then((r) => alive && (setData(r), setStatus('done')))
      .catch(() => alive && setStatus('error'));
    return () => {
      alive = false;
    };
  }, [clusterId]);

  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={clusterName}>
        <div className="sheet-grip" />
        <div className="echo-kind">созвездие</div>
        <h2 className="title" style={{ fontSize: '1.2rem' }}>
          «{clusterName}»
        </h2>

        <div style={{ marginTop: 'var(--s4)' }}>
          {status === 'loading' && <BeamLoader />}
          {status === 'error' && (
            <p className="body" style={{ color: 'var(--muted)' }}>
              Не удалось открыть тему — попробуй позже.
            </p>
          )}
          {status === 'done' &&
            data?.items.map((it) => <ItemRow key={it.id} item={it} onOpen={onOpenItem} />)}
        </div>

        <div className="sheet-actions">
          <button
            className="return-btn"
            onClick={() => {
              hapticImpact('medium');
              onSynth(clusterId, clusterName);
            }}
          >
            <IconBoomerang /> Свести тему
          </button>
          <button className="btn-secondary" onClick={onClose}>
            <IconClose /> Закрыть
          </button>
        </div>
      </div>
    </>
  );
}
