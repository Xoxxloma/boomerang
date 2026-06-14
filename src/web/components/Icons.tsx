// Набор иконок Mini App. Тонкая «гравированная» линия в духе звёздного атласа (см. дизайн-систему).
import type { SVGProps } from 'react';

const base = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  viewBox: '0 0 24 24',
};

export function IconSearch(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.2-3.2" />
    </svg>
  );
}

/** Созвездие — узлы и связи. */
export function IconMap(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p}>
      <circle cx="6" cy="7" r="1.6" />
      <circle cx="18" cy="6" r="1.6" />
      <circle cx="13" cy="17" r="1.6" />
      <path d="M7.4 7.7 11.7 15.8M16.7 7 13.9 15.4M7.5 7 16.4 6.2" opacity="0.7" />
    </svg>
  );
}

/** Бумеранг — возврат. Используется в Эхо-табе и на кнопке «Свести/Вернуть». */
export function IconBoomerang(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p}>
      <path d="M5 5c6.5 0 11.5 4.8 11.5 11.2 0 .9-.2 1.8-.5 2.6-1.1-4.4-4.9-7.8-9.4-8.6" />
      <path d="M5 5l1.8 4.9" opacity="0.7" />
    </svg>
  );
}

export function IconSource(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p}>
      <path d="M9 17H7A5 5 0 0 1 7 7h2M15 7h2a5 5 0 0 1 0 10h-2M8 12h8" />
    </svg>
  );
}

export function IconClose(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

/** Часы — таб «Скоро вернётся». */
export function IconClock(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  );
}

export function IconTrash(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p}>
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13h10l1-13" />
    </svg>
  );
}
