import { getInitData } from './telegram.js';
import type { SearchResponse, MapResponse, EchoResponse, UpcomingResponse, SimilarResponse } from './types.js';

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
  map: () => request<MapResponse>('/map'),
  echo: () => request<EchoResponse>('/echo'),
  /** Семантические соседи записи (item-kNN) — блок «Рядом» в карточке. */
  similar: (id: string) => request<SimilarResponse>(`/items/${id}/similar`),

  // --- Напоминания ---
  upcoming: () => request<UpcomingResponse>('/upcoming'),
  createReminder: (itemId: string, remindAt: string) =>
    request<{ ok: true }>('/reminders', { method: 'POST', body: JSON.stringify({ itemId, remindAt }) }),
  reschedule: (id: string, remindAt: string) =>
    request<{ ok: true }>(`/reminders/${id}/reschedule`, {
      method: 'POST',
      body: JSON.stringify({ remindAt }),
    }),
  cancelReminder: (id: string) => request<{ ok: true }>(`/reminders/${id}/cancel`, { method: 'POST' }),
  remindNow: (id: string) => request<{ ok: true }>(`/reminders/${id}/now`, { method: 'POST' }),
  /** Сообщить серверу таймзону (Intl) — для бот-стороны (пресеты напоминаний). Best-effort. */
  setTz: (tz: string) => request<{ ok: true }>('/settings/tz', { method: 'POST', body: JSON.stringify({ tz }) }),
};
