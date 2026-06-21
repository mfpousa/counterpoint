// Client to the Counterpoint backend (server/).
//
// The backend does the heavy lifting now: it fetches every feed server-side
// (no CORS), enriches each item with a LOCAL LLM (topic / lean / relevance),
// and returns a ranked, diversified pool. The app just renders it and applies
// the personal layer (daily quota + lean counter-weighting) in buildFeed.

import type {
  AnalysisStatus,
  Briefing,
  FeedItem,
  KnowledgeInsight,
  KnowledgeProfile,
  Lang,
  RewrittenArticle,
  Story,
  SummaryGrade,
} from "../types";

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
  /** The world this feed was assembled for. */
  world?: string;
  /** If a DIFFERENT world is currently refreshing, its id; else null. */
  busyWith?: string | null;
}

/**
 * Fetch the AI-ranked feed from the backend. When `force` is true we POST
 * /api/refresh to rebuild from scratch; otherwise GET /api/feed (TTL-cached).
 * Throws on network/HTTP failure so the caller can surface a clear message.
 */
export async function fetchRankedFeed(
  opts: { force?: boolean; interest?: string; world?: string } = {},
): Promise<FeedResponse> {
  const base = apiBaseUrl();
  const interest = (opts.interest ?? "").trim();
  const world = (opts.world ?? "").trim();
  let res: Response;
  if (opts.force) {
    res = await fetch(`${base}/api/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ interest, world }),
    });
  } else {
    const params = new URLSearchParams();
    if (interest) params.set("interest", interest);
    if (world) params.set("world", world);
    const qs = params.toString();
    res = await fetch(`${base}/api/feed${qs ? `?${qs}` : ""}`, { method: "GET" });
  }
  if (!res.ok) {
    throw new Error(`Backend returned ${res.status}. Is the server running (npm run server)?`);
  }
  const data = (await res.json()) as FeedResponse;
  return {
    items: Array.isArray(data.items) ? data.items : [],
    builtAt: data.builtAt,
    fetched: data.fetched,
    enriched: data.enriched,
    busyWith: data.busyWith ?? null,
    world: data.world,
  };
}

/**
 * Ask the backend to fetch + AI-rewrite an item into a clean, readable article
 * for in-app reading. Throws with a clear message on failure so the reader UI
 * can surface it (paywall, model offline, item aged out, ...).
 */
export async function fetchRewrite(id: string, lang?: Lang): Promise<RewrittenArticle> {
  const params = new URLSearchParams({ id });
  if (lang) params.set("lang", lang);
  const res = await fetch(`${apiBaseUrl()}/api/rewrite?${params.toString()}`, {
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

export interface RewriteStreamHandlers {
  /** A chunk of generated text (append to what's shown). */
  onDelta: (delta: string) => void;
  /** A chunk of REASONING text (the model is "thinking" before it writes). */
  onReasoning?: (delta: string) => void;
  /** The final, cleaned article (replaces the streamed text). */
  onDone: (article: RewrittenArticle) => void;
  /** A failure (or that streaming is unsupported here) — caller may fall back. */
  onError: (message: string) => void;
  world?: string;
  /** UI/AI language — the rewrite is written in this. */
  lang?: Lang;
}

/**
 * Stream the AI rewrite over Server-Sent Events so the reader can show the model
 * writing in real time. Returns a handle with `cancel()` (abort on unmount), or
 * `null` when streaming isn't supported in this runtime (caller should fall back
 * to the non-streaming fetchRewrite + a typewriter reveal).
 */
export function streamRewrite(id: string, h: RewriteStreamHandlers): { cancel: () => void } | null {
  // Needs fetch + a readable response body (Expo web / modern runtimes).
  if (typeof fetch === "undefined" || typeof ReadableStream === "undefined") return null;

  const params = new URLSearchParams({ id });
  if (h.world) params.set("world", h.world);
  if (h.lang) params.set("lang", h.lang);
  const controller = new AbortController();

  const dispatch = (frame: string) => {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) return;
    let payload: unknown;
    try {
      payload = JSON.parse(dataLines.join("\n"));
    } catch {
      return;
    }
    if (event === "delta" && typeof payload === "string") h.onDelta(payload);
    else if (event === "reasoning" && typeof payload === "string") h.onReasoning?.(payload);
    else if (event === "done") h.onDone(payload as RewrittenArticle);
    else if (event === "error") h.onError(typeof payload === "string" ? payload : "rewrite failed");
  };

  (async () => {
    try {
      const res = await fetch(`${apiBaseUrl()}/api/rewrite/stream?${params.toString()}`, {
        method: "GET",
        headers: { Accept: "text/event-stream" },
        signal: controller.signal,
      });
      const reader = res.body?.getReader?.();
      if (!res.ok || !reader) {
        h.onError("stream unavailable");
        return;
      }
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          dispatch(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 2);
        }
      }
      if (buffer.trim()) dispatch(buffer);
    } catch (e) {
      if (!controller.signal.aborted) {
        h.onError(e instanceof Error ? e.message : "stream failed");
      }
    }
  })();

  return { cancel: () => controller.abort() };
}

export interface BriefingStreamHandlers {
  /** A chunk of generated text (append to the live preview). */
  onDelta: (delta: string) => void;
  /** The final parsed briefing (or null if none). */
  onDone: (briefing: Briefing | null) => void;
  /** A failure (or that streaming is unsupported here) — caller may fall back. */
  onError: (message: string) => void;
  interest?: string;
  world?: string;
  lang?: Lang;
}

/**
 * Stream the AI briefing over SSE so the card can show the model writing it live.
 * Returns a handle with `cancel()`, or `null` when streaming isn't supported here
 * (caller should fall back to the non-streaming fetchBriefing).
 */
export function streamBriefing(h: BriefingStreamHandlers): { cancel: () => void } | null {
  if (typeof fetch === "undefined" || typeof ReadableStream === "undefined") return null;

  const params = new URLSearchParams();
  if (h.interest) params.set("interest", h.interest);
  if (h.world) params.set("world", h.world);
  if (h.lang) params.set("lang", h.lang);
  const controller = new AbortController();

  const dispatch = (frame: string) => {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) return;
    let payload: unknown;
    try {
      payload = JSON.parse(dataLines.join("\n"));
    } catch {
      return;
    }
    if (event === "delta" && typeof payload === "string") h.onDelta(payload);
    else if (event === "done") h.onDone((payload as Briefing | null) ?? null);
    else if (event === "error") h.onError(typeof payload === "string" ? payload : "briefing failed");
  };

  (async () => {
    try {
      const qs = params.toString();
      const res = await fetch(`${apiBaseUrl()}/api/briefing/stream${qs ? `?${qs}` : ""}`, {
        method: "GET",
        headers: { Accept: "text/event-stream" },
        signal: controller.signal,
      });
      const reader = res.body?.getReader?.();
      if (!res.ok || !reader) {
        h.onError("stream unavailable");
        return;
      }
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          dispatch(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 2);
        }
      }
      if (buffer.trim()) dispatch(buffer);
    } catch (e) {
      if (!controller.signal.aborted) {
        h.onError(e instanceof Error ? e.message : "stream failed");
      }
    }
  })();

  return { cancel: () => controller.abort() };
}

/**
 * Grade the reader's recall summary of an item against the article. Throws with
 * a clear message on failure so the summary UI can surface it (model offline,
 * item aged out, summary too short, ...).
 */
export async function gradeSummary(
  id: string,
  summary: string,
  world?: string,
  lang?: Lang,
): Promise<SummaryGrade> {
  const res = await fetch(`${apiBaseUrl()}/api/grade`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, summary, world, lang }),
  });
  const data = (await res.json().catch(() => null)) as
    | { grade?: SummaryGrade; error?: string }
    | null;
  if (!res.ok || !data?.grade) {
    throw new Error(data?.error ?? `Grading failed (HTTP ${res.status}).`);
  }
  return data.grade;
}

/**
 * Ask the backend for an AI narrative + gap-filling suggestion reasons, layered
 * on the locally-computed knowledge profile. Returns null on any failure (the
 * Learn tab still renders the local stats without it). Never throws.
 */
export async function fetchKnowledgeInsight(
  profile: KnowledgeProfile,
  candidates: { id: string; title: string; topic: string; summary: string }[],
): Promise<KnowledgeInsight | null> {
  try {
    const res = await fetch(`${apiBaseUrl()}/api/knowledge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile, candidates }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { insight?: KnowledgeInsight | null };
    return data.insight ?? null;
  } catch {
    return null;
  }
}

