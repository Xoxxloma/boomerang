/** Пустое состояние — спокойный «потухший» орбитальный знак + объяснение, что это значит. */
export function EmptyState({ glyph, title, hint }: { glyph: string; title: string; hint?: string }) {
  return (
    <div className="empty-state">
      <div className="empty-orb" aria-hidden>
        {glyph}
      </div>
      <p className="title" style={{ color: 'var(--ink)' }}>
        {title}
      </p>
      {hint && <p style={{ marginTop: 'var(--s2)' }}>{hint}</p>}
    </div>
  );
}

/** Луч синтеза: тёплая полоса бежит, пока собираем ответ (метафора притяжения найденного). */
export function BeamLoader({ label }: { label?: string }) {
  return (
    <div>
      <div className="beam-loader" role="progressbar" aria-label={label ?? 'Загрузка'} />
      {label && <p className="meta spinner-line">{label}</p>}
    </div>
  );
}
