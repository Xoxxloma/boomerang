import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import type { BridgeResponse, ItemDTO } from '../lib/types.js';
import { ItemRow } from './ItemRow.js';
import { BeamLoader } from './States.js';
import { IconClose } from './Icons.js';
import { Sheet } from './Sheet.js';

/**
 * Лист-«нити» под ребром созвездия: какие именно записи связывают две темы. Делает связь действием, а не
 * декорацией — пользователь видит реальные переклички (запись из A ↔ запись из B), а не «темы похожи».
 */
export function BridgeSheet({
  clusterA,
  clusterB,
  onOpenItem,
  onClose,
}: {
  clusterA: string;
  clusterB: string;
  onOpenItem: (it: ItemDTO) => void;
  onClose: () => void;
}) {
  const [data, setData] = useState<BridgeResponse | null>(null);
  const [status, setStatus] = useState<'loading' | 'done' | 'error'>('loading');

  useEffect(() => {
    let alive = true;
    api
      .bridge(clusterA, clusterB)
      .then((r) => alive && (setData(r), setStatus('done')))
      .catch(() => alive && setStatus('error'));
    return () => {
      alive = false;
    };
  }, [clusterA, clusterB]);

  return (
    <Sheet label="Нити между темами" onClose={onClose}>
      <div className="echo-kind">нити</div>
        {data && (
          <h2 className="title" style={{ fontSize: '1.2rem' }}>
            «{data.clusterA.name}» <span style={{ color: 'var(--beam)' }}>↔</span> «{data.clusterB.name}»
          </h2>
        )}

        <div style={{ marginTop: 'var(--s4)' }}>
          {status === 'loading' && <BeamLoader />}
          {status === 'error' && (
            <p className="body" style={{ color: 'var(--muted)' }}>
              Не удалось раскрыть связь — попробуй позже.
            </p>
          )}
          {status === 'done' && data && data.pairs.length === 0 && (
            <p className="body" style={{ color: 'var(--muted)' }}>
              Прямых нитей между темами не нашлось.
            </p>
          )}
          {status === 'done' &&
            data?.pairs.map((p, i) => (
              <div className="bridge-pair" key={`${p.itemA.id}-${p.itemB.id}-${i}`}>
                <ItemRow item={p.itemA} onOpen={onOpenItem} />
                <div className="bridge-link" aria-hidden>
                  <span className="bridge-link-line" />
                  <span className="bridge-link-glyph">✦</span>
                  <span className="bridge-link-line" />
                </div>
                <ItemRow item={p.itemB} onOpen={onOpenItem} />
              </div>
            ))}
        </div>

        <div className="sheet-actions">
          <button className="btn-secondary" onClick={onClose}>
            <IconClose /> Закрыть
          </button>
        </div>
    </Sheet>
  );
}
