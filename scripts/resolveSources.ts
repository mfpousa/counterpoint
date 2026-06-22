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

/** SPARQL: news outlets (instance of / subclass of newspaper) in a country. */
function query(qid: string, lang: string): string {
  return `
    SELECT ?outlet ?outletLabel ?website ?regionLabel WHERE {
      ?outlet wdt:P31/wdt:P279* wd:Q11032 .   # instance of (subclass of) newspaper
      ?outlet wdt:P17 wd:${qid} .             # country
      OPTIONAL { ?outlet wdt:P856 ?website. } # official website
      OPTIONAL { ?outlet wdt:P131 ?region. }  # located in admin entity
      SERVICE wikibase:label { bd:serviceParam wikibase:language "${lang},en". }
    }
    ORDER BY ?outletLabel
    LIMIT 500`;
}

interface Binding {
  outletLabel?: { value: string };
  website?: { value: string };
  regionLabel?: { value: string };
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

async function run(args: Args): Promise<SourceCandidate[]> {
  const url = `${WDQS}?query=${encodeURIComponent(query(args.qid, args.lang))}&format=json`;
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/sparql-results+json" } });
  if (!res.ok) throw new Error(`WDQS ${res.status} ${res.statusText}`);
  const json = (await res.json()) as { results: { bindings: Binding[] } };

  // Dedupe by outlet label (one row per outlet even with multiple regions).
  const byTitle = new Map<string, SourceCandidate>();
  for (const b of json.results.bindings) {
    const title = b.outletLabel?.value?.trim();
    if (!title || /^Q\d+$/.test(title)) continue; // skip unlabeled items
    if (!byTitle.has(title)) {
      byTitle.set(title, {
        title,
        homepage: b.website?.value ?? null,
        region: b.regionLabel?.value ?? null,
        lean: null,
        leanRationale: "Unrated — Wikidata-discovered; requires HUMAN lean review before use.",
        needsRssDiscovery: !!b.website?.value,
      });
    }
  }
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
