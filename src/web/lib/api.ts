import { getInitData } from './telegram.js';
import type {
  SearchResponse,
  MapResponse,
  BridgeResponse,
  ClusterItemsResponse,
  EchoResponse,
} from './types.js';

/** Ошибка API с кодом статуса — экраны различают 429 (бюджет) и прочие. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public reason?: string,
    public resetsAt?: string,
  ) {
    super(`api ${status}${reason ? `: ${reason}` : ''}`);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      // Подпись Telegram — сервер по ней удостоверяет личность (без неё 401).
      'X-Telegram-Init-Data': getInitData(),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { reason?: string; resetsAt?: string };
    throw new ApiError(res.status, data.reason, data.resetsAt);
  }
  return res.json() as Promise<T>;
}

export const api = {
  search: (query: string) =>
    request<SearchResponse>('/search', { method: 'POST', body: JSON.stringify({ query }) }),
  synthesize: (clusterId: string) =>
    request<SearchResponse>('/synthesize', {
      method: 'POST',
      body: JSON.stringify({ clusterId }),
    }),
  map: () => request<MapResponse>('/map'),
  bridge: (a: string, b: string) =>
    request<BridgeResponse>(`/map/bridge?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`),
  clusterItems: (id: string) => request<ClusterItemsResponse>(`/clusters/${id}/items`),
  echo: () => request<EchoResponse>('/echo'),
};
