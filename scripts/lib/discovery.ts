// Shared SOURCE-DISCOVERY library (no side effects, no argv/exit) used by:
//   - scripts/resolveSources.ts            (Wikidata CLI)
//   - scripts/resolveSourcesMediaCloud.ts  (Media Cloud CLI)
//   - scripts/discoverFeeds.ts             (RSS autodiscovery CLI)
//   - scripts/buildPlaceSources.ts         (the end-to-end automated pipeline)
//
// Every function is keyless-or-keyed but ALWAYS emits `lean: null` — Counterpoint
// assigns political lean per ITEM in the analysis pass, not at the source level.

import { XMLParser } from "fast-xml-parser";

const UA_RESEARCH = "CounterpointResearch/0.1 (source discovery; contact: dev@example.com)";
const UA_DISCOVERY = "CounterpointFeedDiscovery/0.1 (+https://example.com; contact: dev@example.com)";

/** A raw outlet candidate from a dataset — a homepage, not yet a working feed. */
export interface Candidate {
  title: string;
  homepage: string | null;
  region?: string | null;
}

/** A Source-shaped result after RSS autodiscovery (matches src/types.ts Source). */
export interface DiscoveredSource {
  title: string;
  url: string | null; // the validated FEED url (null when none found)
  homepage: string;
  region: string | null;
  lang: string;
  lean: null;
  confidence: number;
  leanRationale: string;
  ok: boolean;
}

// ---------------------------------------------------------------------------
// Wikidata (keyless SPARQL)
// ---------------------------------------------------------------------------

const WDQS = "https://query.wikidata.org/sparql";

/**
 * SPARQL for news OUTLETS tied to a country — tuned for the WDQS time budget:
 * direct `wdt:P31` against an explicit type list (no costly `P279*` walk),
 * country via `P17` OR `P495`, and the label bound EXPLICITLY inside the service
 * (the auto-label magic is disabled by DISTINCT and unreliable otherwise).
 */
function wikidataQuery(qid: string, lang: string): string {
  return `
    SELECT ?outlet ?outletLabel ?website WHERE {
      VALUES ?type {
        wd:Q11032 wd:Q1110794 wd:Q1153191 wd:Q192283 wd:Q1616075 wd:Q14350
      }
      ?outlet wdt:P31 ?type .
      { ?outlet wdt:P17 wd:${qid} . } UNION { ?outlet wdt:P495 wd:${qid} . }
      OPTIONAL { ?outlet wdt:P856 ?website. }
      SERVICE wikibase:label {
        bd:serviceParam wikibase:language "${lang},en".
        ?outlet rdfs:label ?outletLabel.
      }
    }
    LIMIT 1000`;
}

interface WdBinding {
  outletLabel?: { value: string };
  website?: { value: string };
}

