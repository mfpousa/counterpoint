// AUTOMATED place-source pipeline: resolve outlet candidates (Wikidata + optional
// Media Cloud) -> RSS-autodiscover + validate feeds -> write a generated registry
// at src/data/placeSources/<cc>.json that the server loads on demand when a reader
// sets that country as their place (see server/placeSources.ts + feedService).
//
// This replaces the manual "paste the JSON back to me" loop: one command does the
// whole fold-in. `lean` is ALWAYS null — assigned per item by the analysis pass.
//
// Media Cloud is HANDS-OFF: with a key, the pipeline SEARCHES the collection
// directory for the place and lets the model pick the right geographic news
// collections (national/regional/local), so you never hand-pick ids. You can
// still force specific ids with --mc-collection, or override the search term with
// --mc-query.
//
// RUN (needs network; run outside a proxy that blocks outbound fetches):
//   npm run sources:place -- --country es                       # Wikidata only
//   MEDIACLOUD_API_KEY=xxx npm run sources:place -- --country es   # + AI-picked MC collections
//   MEDIACLOUD_API_KEY=xxx npm run sources:place -- --country es --mc-collection 1234,5678
//
// Flags: (--country <cc> | --continent <name> | --all) [--qid Qnnn] [--lang xx]
//        [--mc-collection ids] [--mc-query text] [--limit N] [--concurrency N]
//        [--timeout ms] [--out path]
//
// Bulk, no hand-maintained country list:
//   npm run sources:place -- --continent Europe        # every European country
//   npm run sources:place -- --all                     # refresh existing registries

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Source } from "../src/types";
import {
  discoverFeeds,
  resolveCountriesInContinent,
  resolveCountry,
  resolveMediaCloudOutlets,
  resolveWikidataOutlets,
  searchMediaCloudCollections,
  withScheme,
  type Candidate,
  type MCCollection,
} from "./lib/discovery";
import { aiReachable, chatJsonArray } from "../server/ai";

interface Args {
  /** Refresh every country that already has a placeSources file. */
  all: boolean;
  /** Build every country on a continent (by name, e.g. "Europe") via Wikidata. */
  continent: string | null;
  country: string;
  qid: string | null;
  lang: string | null;
  /** Explicit collection id(s), comma-separated — bypasses search + AI selection. */
  mcCollection: string | null;
  /** Override the Media Cloud collection SEARCH term (defaults to the country name). */
  mcQuery: string | null;
  limit: number;
  concurrency: number;
  timeoutMs: number;
  out: string | null;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string, fallback: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const has = (flag: string) => argv.indexOf(flag) >= 0;
  return {
    all: has("--all"),
    continent: has("--continent") ? get("--continent", "") || null : null,
    country: get("--country", "").toLowerCase(),
    qid: has("--qid") ? get("--qid", "") || null : null,
    lang: has("--lang") ? get("--lang", "") || null : null,
    mcCollection: has("--mc-collection") ? get("--mc-collection", "") || null : null,
    mcQuery: has("--mc-query") ? get("--mc-query", "") || null : null,
    limit: Math.max(1, parseInt(get("--limit", "1000"), 10) || 1000),
    concurrency: Math.max(1, parseInt(get("--concurrency", "8"), 10) || 8),
    timeoutMs: Math.max(1000, parseInt(get("--timeout", "10000"), 10) || 10000),
    out: has("--out") ? get("--out", "") || null : null,
  };
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // strip accents
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "src";
}

/** Host of a homepage, for dedup across datasets (Wikidata + Media Cloud overlap). */
function host(u: string | null): string | null {
  if (!u) return null;
  try { return new URL(withScheme(u)).host.replace(/^www\./, ""); } catch { return null; }
}

function mergeCandidates(...lists: Candidate[][]): Candidate[] {
  const byHost = new Map<string, Candidate>();
  const noHost: Candidate[] = [];
  for (const c of lists.flat()) {
    const h = host(c.homepage);
    if (!h) { noHost.push(c); continue; }
    if (!byHost.has(h)) byHost.set(h, c);
  }
  return [...byHost.values(), ...noHost];
}

/** Heuristic fallback when the model is unreachable: keep collections whose name
 *  mentions the place and DON'T look topical/experimental. */
function pickCollectionsHeuristic(placeName: string, cols: MCCollection[]): number[] {
  const needle = placeName.toLowerCase();
  const bad = /\b(topic|issue|research|experiment|test|sample|covid|climate|election\b|twitter|reddit|facebook)\b/i;
  return cols
    .filter((c) => c.name.toLowerCase().includes(needle) && !bad.test(`${c.name} ${c.description ?? ""}`))
    .map((c) => c.id);
}

