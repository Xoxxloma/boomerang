import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import type { EchoCard, ItemDTO } from '../lib/types.js';
import { EmptyState, BeamLoader } from '../components/States.js';
import { IconBoomerang } from '../components/Icons.js';
import { longDate } from '../lib/format.js';

export function EchoScreen({ onOpenItem }: { onOpenItem: (it: ItemDTO) => void }) {
  const [cards, setCards] = useState<EchoCard[] | null>(null);
  const [status, setStatus] = useState<'loading' | 'done' | 'error'>('loading');

  useEffect(() => {
    let alive = true;
    api
      .echo()
      .then((r) => alive && (setCards(r.cards), setStatus('done')))
      .catch(() => alive && setStatus('error'));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="screen screen-pad-top">
      <h1 className="display">Возвращается</h1>
      <p className="lede">Накопленное само всплывает наверх — то, к чему стоит вернуться сегодня.</p>

      {status === 'loading' && <BeamLoader label="смотрю, что притягивается…" />}

      {status === 'error' && (
        <p className="body" style={{ color: 'var(--muted)' }}>
          Не удалось собрать ленту — попробуй позже.
        </p>
      )}

      {status === 'done' && cards && cards.length === 0 && (
        <EmptyState
          glyph="🪃"
          title="Пока тихо"
          hint="Когда накопится материал, сюда сами начнут возвращаться темы, годовщины и переклички."
        />
      )}

      {status === 'done' &&
        cards?.map((card, i) => (
          <EchoCardView key={`${card.kind}-${i}`} card={card} index={i} onOpenItem={onOpenItem} />
        ))}
    </div>
  );
}

function EchoCardView({
  card,
  index,
  onOpenItem,
}: {
  card: EchoCard;
  index: number;
  onOpenItem: (it: ItemDTO) => void;
}) {
  const style = { animationDelay: `${Math.min(index, 8) * 55}ms` };

  if (card.kind === 'on_this_day' && card.item) {
    const it = card.item;
    return (
      <button
        className="echo-card rise"
        data-kind="on_this_day"
        style={style}
        onClick={() => onOpenItem(it)}
      >
        <div className="echo-kind">в этот день</div>
        <div className="echo-headline">{it.name}</div>
        <div className="echo-sub">{longDate(it.createdAt)}</div>
      </button>
    );
  }

  if (card.kind === 'resonance' && card.relatedItem && card.item) {
    const old = card.relatedItem;
    return (
      <button
        className="echo-card rise"
        data-kind="resonance"
        style={style}
        onClick={() => onOpenItem(old)}
      >
        <div className="echo-kind">перекликается</div>
        <div className="echo-headline">{old.name}</div>
        <div className="echo-pair">
          <IconBoomerang style={{ width: 16, height: 16, color: 'var(--accent)', flex: 'none' }} />
          <span className="meta">недавно ты сохранил «{card.item.name}»</span>
        </div>
      </button>
    );
  }

  return null;
}