export interface StoriesResponse {
  stories: Story[];
  busyWith?: string | null;
}

/**
 * Fetch the synthesized cross-source stories for a world. The first call after a
 * pool rebuild triggers the (slow) synthesis on the backend; subsequent calls are
 * cached. Returns an empty list on failure (the Stories tab shows its own empty
 * state) — never throws.
 */
export async function fetchStories(
  opts: { world?: string; force?: boolean; lang?: Lang } = {},
): Promise<StoriesResponse> {
  const world = (opts.world ?? "").trim();
  const params = new URLSearchParams();
  if (world) params.set("world", world);
  if (opts.lang) params.set("lang", opts.lang);
  if (opts.force) params.set("force", "1");
  const qs = params.toString();
  try {
    const res = await fetch(`${apiBaseUrl()}/api/stories${qs ? `?${qs}` : ""}`, { method: "GET" });
    if (!res.ok) return { stories: [], busyWith: null };
    const data = (await res.json()) as StoriesResponse;
    return { stories: Array.isArray(data.stories) ? data.stories : [], busyWith: data.busyWith ?? null };
  } catch {
    return { stories: [], busyWith: null };
  }
}

/**
 * Fetch "related news" for an item (semantic nearest-neighbors). Returns an empty
 * list on any failure — the related section is supplementary and never blocks the
 * reader. Never throws.
 */
