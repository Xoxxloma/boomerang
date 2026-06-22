import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { api } from '../lib/api.js';
import type { MapResponse, MapNode, ItemDTO } from '../lib/types.js';
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
type SimLink = { source?: SimNode | string; target?: SimNode | string; weight?: number };

function nodeRadius(size: number): number {
  return Math.min(26, 6 + Math.sqrt(size) * 1.7);
}

// Тап-таргет: невидимая хит-зона на ТЕНЕВОМ канвасе. Рисуется в координатах графа, потому на
// отдалённом зуме ужимается множителем зума — гарантируем минимум в ЭКРАННЫХ px (делим на зум).
const MIN_TAP_PX = 20; // минимальный «палец» в экранных px
const HIT_PAD = 4; // прежний запас в координатах графа
function hitRadius(size: number, globalScale: number): number {
  return Math.max(nodeRadius(size) + HIT_PAD, MIN_TAP_PX / globalScale);
}

// Подпись: обрезаем длинный name до читаемой строки. По границе слова, если пробел не слишком рано.
const LABEL_MAX = 22;
function clampLabel(name: string, max = LABEL_MAX): string {
  const s = name.trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  const base = sp > max * 0.6 ? cut.slice(0, sp) : cut;
  return base.replace(/[\s.,;:–—-]+$/, '') + '…';
}

// Анти-наложение подписей: per-frame список занятых прямоугольников (сброс в onRenderFramePre).
// Само работает как LOD: пробуем подписать ВСЕ узлы в порядке приоритета (степень убыв.), но рисуем
// лишь те, что не пересекают уже размещённые. Зум-аут → крупные боксы → влезает мало (чисто);
// зум-ин → влезает больше. Топ-приоритет влезает всегда → карта никогда не пустая.
type Box = { x0: number; y0: number; x1: number; y1: number };
const occupied: Box[] = [];
function overlaps(b: Box): boolean {
  for (const o of occupied)
    if (b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0) return true;
  return false;
}

// Скруглённый прямоугольник: ctx.roundRect новый — ручной фолбэк через arcTo для старых WebView.
function pathRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  if (ctx.roundRect) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Нарисовать подпись узла с пилюлей-подложкой; вернуть false, если место занято (метка не нарисована). */
function drawLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  r: number,
  scale: number,
  hot: boolean,
): boolean {
  const fontSize = Math.max(3.5, 11 / scale);
  ctx.font = `500 ${fontSize}px 'Golos Text', system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const w = ctx.measureText(text).width;
  const padX = 4 / scale;
  const padY = 2 / scale;
  const rad = 4 / scale;
  const by = y + r + 3 / scale;
  const box: Box = { x0: x - w / 2 - padX, y0: by, x1: x + w / 2 + padX, y1: by + fontSize + padY * 2 };
  if (!hot && overlaps(box)) return false;
  occupied.push(box);
  ctx.fillStyle = 'rgba(20,21,32,0.66)';
  pathRoundRect(ctx, box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0, rad);
  ctx.fill();
  ctx.fillStyle = hot ? C.label : C.labelMuted;
  ctx.fillText(text, x, by + padY);
  return true;
}

export function MapScreen({ onOpenItem }: { onOpenItem: (it: ItemDTO) => void }) {
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
      // Сортируем по убыванию size: хабы обходятся первыми → первыми занимают слоты подписей.
      // Сортируем копию (свежий {...n}), не трогая data.
      nodes: (data?.nodes ?? []).map((n) => ({ ...n })).sort((a, b) => b.size - a.size) as SimNode[],
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
          <span className="meta">{data.nodes.length} записей · тяни и приближай</span>
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
            maxZoom={8}
            onRenderFramePre={() => {
              occupied.length = 0; // сброс занятых боксов в начале кадра
            }}
            onRenderFramePost={(ctx: CanvasRenderingContext2D, scale: number) => {
              // Подпись наведённого узла рисуем последней — поверх всех, без перекрытия пилюлями соседей.
              const id = hoverRef.current;
              if (!id) return;
              const n = graphData.nodes.find((nd) => nd.id === id);
              if (!n) return;
              drawLabel(ctx, clampLabel(n.name), n.x ?? 0, n.y ?? 0, nodeRadius(n.size), scale, true);
            }}
            onEngineStop={() => {
              if (didFitRef.current) return; // не сбрасываем зум на реёгрев от перетаскивания
              didFitRef.current = true;
              fgRef.current?.zoomToFit(420, 56);
            }}
            linkColor={(l: SimLink) =>
              `${C.ringDim}${(0.12 + (l.weight ?? 0.4) * 0.35).toFixed(2)})`
            }
            linkWidth={(l: SimLink) => 0.5 + Math.min(2.2, (l.weight ?? 0.4) * 2.4)}
            linkHoverPrecision={8}
            onNodeClick={(n: SimNode) => {
              hapticTap();
              onOpenItem(n);
            }}
            onNodeHover={(n: SimNode | null) => {
              hoverRef.current = n?.id ?? null;
            }}
            nodePointerAreaPaint={(
              node: SimNode,
              color: string,
              ctx: CanvasRenderingContext2D,
              globalScale: number,
            ) => {
              // Хит-зона с минимумом в экранных px (см. hitRadius) — мелкие звёзды уверенно тапаются.
              const r = hitRadius(node.size, globalScale);
              ctx.fillStyle = color;
              ctx.beginPath();
              ctx.arc(node.x ?? 0, node.y ?? 0, r, 0, 2 * Math.PI);
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

              // Подпись: наведённый узел рисует onRenderFramePost (поверх всех). Остальным пробуем
              // подписать — drawLabel вернёт false и пропустит, если место под меткой уже занято.
              // Антиналожение + приоритет (узлы отсортированы по степени) работают как LOD.
              if (!hot) {
                drawLabel(ctx, clampLabel(node.name), x, y, r, scale, false);
              }
            }}
          />
        )}
      </div>
    </div>
  );
}
