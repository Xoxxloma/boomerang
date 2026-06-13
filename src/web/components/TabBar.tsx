import type { ComponentType, SVGProps } from 'react';
import { IconSearch, IconMap, IconBoomerang } from './Icons.js';
import { hapticTap } from '../lib/telegram.js';

export type Tab = 'search' | 'map' | 'echo';

const TABS: { id: Tab; label: string; Icon: ComponentType<SVGProps<SVGSVGElement>> }[] = [
  { id: 'echo', label: 'Эхо', Icon: IconBoomerang },
  { id: 'search', label: 'Поиск', Icon: IconSearch },
  { id: 'map', label: 'Карта', Icon: IconMap },
];

export function TabBar({ active, onChange }: { active: Tab; onChange: (t: Tab) => void }) {
  return (
    <nav className="tabbar" role="tablist" aria-label="Разделы">
      {TABS.map(({ id, label, Icon }) => (
        <button
          key={id}
          className="tab"
          role="tab"
          aria-selected={active === id}
          onClick={() => {
            if (active !== id) hapticTap();
            onChange(id);
          }}
        >
          <Icon />
          <span className="tab-label">{label}</span>
          <span className="tab-orb" aria-hidden />
        </button>
      ))}
    </nav>
  );
}
