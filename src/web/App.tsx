import { lazy, Suspense, useState } from 'react';
import type { ItemDTO } from './lib/types.js';
import { TabBar, type Tab } from './components/TabBar.js';
import { SearchScreen } from './screens/Search.js';
import { EchoScreen } from './screens/Echo.js';
import { SoonScreen } from './screens/Soon.js';
import { ItemSheet } from './components/ItemSheet.js';
import { BeamLoader } from './components/States.js';

// bundle-dynamic-imports: тяжёлый react-force-graph (бóльшая часть бандла) нужен только на вкладке
// Карта, а дефолтная вкладка — Эхо. Грузим экран Карты отдельным чанком по требованию.
const MapScreen = lazy(() => import('./screens/Map.js').then((m) => ({ default: m.MapScreen })));

export function App() {
  const [tab, setTab] = useState<Tab>('echo');
  const [item, setItem] = useState<ItemDTO | null>(null);

  const openItem = (it: ItemDTO) => setItem(it);

  return (
    <div className="app-shell">
      {tab === 'echo' && <EchoScreen onOpenItem={openItem} />}
      {tab === 'soon' && <SoonScreen onOpenItem={openItem} />}
      {tab === 'search' && <SearchScreen onOpenItem={openItem} />}
      {tab === 'map' && (
        <Suspense
          fallback={
            <div className="map-screen">
              <div className="map-wrap" style={{ display: 'grid', placeItems: 'center' }}>
                <BeamLoader label="загружаю карту…" />
              </div>
            </div>
          }
        >
          <MapScreen onOpenItem={openItem} />
        </Suspense>
      )}

      <TabBar active={tab} onChange={setTab} />

      {item && <ItemSheet item={item} onClose={() => setItem(null)} />}
    </div>
  );
}
