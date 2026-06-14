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

  // Смахивание вниз — тач-жест (на десктопе лист закрывают затемнением/Escape/«Закрыть»). Намеренно
  // НЕ pointer events: у них preventDefault не отменяет нативный скролл (его рулит touch-action), а
  // hover-move мышью ложно «тянул» лист. Тач-события с non-passive touchmove дают честный preventDefault.
  // Перехватываем, только когда контент прокручен в самый верх и палец идёт вниз — иначе это скролл.
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;

    let startY = 0;
    let startT = 0;
    let active = false; // уже тянем лист
    let tracking = false; // палец на листе, решаем: скролл это или смахивание
    let fromGrip = false;

    const start = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t || e.touches.length !== 1) return;
      startY = t.clientY;
      startT = e.timeStamp;
      active = false;
      tracking = true;
      fromGrip = (e.target as HTMLElement).classList.contains('sheet-grip');
    };

    const move = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!tracking || !t) return;
      const dy = t.clientY - startY;
      if (!active) {
        if (dy > 6 && (fromGrip || el.scrollTop <= 0)) {
          active = true;
          setDragging(true);
        } else if (dy < -6 || el.scrollTop > 0) {
          tracking = false; // это скролл контента — отдаём браузеру, лист не дёргаем
          return;
        } else {
          return;
        }
      }
      if (dy <= 0) {
        el.style.transform = '';
        return;
      }
      e.preventDefault(); // гасим нативный скролл/баунс, пока тянем лист
      el.style.transform = `translateY(${dy}px)`;
    };

    const end = (e: TouchEvent) => {
      if (!tracking) return;
      tracking = false;
      if (active) {
        active = false;
        const dy = Math.max(0, (e.changedTouches[0]?.clientY ?? startY) - startY);
        const v = dy / Math.max(1, e.timeStamp - startT);
        if (dy > DISMISS_PX || v > FLICK) {
          onClose();
          return;
        }
      }
      setDragging(false);
      el.style.transform = ''; // снап обратно (transition на .sheet анимирует возврат)
    };

    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', end);
    return () => {
      el.removeEventListener('touchstart', start);
      el.removeEventListener('touchmove', move);
      el.removeEventListener('touchend', end);
      el.removeEventListener('touchcancel', end);
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
