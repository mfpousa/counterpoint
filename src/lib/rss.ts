// Fetch + parse RSS/Atom/YouTube-media feeds into normalized FeedItems.
// Key-less and free: native fetch (no CORS limit on native) + fast-xml-parser.

import { XMLParser } from "fast-xml-parser";
import type { FeedItem, Source } from "../types";
import { estimateMinutes } from "./duration";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // Keep CDATA / html-ish content as text.
  textNodeName: "#text",
  trimValues: true,
});

// On Expo *web* only, direct RSS fetches hit CORS; route through a proxy.
// Free proxies are individually flaky (downtime, rate limits, aborts), so we
// try several in order and use the first that returns a usable response.
const WEB_CORS_PROXIES: ((url: string) => string)[] = [
  (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url) => `https://thingproxy.freeboard.io/fetch/${url}`,
];

function isWeb(): boolean {
  // react-native-web sets navigator.product to "ReactNative" only on native.
  return typeof document !== "undefined";
}

/** Candidate URLs to try for a source: proxied (web) or direct (native). */
function feedUrls(url: string): string[] {
  return isWeb() ? WEB_CORS_PROXIES.map((p) => p(url)) : [url];
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function text(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if ("#text" in obj) return text(obj["#text"]);
  }
  return "";
}

/** Strip HTML tags + collapse whitespace for summaries. */
function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDate(s: string): number {
  const t = Date.parse(s);
  // Floor unparseable/missing dates to epoch 0 instead of "now". Faking
  // freshness pushes undated items to the top of the recency sort and lets
  // them monopolize the feed; buildFeed's recency window drops epoch-0 items.
  return Number.isNaN(t) ? 0 : t;
}

function hashId(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36);
}

interface RawEntry {
  title: string;
  link: string;
  summary: string;
  published: number;
  durationRaw?: string | number | null;
  thumbnail?: string;
}

function extractRss(channelItems: Record<string, unknown>[]): RawEntry[] {
  return channelItems.map((it) => {
    const enclosure = it["enclosure"] as Record<string, unknown> | undefined;
    const media = it["media:content"] as Record<string, unknown> | undefined;
    const thumb = it["media:thumbnail"] as Record<string, unknown> | undefined;
    return {
      title: stripHtml(text(it["title"])),
      link: text(it["link"]) || (enclosure?.["@_url"] as string) || "",
      summary: stripHtml(text(it["description"]) || text(it["content:encoded"])),
      published: parseDate(text(it["pubDate"]) || text(it["dc:date"])),
      durationRaw:
        text(it["itunes:duration"]) ||
        (media?.["@_duration"] as string) ||
        (enclosure?.["@_length"] ? null : null),
      thumbnail:
        (thumb?.["@_url"] as string) ||
        (media?.["@_url"] as string) ||
        undefined,
    };
  });
}

function extractAtom(entries: Record<string, unknown>[]): RawEntry[] {
  return entries.map((e) => {
    const links = asArray(e["link"]) as Record<string, unknown>[];
    const alt =
      links.find((l) => l["@_rel"] === "alternate") ?? links[0];
    const mediaGroup = e["media:group"] as Record<string, unknown> | undefined;
    const mediaThumb = mediaGroup?.["media:thumbnail"] as Record<string, unknown> | undefined;
    const mediaDesc = mediaGroup?.["media:description"];
    return {
      title: stripHtml(text(e["title"])),
      link: (alt?.["@_href"] as string) || text(e["id"]),
      summary: stripHtml(text(mediaDesc) || text(e["summary"]) || text(e["content"])),
      published: parseDate(text(e["published"]) || text(e["updated"])),
      durationRaw: null,
      thumbnail: (mediaThumb?.["@_url"] as string) || undefined,
    };
  });
}

/** Parse a feed XML string into raw entries (handles RSS 2.0 + Atom). */
export function parseFeedXml(xml: string): RawEntry[] {
  const doc = parser.parse(xml) as Record<string, unknown>;
  const rss = doc["rss"] as Record<string, unknown> | undefined;
  if (rss) {
    const channel = rss["channel"] as Record<string, unknown> | undefined;
    if (channel) return extractRss(asArray(channel["item"]) as Record<string, unknown>[]);
  }
  const feed = doc["feed"] as Record<string, unknown> | undefined;
  if (feed) return extractAtom(asArray(feed["entry"]) as Record<string, unknown>[]);
  return [];
}

/** Normalize raw entries from one source into FeedItems (inheriting source lean). */
export function normalize(source: Source, raw: RawEntry[]): FeedItem[] {
  return raw
    .filter((r) => r.title && r.link)
    .map((r) => ({
      id: `${source.id}:${hashId(r.link)}`,
      sourceId: source.id,
      sourceTitle: source.title,
      title: r.title,
      summary: r.summary,
      url: r.link,
      thumbnail: r.thumbnail,
      publishedAt: r.published,
      kind: source.kind,
      topic: source.topic,
      lean: source.lean,
      confidence: source.confidence,
      leanSource: "source" as const,
      estMinutes: estimateMinutes({
        kind: source.kind,
        durationRaw: r.durationRaw,
        summary: r.summary,
      }),
    }));
}

/** Fetch raw XML for one URL with a timeout. Returns null on failure. */
async function fetchXml(url: string, timeoutMs: number): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml",
        // Many feed hosts 403 requests without a UA (e.g. when fetched
        // server-side from Node). Identify as a normal feed reader.
        "User-Agent":
          "Mozilla/5.0 (compatible; CounterpointReader/1.0; +https://github.com/counterpoint)",
      },
    });
    if (!res.ok) return null;
    const xml = await res.text();
    return xml.trim() ? xml : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch + parse a single source. Returns [] on failure (never throws).
 * On web, tries each CORS proxy in turn until one yields parseable items.
 */
export async function fetchSource(source: Source, timeoutMs = 12000): Promise<FeedItem[]> {
  for (const url of feedUrls(source.url)) {
    const xml = await fetchXml(url, timeoutMs);
    if (!xml) continue;
    const items = normalize(source, parseFeedXml(xml));
    if (items.length > 0) return items;
  }
  return [];
}

/**
 * Max simultaneous source fetches. Free CORS proxies rate-limit (and silently
 * drop) bursts, so firing every source at once loads only an arbitrary, often
 * lean-skewed subset. A small pool keeps the proxy happy so ALL sources load,
 * which is what keeps the feed politically balanced.
 */
const FETCH_CONCURRENCY = 5;

/** Resolve tasks with a bounded number running at once (preserves order). */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Fetch all sources (concurrency-limited), flatten, and sort most-recent-first. */
export async function fetchAll(sources: Source[]): Promise<FeedItem[]> {
  const batches = await mapWithConcurrency(sources, FETCH_CONCURRENCY, (s) => fetchSource(s));
  const all = batches.flat();
  all.sort((a, b) => b.publishedAt - a.publishedAt);
  return all;
}
