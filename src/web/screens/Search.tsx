import { useState } from 'react';
import { api, ApiError } from '../lib/api.js';
import type { ItemDTO, SearchResponse } from '../lib/types.js';
import { SynthBody } from '../components/Answer.js';
import { EmptyState, BeamLoader } from '../components/States.js';
import { IconSearch } from '../components/Icons.js';
import { hapticImpact } from '../lib/telegram.js';

const EXAMPLES = ['что я сохранял про ИИ', 'ипотека и ставки', 'документы за месяц'];

type Status = 'idle' | 'loading' | 'done' | 'error';

export function SearchScreen({ onOpenItem }: { onOpenItem: (it: ItemDTO) => void }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [res, setRes] = useState<SearchResponse | null>(null);
  const [error, setError] = useState('');

  async function run(q: string) {
    const text = q.trim();
    if (!text) return;
    setQuery(text);
    setStatus('loading');
    setRes(null);
    setError('');
    hapticImpact('light');
    try {
      setRes(await api.search(text));
      setStatus('done');
    } catch (e) {
      if (e instanceof ApiError && e.status === 429) {
        setError(
          e.reason === 'user'
            ? `Дневной лимит исчерпан. Обновится в ${e.resetsAt ?? 'полночь UTC'}.`
            : 'Поиск временно недоступен из-за нагрузки — попробуй позже.',
        );
      } else {
        setError('Поиск сейчас недоступен — попробуй ещё раз через минуту.');
      }
      setStatus('error');
    }
  }

  return (
    <div className="screen screen-pad-top">
      <h1 className="display">Спросить архив</h1>
      <p className="lede">Связный ответ со ссылками на твои источники — не список, а сведённая мысль.</p>

      <form
        className="search-field"
        onSubmit={(e) => {
          e.preventDefault();
          run(query);
        }}
      >
        <IconSearch style={{ width: 18, height: 18, color: 'var(--muted)', flex: 'none' }} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Например: ипотека и ставки"
          enterKeyHint="search"
          autoComplete="off"
        />
      </form>

      {status === 'idle' && (
        <div className="chip-row" style={{ marginTop: 'var(--s2)' }}>
          {EXAMPLES.map((ex) => (
            <button key={ex} className="chip" onClick={() => run(ex)}>
              {ex}
            </button>
          ))}
        </div>
      )}

      {status === 'loading' && <BeamLoader label="свожу найденное в ответ…" />}

      {status === 'error' && (
        <p className="body" style={{ color: 'var(--muted)' }}>
          {error}
        </p>
      )}

      {status === 'done' && res && (
        <>
          {res.mode === 'empty' ? (
            <EmptyState
              glyph="🔭"
              title="Пока пусто по этому запросу"
              hint="Перешли боту что-нибудь по теме — и спроси снова."
            />
          ) : (
            <>
              {res.mode === 'list' && <p className="section-label">Найдено по фильтру</p>}
              <SynthBody res={res} onOpenItem={onOpenItem} />
            </>
          )}
        </>
      )}
    </div>
  );
}
