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

// Thin CLI over the shared resolver in scripts/lib/discovery.ts (which the
// automated pipeline scripts/buildPlaceSources.ts also uses).
import { resolveWikidataOutlets } from "./lib/discovery";

function parseArgs(argv: string[]): { qid: string; lang: string } {
  const get = (flag: string, fallback: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  return { qid: get("--qid", "Q29"), lang: get("--lang", "en") };
}

const { qid, lang } = parseArgs(process.argv.slice(2));
resolveWikidataOutlets(qid, lang)
  .then((candidates) => {
    console.error(`Resolved ${candidates.length} outlet candidate(s) (lean UNSET — AI-generated per item).`);
    console.log(JSON.stringify(candidates, null, 2));
  })
  .catch((e: unknown) => {
    console.error("resolveSources failed:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
