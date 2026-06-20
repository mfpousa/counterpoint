// Client to the Counterpoint backend (server/).
//
// The backend does the heavy lifting now: it fetches every feed server-side
// (no CORS), enriches each item with a LOCAL LLM (topic / lean / relevance),
// and returns a ranked, diversified pool. The app just renders it and applies
// the personal layer (daily quota + lean counter-weighting) in buildFeed.

import type { FeedItem } from "../types";

const DEFAULT_API_URL = "http://localhost:8787";

/** Resolve the backend base URL (EXPO_PUBLIC_API_URL is inlined at build time). */
export function apiBaseUrl(): string {
  const env = (process.env.EXPO_PUBLIC_API_URL ?? "").trim();
  return env.length > 0 ? env.replace(/\/+$/, "") : DEFAULT_API_URL;
}

export interface FeedResponse {
  items: FeedItem[];
  builtAt: number;
  fetched: number;
  enriched: number;
  durationMs?: number;
}

/**
 * Fetch the AI-ranked feed from the backend. When `force` is true we POST
 * /api/refresh to rebuild from scratch; otherwise GET /api/feed (TTL-cached).
 * Throws on network/HTTP failure so the caller can surface a clear message.
 */
export async function fetchRankedFeed(opts: { force?: boolean } = {}): Promise<FeedItem[]> {
  const base = apiBaseUrl();
  const url = `${base}/api/${opts.force ? "refresh" : "feed"}`;
  const res = await fetch(url, { method: opts.force ? "POST" : "GET" });
  if (!res.ok) {
    throw new Error(`Backend returned ${res.status}. Is the server running (npm run server)?`);
  }
  const data = (await res.json()) as FeedResponse;
  return Array.isArray(data.items) ? data.items : [];
}
