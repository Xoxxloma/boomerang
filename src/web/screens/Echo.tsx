import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import type { EchoCard, ItemDTO } from '../lib/types.js';
import { EmptyState, BeamLoader } from '../components/States.js';
import { IconBoomerang } from '../components/Icons.js';
import { longDate } from '../lib/format.js';
import { hapticImpact } from '../lib/telegram.js';

function pluralMaterials(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'материал';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'материала';
  return 'материалов';
}

export function EchoScreen({
  onOpenItem,
  onSynth,
}: {
  onOpenItem: (it: ItemDTO) => void;
  onSynth: (clusterId: string, name: string) => void;
}) {
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
          <EchoCardView
            key={`${card.kind}-${i}`}
            card={card}
            index={i}
            onOpenItem={onOpenItem}
            onSynth={onSynth}
          />
        ))}
    </div>
  );
}

function EchoCardView({
  card,
  index,
  onOpenItem,
  onSynth,
}: {
  card: EchoCard;
  index: number;
  onOpenItem: (it: ItemDTO) => void;
  onSynth: (clusterId: string, name: string) => void;
}) {
  const style = { animationDelay: `${Math.min(index, 8) * 55}ms` };

  if (card.kind === 'maturity' && card.clusterId && card.clusterName) {
    const n = card.count ?? 0;
    return (
      <div className="echo-card rise" data-kind="maturity" style={style}>
        <div className="echo-kind">созрело</div>
        <div className="echo-headline">Тема «{card.clusterName}» готова к своду</div>
        <div className="echo-sub">
          {n} {pluralMaterials(n)} накопилось — собрать в один связный ответ?
        </div>
        <button
          className="return-btn"
          onClick={() => {
            hapticImpact('medium');
            onSynth(card.clusterId!, card.clusterName!);
          }}
        >
          <IconBoomerang /> Свести
        </button>
      </div>
    );
  }

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
