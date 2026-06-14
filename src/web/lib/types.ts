// Формы ответов API (зеркало src/web-api/*). Держим вручную — общих типов между node и web-сборкой нет.

export type ItemType = 'link' | 'tg_post' | 'document' | 'image' | 'video' | 'text' | 'voice';

export interface ItemDTO {
  id: string;
  type: ItemType;
  name: string;
  title: string | null;
  url: string | null;
  sourceChat: string | null;
  text: string | null;
  clusterId: string | null;
  createdAt: string;
}

export type NumberedSource = ItemDTO & { index: number };

export interface SearchResponse {
  mode: 'synthesis' | 'list' | 'empty';
  answer: string | null;
  sources: NumberedSource[];
  cited: number[];
  clusterName?: string;
}

export interface MapNode {
  id: string;
  name: string;
  size: number;
}
export interface MapEdge {
  source: string;
  target: string;
  /** Крепость самой сильной общей нити [0..1] — на прозрачность ребра. */
  weight: number;
  /** Сколько записей перекинуто мостом между темами — на толщину ребра. */
  bridges: number;
}
export interface MapResponse {
  nodes: MapNode[];
  edges: MapEdge[];
}

/** Одна нить-мост: запись из темы A перекликается с записью из темы B (под ребром карты). */
export interface BridgePair {
  itemA: ItemDTO;
  itemB: ItemDTO;
  similarity: number;
}
export interface BridgeResponse {
  clusterA: { id: string; name: string };
  clusterB: { id: string; name: string };
  pairs: BridgePair[];
}

export interface ClusterItemsResponse {
  /** mature — тема набрала достаточно записей, чтобы свод имел смысл (гейт кнопки «Свести»). */
  cluster: { id: string; name: string; size: number; mature: boolean };
  items: ItemDTO[];
}

/** Запись с активным напоминанием — для экрана «Скоро вернётся». */
export interface ReminderDTO extends ItemDTO {
  remindAt: string;
}
export interface UpcomingResponse {
  reminders: ReminderDTO[];
}

export type EchoKind = 'maturity' | 'on_this_day' | 'resonance';
export interface EchoCard {
  kind: EchoKind;
  clusterId: string | null;
  clusterName: string | null;
  count: number | null;
  item: ItemDTO | null;
  relatedItem: ItemDTO | null;
}
export interface EchoResponse {
  cards: EchoCard[];
}
