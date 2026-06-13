import type { ReactNode } from 'react';
import type { ItemDTO, SearchResponse } from '../lib/types.js';
import { ItemRow } from './ItemRow.js';

/** Текст ответа с цитатами [n], заменёнными на кликабельные чипы (открывают источник). */
export function renderAnswer(answer: string, onCite: (index: number) => void): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\[(\d+)\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(answer))) {
    if (m.index > last) out.push(answer.slice(last, m.index));
    const n = Number(m[1]);
    out.push(
      <button key={`c${key++}`} className="citation" onClick={() => onCite(n)}>
        {n}
      </button>,
    );
    last = m.index + m[0].length;
  }
  if (last < answer.length) out.push(answer.slice(last));
  return out;
}

/**
 * Тело результата синтеза: связный ответ с кликабельными цитатами + список процитированных источников
 * (в list-режиме — все найденные). Общий для экрана Поиска и листа «Свести» в Эхе/Карте.
 */
export function SynthBody({
  res,
  onOpenItem,
}: {
  res: SearchResponse;
  onOpenItem: (it: ItemDTO) => void;
}) {
  const cited = new Set(res.cited);
  const citedSources = res.sources.filter((s) => cited.has(s.index));
  const list = res.answer ? citedSources : res.sources;
  const openCited = (n: number) => {
    const s = res.sources.find((x) => x.index === n);
    if (s) onOpenItem(s);
  };
  return (
    <>
      {res.answer && <p className="answer">{renderAnswer(res.answer, openCited)}</p>}
      {list.length > 0 && (
        <>
          {res.answer && <p className="section-label">Источники</p>}
          {list.map((s) => (
            <ItemRow key={s.id} item={s} onOpen={onOpenItem} />
          ))}
        </>
      )}
    </>
  );
}
