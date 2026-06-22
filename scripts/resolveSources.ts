// Resolve candidate news OUTLETS for a country from Wikidata (keyless SPARQL),
// as raw material for the curated source set / local-place registries. This is a
// PROTOTYPE for the "can datasets replace our sources?" investigation — see
// docs/SOURCES_DATASETS.md.
//
// CRITICAL: Wikidata gives the outlet, its website and (often) its home region,
// but NOT a political LEAN. Counterpoint's whole premise is curated lean priors
// (Source.lean / leanRationale). So every candidate here is emitted with
// `lean: null` and a rationale demanding HUMAN review — proving the point that
// these datasets AUGMENT (discovery, geography) rather than REPLACE curation.
//
// RUN (needs network; Wikidata Query Service is free, no key, but requires a
// descriptive User-Agent per their policy):
//   npx tsx scripts/resolveSources.ts --qid Q29 --lang es   # Q29 = Spain
//
// OUTPUT: prints JSON candidate Source stubs to stdout (redirect to a file).
// FOLLOW-UP (not done here): RSS autodiscovery on each website to fill `url`.

const WDQS = "https://query.wikidata.org/sparql";
const UA = "CounterpointResearch/0.1 (source discovery prototype; contact: dev@example.com)";

interface Args {
  qid: string;
  lang: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string, fallback: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  return { qid: get("--qid", "Q29"), lang: get("--lang", "en") };
}

/**
 * SPARQL: news OUTLETS tied to a country — tuned for the WDQS time budget.
 *
 * Lessons from a 504: the unbounded `P31/P279*` subclass walk + a 3-way country
 * UNION + a `P131` region join is too heavy. So we keep it CHEAP:
 *  - direct `wdt:P31` against an explicit list of the common outlet types
 *    (the frequent newspaper subclasses are listed directly, no `P279*` walk),
 *  - country via `P17` OR `P495` only (drop the expensive HQ->country hop),
 *  - no region join here (recover region later, it caused row blow-up + cost).
 *
 * NOTE: plain `SELECT` (NOT `SELECT DISTINCT`) — the `wikibase:label` auto-label
 * magic is silently disabled by DISTINCT/GROUP BY, which leaves every `?outletLabel`
 * unbound (we dedupe by title in code instead).
 */
function query(qid: string, lang: string): string {
  return `
    SELECT ?outlet ?outletLabel ?website WHERE {
      VALUES ?type {
        wd:Q11032     # newspaper
        wd:Q1110794   # daily newspaper
        wd:Q1153191   # online newspaper
        wd:Q192283    # news agency
        wd:Q1616075   # television station
        wd:Q14350     # radio station
      }
      ?outlet wdt:P31 ?type .
      { ?outlet wdt:P17 wd:${qid} . } UNION { ?outlet wdt:P495 wd:${qid} . }
      OPTIONAL { ?outlet wdt:P856 ?website. } # official website
      SERVICE wikibase:label { bd:serviceParam wikibase:language "${lang},en". }
    }
    ORDER BY ?outletLabel
    LIMIT 1000`;
}

interface Binding {
  outletLabel?: { value: string };
  website?: { value: string };
}

/** A discovery candidate — deliberately NOT a finished Source (no lean, no feed). */
interface SourceCandidate {
  title: string;
  homepage: string | null;
  region: string | null;
  /** Always null from datasets — Counterpoint requires a human lean prior. */
  lean: null;
  leanRationale: string;
  needsRssDiscovery: boolean;
}

/** WDQS 5xx (esp. 504) are frequently transient — retry with backoff. */
async function fetchWdqs(url: string, attempts = 3): Promise<Response> {
  for (let i = 1; i <= attempts; i++) {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/sparql-results+json" },
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

async function run(args: Args): Promise<SourceCandidate[]> {
  const url = `${WDQS}?query=${encodeURIComponent(query(args.qid, args.lang))}&format=json`;
  const res = await fetchWdqs(url);
  const json = (await res.json()) as { results: { bindings: Binding[] } };

  const bindings = json.results.bindings;
  let skippedUnlabeled = 0;
  // Dedupe by outlet label (one row per outlet even with multiple regions).
  const byTitle = new Map<string, SourceCandidate>();
  for (const b of bindings) {
    const title = b.outletLabel?.value?.trim();
    if (!title || /^Q\d+$/.test(title)) {
      skippedUnlabeled++; // label service returned a bare QID (or nothing)
      continue;
    }
    if (!byTitle.has(title)) {
      byTitle.set(title, {
        title,
        homepage: b.website?.value ?? null,
        region: null, // recovered in a later pass; omitted here for WDQS perf
        lean: null,
        leanRationale: "Unrated — Wikidata-discovered; requires HUMAN lean review before use.",
        needsRssDiscovery: !!b.website?.value,
      });
    }
  }
  // Diagnostics so a 0-result run is never a mystery.
  console.error(
    `Wikidata returned ${bindings.length} row(s); ` +
    `${skippedUnlabeled} skipped (unlabeled QIDs); ${byTitle.size} unique outlet(s).`,
  );
  return [...byTitle.values()];
}

run(parseArgs(process.argv.slice(2)))
  .then((candidates) => {
    console.error(`Resolved ${candidates.length} outlet candidate(s) (lean UNSET — review required).`);
    console.log(JSON.stringify(candidates, null, 2));
  })
  .catch((e: unknown) => {
    console.error("resolveSources failed:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });

// Make this file a MODULE (isolated scope) so its top-level names don't collide
// with the sibling resolver scripts when type-checked together.
export {};