/** WDQS 5xx (esp. 504) are frequently transient — retry with backoff. */
async function fetchWdqs(url: string, attempts = 3): Promise<Response> {
  for (let i = 1; i <= attempts; i++) {
    const res = await fetch(url, {
      headers: { "User-Agent": UA_RESEARCH, Accept: "application/sparql-results+json" },
    });
    if (res.ok) return res;
    if (res.status >= 500 && i < attempts) {
      const waitMs = 2000 * i;
      console.error(`WDQS ${res.status} ${res.statusText} — retry ${i}/${attempts - 1} in ${waitMs}ms…`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    throw new Error(`WDQS ${res.status} ${res.statusText}`);
  }
  throw new Error("WDQS: exhausted retries");
}

/** Discover outlet candidates for a country QID (e.g. Q29 = Spain). */
export async function resolveWikidataOutlets(qid: string, lang: string): Promise<Candidate[]> {
  const url = `${WDQS}?query=${encodeURIComponent(wikidataQuery(qid, lang))}&format=json`;
  const res = await fetchWdqs(url);
  const json = (await res.json()) as { results: { bindings: WdBinding[] } };
  const bindings = json.results.bindings;

  let skippedUnlabeled = 0;
  const byTitle = new Map<string, Candidate>();
  for (const b of bindings) {
    const title = b.outletLabel?.value?.trim();
    if (!title || /^Q\d+$/.test(title)) {
      skippedUnlabeled++;
      continue;
    }
    if (!byTitle.has(title)) {
      byTitle.set(title, { title, homepage: b.website?.value ?? null, region: null });
    }
  }
  console.error(
    `Wikidata returned ${bindings.length} row(s); ${skippedUnlabeled} skipped (unlabeled); ` +
    `${byTitle.size} unique outlet(s).`,
  );
  if (byTitle.size === 0 && bindings.length > 0) {
    console.error("First raw binding:", JSON.stringify(bindings[0], null, 2));
  }
  return [...byTitle.values()];
}

// ---------------------------------------------------------------------------
// Media Cloud (keyed Directory API)
// ---------------------------------------------------------------------------

interface MCSource { id?: number; name?: string; label?: string; homepage?: string; url?: string }
interface MCPage { count?: number; next?: string | null; results?: MCSource[] }

/** A Media Cloud collection (a curated set of sources, e.g. "Spain - National"). */
export interface MCCollection {
  id: number;
  name: string;
  description: string | null;
}
interface MCCollPage { next?: string | null; results?: Array<Record<string, unknown>> }

/**
 * Search Media Cloud's Directory for COLLECTIONS matching a query (e.g. a country
 * name). Returns id + name + description so a caller (or the model) can pick the
 * geographic news collections worth ingesting. Needs an API key.
 */
export async function searchMediaCloudCollections(
  query: string,
  key: string,
  base = "https://search.mediacloud.org/api",
): Promise<MCCollection[]> {
  if (!key) throw new Error("Media Cloud: missing API key (MEDIACLOUD_API_KEY).");
  const headers = { Authorization: `Token ${key}`, "User-Agent": UA_RESEARCH, Accept: "application/json" };
  const out = new Map<number, MCCollection>();
  let url: string | null = `${base}/sources/collections/?name=${encodeURIComponent(query)}&limit=100`;
  while (url) {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Media Cloud collections ${res.status} ${res.statusText}`);
    const page = (await res.json()) as MCCollPage;
    for (const c of page.results ?? []) {
      const id = Number(c["id"]);
      const name = String(c["name"] ?? c["label"] ?? "").trim();
      if (!Number.isFinite(id) || !name) continue;
      const description = (c["notes"] ?? c["description"]) as string | null | undefined;
      if (!out.has(id)) out.set(id, { id, name, description: description ?? null });
    }
    url = (page.next as string | null) ?? null;
  }
  console.error(`Media Cloud: ${out.size} collection(s) match "${query}".`);
  return [...out.values()];
}

export interface MediaCloudOpts {
  collection: string;
  limit?: number;
  key: string;
  base?: string;
}

/** Discover outlet candidates from a Media Cloud collection (needs an API key). */
export async function resolveMediaCloudOutlets(opts: MediaCloudOpts): Promise<Candidate[]> {
  const key = opts.key;
  const base = opts.base || "https://search.mediacloud.org/api";
  const limit = opts.limit ?? 500;
  if (!key) throw new Error("Media Cloud: missing API key (MEDIACLOUD_API_KEY).");
  if (!opts.collection) throw new Error("Media Cloud: missing collection id.");

  const fetchPage = async (url: string): Promise<MCPage> => {
    const res = await fetch(url, {
      headers: { Authorization: `Token ${key}`, "User-Agent": UA_RESEARCH, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Media Cloud ${res.status} ${res.statusText} for ${url}`);
    return (await res.json()) as MCPage;
  };

  const out = new Map<string, Candidate>();
  let url: string | null =
    `${base}/sources/sources/?collection_id=${encodeURIComponent(opts.collection)}&limit=100`;
  while (url && out.size < limit) {
    const page: MCPage = await fetchPage(url);
    for (const s of page.results ?? []) {
      const title = (s.name || s.label || "").trim();
      if (!title) continue;
      if (!out.has(title)) out.set(title, { title, homepage: s.homepage || s.url || null, region: null });
    }
    url = page.next ?? null;
  }
  console.error(`Media Cloud returned ${out.size} unique outlet(s).`);
  return [...out.values()].slice(0, limit);
}

// ---------------------------------------------------------------------------
// RSS / Atom autodiscovery
// ---------------------------------------------------------------------------

const COMMON_PATHS = [
  "/feed", "/feed/", "/rss", "/rss.xml", "/feed.xml", "/index.xml",
  "/atom.xml", "/rss/news", "/feeds/posts/default", "/?feed=rss2",
];

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

export function withScheme(u: string): string {
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
}

async function fetchText(url: string, timeoutMs: number, ua: string): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": ua, Accept: "text/html,application/xhtml+xml,application/xml,*/*" },
      signal: ctrl.signal,
      redirect: "follow",
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Declared feed URLs from <link rel="alternate" type="...rss|atom..."> tags. */
function feedsFromHtml(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/rel\s*=\s*["']?alternate/i.test(tag)) continue;
    if (!/type\s*=\s*["']application\/(rss|atom)\+xml/i.test(tag)) continue;
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (href) {
      try { out.push(new URL(href, baseUrl).toString()); } catch { /* skip bad href */ }
    }
  }
  return out;
}

/** A feed is valid if it parses and exposes ≥1 item/entry. Returns item count. */
async function validateFeed(url: string, timeoutMs: number): Promise<number> {
  const xml = await fetchText(url, timeoutMs, UA_DISCOVERY);
  if (!xml || !/<(rss|feed|rdf:RDF)\b/i.test(xml)) return 0;
  let doc: unknown;
  try { doc = xmlParser.parse(xml); } catch { return 0; }
  const d = doc as Record<string, any>;
  const rssItems = d?.rss?.channel?.item ?? d?.["rdf:RDF"]?.item;
  const atomEntries = d?.feed?.entry;
  const count = (v: unknown) => (Array.isArray(v) ? v.length : v ? 1 : 0);
  return count(rssItems) + count(atomEntries);
}

/** First validating feed for one homepage (declared <link> beats path guesses). */
async function discoverOne(homepage: string, timeoutMs: number): Promise<string | null> {
  const base = withScheme(homepage);
  const html = await fetchText(base, timeoutMs, UA_DISCOVERY);
  const declared = html ? feedsFromHtml(html, base) : [];
  let origin = base;
  try { origin = new URL(base).origin; } catch { /* keep base */ }
  const guesses = COMMON_PATHS.map((p) => origin + p);
  for (const f of [...new Set([...declared, ...guesses])]) {
    if ((await validateFeed(f, timeoutMs)) > 0) return f;
  }
  return null;
}

/** Bounded-concurrency map. */
async function pmap<T, R>(items: T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export interface DiscoverOpts {
  lang: string;
  concurrency?: number;
  timeoutMs?: number;
}

/** Autodiscover + validate a feed for each candidate homepage. */
export async function discoverFeeds(candidates: Candidate[], opts: DiscoverOpts): Promise<DiscoveredSource[]> {
  const concurrency = Math.max(1, opts.concurrency ?? 6);
  const timeoutMs = Math.max(1000, opts.timeoutMs ?? 10000);
  const withHomepage = candidates.filter((c) => c.homepage);
  console.error(`Discovering feeds for ${withHomepage.length} candidate(s) with a homepage…`);

  let done = 0;
  const results = await pmap(withHomepage, concurrency, async (c) => {
    const homepage = withScheme(c.homepage as string);
    const feed = await discoverOne(homepage, timeoutMs);
    done++;
    if (done % 10 === 0) console.error(`  …${done}/${withHomepage.length}`);
    const src: DiscoveredSource = {
      title: c.title,
      url: feed,
      homepage,
      region: c.region ?? null,
      lang: opts.lang,
      lean: null,
      confidence: 0.5,
      leanRationale: "Discovered via dataset; lean assigned per item by analysis (not source-level).",
      ok: !!feed,
    };
    return src;
  });

  const ok = results.filter((r) => r.ok);
  console.error(`Done: ${ok.length}/${results.length} have a working feed.`);
  return results;
}
