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
  createdAt: string;
}

export type NumberedSource = ItemDTO & { index: number };

export interface SearchResponse {
  mode: 'synthesis' | 'list' | 'empty';
  answer: string | null;
  sources: NumberedSource[];
  cited: number[];
}

/** Узел созвездия — запись целиком (тап → карточка) + степень связности на размер звезды. */
export type MapNode = ItemDTO & { size: number };
export interface MapEdge {
  source: string;
  target: string;
  /** Крепость связи [0..1] — на прозрачность/толщину ребра. */
  weight: number;
}
export interface MapResponse {
  nodes: MapNode[];
  edges: MapEdge[];
}

/** Запись с активным напоминанием — для экрана «Скоро вернётся». */
export interface ReminderDTO extends ItemDTO {
  remindAt: string;
}
export interface UpcomingResponse {
  reminders: ReminderDTO[];
}

export type EchoKind = 'on_this_day' | 'resonance';
export interface EchoCard {
  kind: EchoKind;
  item: ItemDTO | null;
  relatedItem: ItemDTO | null;
}
export interface EchoResponse {
  cards: EchoCard[];
}