const COLLECTION_PICK_PROMPT =
  "You are selecting Media Cloud COLLECTIONS to ingest as a country's general-news " +
  "source set for a news app. From the provided list, choose ONLY collections that " +
  "are GENERAL NEWS outlets geographically tied to the target place — national, " +
  "regional, state, and local press/broadcast. EXCLUDE collections that are topical/" +
  "issue-based (e.g. climate, elections, COVID), platform/social (Twitter, Reddit), " +
  "research/experimental/test sets, or tied to a DIFFERENT country. Reply with a " +
  "JSON array of objects {\"id\": <number>} for the collections to keep — nothing else.";

/** Let the model pick the relevant geographic collections; fall back to heuristic. */
async function pickCollections(placeName: string, cols: MCCollection[]): Promise<number[]> {
  if (cols.length === 0) return [];
  if (!(await aiReachable())) {
    console.error(`[place] AI unreachable — using heuristic collection selection.`);
    return pickCollectionsHeuristic(placeName, cols);
  }
  const payload = {
    place: placeName,
    collections: cols.map((c) => ({ id: c.id, name: c.name, description: c.description })),
  };
  const rows = await chatJsonArray(COLLECTION_PICK_PROMPT, payload, {
    maxTokens: cols.length * 8 + 128,
  });
  const valid = new Set(cols.map((c) => c.id));
  const chosen = rows
    .map((r) => Number((r as Record<string, unknown>)?.["id"]))
    .filter((n) => Number.isFinite(n) && valid.has(n));
  if (chosen.length === 0) {
    console.error(`[place] AI returned no usable picks — falling back to heuristic.`);
    return pickCollectionsHeuristic(placeName, cols);
  }
  return [...new Set(chosen)];
}

/** Resolve outlet candidates for the chosen Media Cloud collections (merged). */
async function resolveMediaCloudFor(
  cc: string,
  args: Args,
  key: string,
  queryName: string,
): Promise<Candidate[]> {
  // Resolve ONE collection, tolerating a flaky directory: Media Cloud occasionally
  // 500s on a single collection, and that must NOT abort the whole country. (It used
  // to throw out of Promise.all → the run failed and no <cc>.json was ever written.)
  const safeResolve = async (id: string): Promise<Candidate[]> => {
    try {
      return await resolveMediaCloudOutlets({ collection: id, key, limit: args.limit });
    } catch (e) {
      console.error(
        `[place:${cc}] skipping Media Cloud collection ${id}: ${e instanceof Error ? e.message : e}`,
      );
      return [];
    }
  };

  // Explicit ids bypass search + AI selection entirely.
  if (args.mcCollection) {
    const ids = args.mcCollection.split(",").map((s) => s.trim()).filter(Boolean);
    console.error(`[place:${cc}] using explicit Media Cloud collection(s): ${ids.join(", ")}`);
    const lists = await Promise.all(ids.map(safeResolve));
    return lists.flat();
  }
  // Otherwise: search the directory and let the model pick.
  const query = args.mcQuery ?? queryName ?? cc;
  const cols = await searchMediaCloudCollections(query, key);
  const picked = await pickCollections(query, cols);
  if (picked.length === 0) {
    console.error(`[place:${cc}] no Media Cloud collections selected for "${query}".`);
    return [];
  }
  const chosenNames = cols.filter((c) => picked.includes(c.id)).map((c) => `${c.id}:${c.name}`);
  console.error(`[place:${cc}] selected ${picked.length} collection(s): ${chosenNames.join(", ")}`);
  const lists = await Promise.all(picked.map((id) => safeResolve(String(id))));
  return lists.flat();
}

/** Country metadata for the generated placeSources/index.json (powers the tree). */
interface CountryMeta {
  label: string;
  continent: string;
  continentLabel: string;
}

/** Merge one country into the generated placeSources index (cc -> metadata). */
function updateIndex(cc: string, meta: CountryMeta): void {
  const indexPath = resolve(process.cwd(), "src/data/placeSources", "index.json");
  let index: Record<string, CountryMeta> = {};
  if (existsSync(indexPath)) {
    try {
      const parsed = JSON.parse(readFileSync(indexPath, "utf8"));
      if (parsed && typeof parsed === "object") index = parsed as Record<string, CountryMeta>;
    } catch {
      /* rewrite a corrupt index from scratch */
    }
  }
  index[cc] = meta;
  writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n", "utf8");
}

/** Build the generated registry for one country, auto-resolving its Wikidata
 *  identity (QID/lang/name/continent) from the ISO code — flags still override. */
