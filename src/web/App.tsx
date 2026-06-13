import { lazy, Suspense, useState } from 'react';
import type { ItemDTO } from './lib/types.js';
import { TabBar, type Tab } from './components/TabBar.js';
import { SearchScreen } from './screens/Search.js';
import { EchoScreen } from './screens/Echo.js';
import { ItemSheet } from './components/ItemSheet.js';
import { ClusterSheet } from './components/ClusterSheet.js';
import { BridgeSheet } from './components/BridgeSheet.js';
import { SynthSheet } from './components/SynthSheet.js';
import { BeamLoader } from './components/States.js';

// bundle-dynamic-imports: тяжёлый react-force-graph (бóльшая часть бандла) нужен только на вкладке
// Карта, а дефолтная вкладка — Эхо. Грузим экран Карты отдельным чанком по требованию.
const MapScreen = lazy(() => import('./screens/Map.js').then((m) => ({ default: m.MapScreen })));

type ClusterRef = { id: string; name: string };

export function App() {
  const [tab, setTab] = useState<Tab>('echo');
  const [item, setItem] = useState<ItemDTO | null>(null);
  const [cluster, setCluster] = useState<ClusterRef | null>(null);
  const [bridge, setBridge] = useState<{ a: string; b: string } | null>(null);
  const [synth, setSynth] = useState<ClusterRef | null>(null);

  const openItem = (it: ItemDTO) => setItem(it);
  const openCluster = (id: string, name: string) => setCluster({ id, name });
  const openBridge = (a: string, b: string) => setBridge({ a, b });
  // Свод темы поверх созвездия: лист со спутниками уступает место своду.
  const openSynth = (id: string, name: string) => {
    setCluster(null);
    setSynth({ id, name });
  };

  return (
    <div className="app-shell">
      {tab === 'echo' && <EchoScreen onOpenItem={openItem} onSynth={openSynth} />}
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
          <MapScreen onOpenCluster={openCluster} onOpenBridge={openBridge} />
        </Suspense>
      )}

      <TabBar active={tab} onChange={setTab} />

      {/* Листы стопкой: спутники → свод → карточка записи (последняя сверху). */}
      {cluster && (
        <ClusterSheet
          clusterId={cluster.id}
          clusterName={cluster.name}
          onOpenItem={openItem}
          onSynth={openSynth}
          onClose={() => setCluster(null)}
        />
      )}
      {bridge && (
        <BridgeSheet
          clusterA={bridge.a}
          clusterB={bridge.b}
          onOpenItem={openItem}
          onClose={() => setBridge(null)}
        />
      )}
      {synth && (
        <SynthSheet
          clusterId={synth.id}
          clusterName={synth.name}
          onOpenItem={openItem}
          onClose={() => setSynth(null)}
        />
      )}
      {item && <ItemSheet item={item} onClose={() => setItem(null)} />}
    </div>
  );
}
