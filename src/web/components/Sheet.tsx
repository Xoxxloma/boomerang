import { useEffect, useRef, useState, type ReactNode } from 'react';

/** За сколько px смещения вниз лист закрывается (либо быстрым фликом — см. FLICK). */
const DISMISS_PX = 100;
/** Скорость флика (px/ms): резкий рывок вниз закрывает даже не дотянув до DISMISS_PX. */
const FLICK = 0.5;

/**
 * Общая обёртка нижних листов: затемнение (тап — закрыть), панель с «грипом», Escape и смахивание
 * вниз для закрытия (привычный мобильный паттерн). Жест живёт здесь, чтобы не дублировать в 4 листах.
 * Чтобы Telegram не сворачивал весь Mini App на вертикальном свайпе — в initApp() зовём
 * disableVerticalSwipes(); жест забираем себе тут.
 */
export function Sheet({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  // Escape закрывает любой лист (раньше было только в ItemSheet).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Смахивание вниз. Тянем лист, только если контент прокручен в самый верх (иначе это обычный скролл)
  // или жест начат с грипа. transform двигаем императивно — плавнее, чем гонять состояние на кадр.
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;

    let startY = 0;
    let startT = 0;
    let active = false; // уже тянем лист (а не скроллим контент)
    let fromGrip = false;

    const down = (e: PointerEvent) => {
      startY = e.clientY;
      startT = e.timeStamp;
      active = false;
      fromGrip = (e.target as HTMLElement).classList.contains('sheet-grip');
    };

    const move = (e: PointerEvent) => {
      const dy = e.clientY - startY;
      if (!active) {
        if (fromGrip || (dy > 6 && el.scrollTop <= 0)) {
          active = true;
          el.setPointerCapture(e.pointerId);
          setDragging(true);
        } else {
          return;
        }
      }
      if (dy <= 0) {
        el.style.transform = '';
        return;
      }
      e.preventDefault(); // не даём вебвью скроллить, пока тянем лист
      el.style.transform = `translateY(${dy}px)`;
    };

    const up = (e: PointerEvent) => {
      const wasActive = active;
      active = false;
      if (wasActive) {
        const dy = Math.max(0, e.clientY - startY);
        const v = dy / Math.max(1, e.timeStamp - startT);
        if (dy > DISMISS_PX || v > FLICK) {
          onClose();
          return;
        }
      }
      setDragging(false);
      el.style.transform = ''; // снап обратно (transition на .sheet анимирует возврат)
    };

    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move, { passive: false });
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
  }, [onClose]);

  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <div
        ref={panelRef}
        className={`sheet${dragging ? ' dragging' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={label}
      >
        <div className="sheet-grip" />
        {children}
      </div>
    </>
  );
}
