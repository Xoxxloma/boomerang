import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { api } from '../lib/api.js';
import type { MapResponse, MapNode } from '../lib/types.js';
import { BeamLoader, EmptyState } from '../components/States.js';
import { hapticTap } from '../lib/telegram.js';

/** Палитра канваса (космос всегда тёмный) — hex-эквиваленты токенов: canvas oklch ненадёжен в части webview. */
const C = {
  fill: '#2b2c3d', // --space-2
  ring: '#56c9d1', // --star
  ringDim: 'rgba(86,201,209,', // --star с альфой
  label: '#eef0f8', // --starlight
  labelMuted: '#a6a9bd', // --starlight-muted
  beam: '#eaa23e', // --beam
};

type SimNode = MapNode & { x?: number; y?: number };
// force-graph мутирует source/target из id-строк в объекты-узлы после старта симуляции — допускаем оба.
type SimLink = { source?: SimNode | string; target?: SimNode | string; weight?: number; bridges?: number };

function nodeRadius(size: number): number {
  return Math.min(26, 5 + Math.sqrt(size) * 1.7);
}

export function MapScreen({
  onOpenCluster,
  onOpenBridge,
}: {
  onOpenCluster: (id: string, name: string) => void;
  onOpenBridge: (a: string, b: string) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  // Ref на инстанс графа — для подгонки камеры и настройки сил (расталкивание/длина связей).
  type ForceCfg = { strength?: (n: number) => void; distance?: (n: number) => void } | undefined;
  const fgRef = useRef<{
    zoomToFit: (ms?: number, pad?: number) => void;
    d3Force: (name: string) => ForceCfg;
    d3ReheatSimulation: () => void;
  } | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [data, setData] = useState<MapResponse | null>(null);
  const [status, setStatus] = useState<'loading' | 'done' | 'error'>('loading');
  const hoverRef = useRef<string | null>(null);
  // Подгоняем камеру только при ПЕРВОЙ раскладке. Перетаскивание ноды реёгревает симуляцию → engineStop
  // срабатывает снова; без этого флага зум сбрасывался бы к fit на каждый драг (раздражает).
  const didFitRef = useRef(false);

  useEffect(() => {
    let alive = true;
    api
      .map()
      .then((r) => alive && (setData(r), setStatus('done')))
      .catch(() => alive && setStatus('error'));
    return () => {
      alive = false;
    };
  }, []);

  // Измеряем контейнер ТОЛЬКО когда отрисована успешная ветка (ref привязан к нужному .map-wrap, а не к
  // загрузочному) — иначе на маунте el === null, observer не ставится и граф не получает размеров.
  useEffect(() => {
    if (status !== 'done') return;
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [status]);

  // Раздвигаем созвездие: дефолтное отталкивание d3 (-30) сбивает узлы в кучу и подписи наезжают.
  // Сильнее отталкивание + бóльшая длина связей → читаемая карта. Ставим после монтирования графа.
  useEffect(() => {
    if (size.w === 0) return;
    const fg = fgRef.current;
    if (!fg) return;
    fg.d3Force('charge')?.strength?.(-240);
    fg.d3Force('link')?.distance?.(70);
    // Свежая раскладка (первый рендер / ресайз) — разрешаем единственную подгонку камеры по её итогу.
    didFitRef.current = false;
    fg.d3ReheatSimulation();
  }, [size.w, data]);

  // force-graph мутирует объекты (x/y) — копируем, чтобы не трогать состояние React напрямую.
  const graphData = useMemo(
    () => ({
      nodes: (data?.nodes ?? []).map((n) => ({ ...n })) as SimNode[],
      links: (data?.edges ?? []).map((e) => ({ ...e })),
    }),
    [data],
  );

  if (status === 'loading') {
    return (
      <div className="map-screen">
        <div className="map-wrap" style={{ display: 'grid', placeItems: 'center' }}>
          <BeamLoader label="строю созвездие…" />
        </div>
      </div>
    );
  }

  if (status === 'error' || !data || data.nodes.length === 0) {
    return (
      <div className="map-screen">
        <div className="map-wrap" style={{ display: 'grid', placeItems: 'center' }}>
          <EmptyState
            glyph="✦"
            title={status === 'error' ? 'Карта недоступна' : 'Созвездие ещё не сложилось'}
            hint={
              status === 'error'
                ? 'Попробуй открыть позже.'
                : 'Перешли боту больше материала — и темы соберутся в звёзды.'
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div className="map-screen">
      <div className="map-wrap" ref={wrapRef}>
        <div className="map-hud">
          <h1 className="display">Созвездие</h1>
          <span className="meta">{data.nodes.length} тем · тяни и приближай</span>
        </div>
        {size.w > 0 && (
          <ForceGraph2D
            ref={fgRef as never}
            graphData={graphData}
            width={size.w}
            height={size.h}
            backgroundColor="rgba(0,0,0,0)"
            cooldownTicks={120}
            d3VelocityDecay={0.32}
            warmupTicks={20}
            onEngineStop={() => {
              if (didFitRef.current) return; // не сбрасываем зум на реёгрев от перетаскивания
              didFitRef.current = true;
              fgRef.current?.zoomToFit(420, 56);
            }}
            linkColor={(l: SimLink) =>
              `${C.ringDim}${(0.12 + (l.weight ?? 0.4) * 0.35).toFixed(2)})`
            }
            linkWidth={(l: SimLink) => 0.5 + Math.min(2.2, Math.log2(1 + (l.bridges ?? 1)) * 0.8)}
            linkHoverPrecision={8}
            onLinkClick={(l: SimLink) => {
              // После старта симуляции source/target — объекты-узлы; до неё могут быть id-строками.
              const s = typeof l.source === 'object' ? l.source?.id : l.source;
              const t = typeof l.target === 'object' ? l.target?.id : l.target;
              if (s && t) {
                hapticTap();
                onOpenBridge(s, t);
              }
            }}
            onNodeClick={(n: SimNode) => {
              hapticTap();
              onOpenCluster(n.id, n.name);
            }}
            onNodeHover={(n: SimNode | null) => {
              hoverRef.current = n?.id ?? null;
            }}
            nodePointerAreaPaint={(node: SimNode, color: string, ctx: CanvasRenderingContext2D) => {
              const r = nodeRadius(node.size);
              ctx.fillStyle = color;
              ctx.beginPath();
              ctx.arc(node.x ?? 0, node.y ?? 0, r + 4, 0, 2 * Math.PI);
              ctx.fill();
            }}
            nodeCanvasObject={(node: SimNode, ctx: CanvasRenderingContext2D, scale: number) => {
              const x = node.x ?? 0;
              const y = node.y ?? 0;
              const r = nodeRadius(node.size);
              const hot = hoverRef.current === node.id;

              // Тёплое гало возврата при наведении/фокусе — «луч коснулся узла».
              if (hot) {
                const g = ctx.createRadialGradient(x, y, r, x, y, r * 2.6);
                g.addColorStop(0, 'rgba(234,162,62,0.45)');
                g.addColorStop(1, 'rgba(234,162,62,0)');
                ctx.fillStyle = g;
                ctx.beginPath();
                ctx.arc(x, y, r * 2.6, 0, 2 * Math.PI);
                ctx.fill();
              }

              // Узел-звезда: тёмное ядро + холодное кольцо.
              ctx.beginPath();
              ctx.arc(x, y, r, 0, 2 * Math.PI);
              ctx.fillStyle = C.fill;
              ctx.fill();
              ctx.lineWidth = (hot ? 2.4 : 1.5) / scale;
              ctx.strokeStyle = hot ? C.beam : C.ring;
              ctx.stroke();

              // Подпись темы под узлом.
              const fontSize = Math.max(3.5, 11 / scale);
              ctx.font = `500 ${fontSize}px 'Golos Text', system-ui, sans-serif`;
              ctx.textAlign = 'center';
              ctx.textBaseline = 'top';
              ctx.fillStyle = hot ? C.label : C.labelMuted;
              ctx.fillText(node.name, x, y + r + 3 / scale);
            }}
          />
        )}
      </div>
    </div>
  );
}
