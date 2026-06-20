// Client to the Counterpoint backend (server/).
//
// The backend does the heavy lifting now: it fetches every feed server-side
// (no CORS), enriches each item with a LOCAL LLM (topic / lean / relevance),
// and returns a ranked, diversified pool. The app just renders it and applies
// the personal layer (daily quota + lean counter-weighting) in buildFeed.

import type { AnalysisStatus, Briefing, FeedItem, RewrittenArticle } from "../types";

const DEFAULT_BACKEND_PORT = "8787";

/**
 * Resolve the backend base URL.
 *
 * Resolution order:
 *  1. EXPO_PUBLIC_API_URL — explicit override (inlined at build time). Use this
 *     when the backend lives on a different host/port than the web app.
 *  2. On web, derive from the page's OWN origin so the app works however it's
 *     reached — localhost, a LAN IP, or a DNS domain like tfvr.ddns.net:8081.
 *     The backend is assumed to run on the same host on DEFAULT_BACKEND_PORT
 *     (override the port with EXPO_PUBLIC_API_PORT). This is what makes remote
 *     access work: a visitor's browser must call back to the SERVER's host, not
 *     its own localhost.
 *  3. Native / no-DOM fallback: localhost.
 */
export function apiBaseUrl(): string {
  const env = (process.env.EXPO_PUBLIC_API_URL ?? "").trim();
  if (env.length > 0) return env.replace(/\/+$/, "");

  if (typeof window !== "undefined" && window.location?.hostname) {
    const { protocol, hostname } = window.location;
    const port = (process.env.EXPO_PUBLIC_API_PORT ?? "").trim() || DEFAULT_BACKEND_PORT;
    return `${protocol}//${hostname}:${port}`;
  }

  return `http://localhost:${DEFAULT_BACKEND_PORT}`;
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
export async function fetchRankedFeed(
  opts: { force?: boolean; interest?: string } = {},
): Promise<FeedItem[]> {
  const base = apiBaseUrl();
  const interest = (opts.interest ?? "").trim();
  let res: Response;
  if (opts.force) {
    res = await fetch(`${base}/api/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ interest }),
    });
  } else {
    const qs = interest ? `?interest=${encodeURIComponent(interest)}` : "";
    res = await fetch(`${base}/api/feed${qs}`, { method: "GET" });
  }
  if (!res.ok) {
    throw new Error(`Backend returned ${res.status}. Is the server running (npm run server)?`);
  }
  const data = (await res.json()) as FeedResponse;
  return Array.isArray(data.items) ? data.items : [];
}

/**
 * Ask the backend to fetch + AI-rewrite an item into a clean, readable article
 * for in-app reading. Throws with a clear message on failure so the reader UI
 * can surface it (paywall, model offline, item aged out, ...).
 */
export async function fetchRewrite(id: string): Promise<RewrittenArticle> {
  const res = await fetch(`${apiBaseUrl()}/api/rewrite?id=${encodeURIComponent(id)}`, {
    method: "GET",
  });
  const data = (await res.json().catch(() => null)) as
    | { article?: RewrittenArticle; error?: string }
    | null;
  if (!res.ok || !data?.article) {
    throw new Error(data?.error ?? `Rewrite failed (HTTP ${res.status}).`);
  }
  return data.article;
}

/**
 * Fetch live backend build/analysis progress. Returns null on any failure (the
 * status poll is best-effort and must never disrupt the UI).
 */
export async function fetchStatus(): Promise<AnalysisStatus | null> {
  try {
    const res = await fetch(`${apiBaseUrl()}/api/status`, { method: "GET" });
    if (!res.ok) return null;
    return (await res.json()) as AnalysisStatus;
  } catch {
    return null;
  }
}

/**
 * Fetch the AI briefing (what's happening / where it's headed) for an interest.
 * Returns null if the backend has none (e.g. the local model is offline). Never
 * throws — the briefing is a nice-to-have, not load-bearing.
 */
export async function fetchBriefing(
  opts: { interest?: string; force?: boolean } = {},
): Promise<Briefing | null> {
  const interest = (opts.interest ?? "").trim();
  const params = new URLSearchParams();
  if (interest) params.set("interest", interest);
  if (opts.force) params.set("force", "1");
  const qs = params.toString();
  try {
    const res = await fetch(`${apiBaseUrl()}/api/briefing${qs ? `?${qs}` : ""}`, { method: "GET" });
    if (!res.ok) return null;
    const data = (await res.json()) as { briefing?: Briefing | null };
    return data.briefing ?? null;
  } catch {
    return null;
  }
}