async function buildCountry(cc: string, args: Args): Promise<void> {
  console.error(`[place:${cc}] resolving country metadata from Wikidata (ISO ${cc.toUpperCase()})…`);
  const info = await resolveCountry(cc);
  if (info) {
    console.error(
      `[place:${cc}] resolved ${info.qid} (${info.label}, lang=${info.lang}, continent=${info.continent || "?"}).`,
    );
  }
  const qid = args.qid ?? info?.qid ?? null;
  const lang = args.lang ?? info?.lang ?? "und";
  const name = args.mcQuery ?? info?.label ?? cc;
  const continent = info?.continent ?? "";
  const continentLabel = info?.continentLabel ?? "";
  if (!qid) throw new Error(`Could not resolve a Wikidata QID for "${cc}". Pass --qid Qnnn.`);
  const queryName = name;

  // 1) Resolve candidates from the datasets.
  console.error(`[place:${cc}] resolving Wikidata outlets (${qid}, lang=${lang})…`);
  const wiki = await resolveWikidataOutlets(qid, lang);

  // Media Cloud is opt-in via the key. With it, we search the collection directory
  // for this place and let the model pick the right geographic news collections
  // (or honor explicit --mc-collection ids). Without a key, Wikidata-only.
  let mc: Candidate[] = [];
  const key = process.env.MEDIACLOUD_API_KEY || "";
  if (key) {
    mc = await resolveMediaCloudFor(cc, args, key, queryName);
  } else if (args.mcCollection || args.mcQuery) {
    console.error(`[place:${cc}] Media Cloud requested but MEDIACLOUD_API_KEY missing — skipping.`);
  }

  const candidates = mergeCandidates(wiki, mc).slice(0, args.limit);
  console.error(`[place:${cc}] ${candidates.length} unique candidate(s) after merge; discovering feeds…`);

  // 2) Autodiscover + validate feeds.
  const discovered = await discoverFeeds(candidates, {
    lang,
    concurrency: args.concurrency,
    timeoutMs: args.timeoutMs,
  });

  // 3) Keep working feeds, dedupe by feed URL, shape as Source[].
  const seenUrl = new Set<string>();
  const seenId = new Set<string>();
  const sources: Source[] = [];
  for (const d of discovered) {
    if (!d.ok || !d.url || seenUrl.has(d.url)) continue;
    seenUrl.add(d.url);
    let id = `${cc}-${slug(d.title)}`;
    let n = 2;
    while (seenId.has(id)) id = `${cc}-${slug(d.title)}-${n++}`;
    seenId.add(id);
    sources.push({
      id,
      title: d.title,
      url: d.url,
      kind: "news",
      topic: "world", // placeholder; the analysis pass assigns the real topic per item
      lean: null, // AI-generated per item — never a source-level prior here
      confidence: 0.4,
      leanRationale: d.leanRationale,
      lang,
      // Region discovery: tag the outlet's top-level subdivision (ISO 3166-2) so
      // the geo drill-down can serve region-specific outlets.
      ...(d.region ? { region: d.region, regionLabel: d.regionLabel ?? undefined } : {}),
    });
  }

  // 4) Write the generated registry + fold the country into the tree index.
  const outPath = args.out ?? resolve(process.cwd(), "src/data/placeSources", `${cc}.json`);
  mkdirSync(resolve(outPath, ".."), { recursive: true });
  writeFileSync(outPath, JSON.stringify(sources, null, 2) + "\n", "utf8");
  if (!args.out) updateIndex(cc, { label: name, continent, continentLabel });
  const tagged = sources.filter((s) => s.region).length;
  console.error(
    `[place:${cc}] wrote ${sources.length} working local source(s) (${tagged} region-tagged) ` +
    `-> ${outPath} (from ${discovered.length} candidate(s)).`,
  );
}

/** Build a batch of countries, isolating per-country failures. */
async function buildAll(codes: string[], args: Args): Promise<void> {
  console.error(`[place] building ${codes.length} countr(ies): ${codes.join(", ")}`);
  for (const cc of codes) {
    try {
      await buildCountry(cc, { ...args, country: cc });
    } catch (e) {
      console.error(`[place:${cc}] failed:`, e instanceof Error ? e.message : e);
    }
  }
}

/** Country codes that already have a generated placeSources/<cc>.json. */
function existingCountryCodes(): string[] {
  const dir = resolve(process.cwd(), "src/data/placeSources");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f: string) => /^[a-z]{2}\.json$/.test(f))
    .map((f: string) => f.slice(0, 2));
}

async function run(args: Args): Promise<void> {
  // --continent <name>: discover the country list from Wikidata, then build each.
  if (args.continent) {
    const codes = await resolveCountriesInContinent(args.continent);
    if (codes.length === 0) throw new Error(`No countries resolved for continent "${args.continent}".`);
    await buildAll(codes, args);
    return;
  }
  // --all: refresh every country that already has a generated registry.
  if (args.all) {
    await buildAll(existingCountryCodes(), args);
    return;
  }
  if (!args.country) {
    throw new Error(
      "Pass --country <cc> (e.g. es), --continent <name> (e.g. Europe), or --all to refresh existing.",
    );
  }
  await buildCountry(args.country, args);
}

run(parseArgs(process.argv.slice(2))).catch((e: unknown) => {
  console.error("buildPlaceSources failed:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