export async function fetchRelated(
  id: string,
  opts: { world?: string; limit?: number } = {},
): Promise<FeedItem[]> {
  const params = new URLSearchParams({ id });
  if (opts.world) params.set("world", opts.world);
  if (opts.limit) params.set("limit", String(opts.limit));
  try {
    const res = await fetch(`${apiBaseUrl()}/api/related?${params.toString()}`, { method: "GET" });
    if (!res.ok) return [];
    const data = (await res.json()) as { items?: FeedItem[] };
    return Array.isArray(data.items) ? data.items : [];
  } catch {
    return [];
  }
}

/**
 * Fetch a single synthesized story by id. Throws with a clear message on failure
 * (aged out / model offline) so the detail view can surface it.
 */
export async function fetchStory(id: string, world?: string, lang?: Lang): Promise<Story> {
  const params = new URLSearchParams({ id });
  if (world) params.set("world", world);
  if (lang) params.set("lang", lang);
  const res = await fetch(`${apiBaseUrl()}/api/story?${params.toString()}`, { method: "GET" });
  const data = (await res.json().catch(() => null)) as { story?: Story; error?: string } | null;
  if (!res.ok || !data?.story) {
    throw new Error(data?.error ?? `Story fetch failed (HTTP ${res.status}).`);
  }
  return data.story;
}

/**
 * Fetch live backend build/analysis progress. Returns null on any failure (the
 * status poll is best-effort and must never disrupt the UI).
 */
export async function fetchStatus(world?: string): Promise<AnalysisStatus | null> {
  try {
    const qs = world ? `?world=${encodeURIComponent(world)}` : "";
    const res = await fetch(`${apiBaseUrl()}/api/status${qs}`, { method: "GET" });
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
  opts: { interest?: string; force?: boolean; world?: string; lang?: Lang } = {},
): Promise<Briefing | null> {
  const interest = (opts.interest ?? "").trim();
  const world = (opts.world ?? "").trim();
  const params = new URLSearchParams();
  if (interest) params.set("interest", interest);
  if (world) params.set("world", world);
  if (opts.lang) params.set("lang", opts.lang);
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
