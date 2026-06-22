// RSS/Atom autodiscovery for outlet candidates produced by resolveSources.ts
// (Wikidata) and resolveSourcesMediaCloud.ts (Media Cloud). This is the bridge
// from "we found a homepage" to "we have a working feed Counterpoint can poll".
//
// For each candidate with a `homepage` we:
//   1. fetch the homepage and read any declared <link rel="alternate"
//      type="application/rss+xml|atom+xml"> feeds (the authoritative signal), then
//   2. fall back to a short list of conventional feed paths (/feed, /rss, …), and
//   3. VALIDATE each guess by fetching + parsing it and requiring real items.
// The first feed that validates wins. Survivors are emitted as Source-shaped
// stubs (lean STAYS null — the analysis pass assigns lean per item).
//
// RUN (needs network; run outside a proxy that blocks outbound fetches):
//   npm run discover:feeds -- --in /tmp/wikidata-es.json --lang es > /tmp/feeds-es.json
//   cat /tmp/mediacloud.json | npm run discover:feeds -- --lang es > /tmp/feeds-mc.json
//
// OUTPUT: JSON array of { title, url (FEED), homepage, region, lang, lean:null,
// confidence, leanRationale, ok } to stdout; a human summary to stderr.

// Thin CLI over the shared discovery library in scripts/lib/discovery.ts.
import { readFileSync } from "node:fs";
import { discoverFeeds, type Candidate } from "./lib/discovery";

function parseArgs(argv: string[]) {
  const get = (flag: string, fallback: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  return {
    in: argv.indexOf("--in") >= 0 ? get("--in", "") || null : null,
    lang: get("--lang", "und"),
    concurrency: Math.max(1, parseInt(get("--concurrency", "6"), 10) || 6),
    timeoutMs: Math.max(1000, parseInt(get("--timeout", "10000"), 10) || 10000),
  };
}

function readInput(file: string | null): Candidate[] {
  const raw = file ? readFileSync(file, "utf8") : readFileSync(0, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("Input must be a JSON array of candidates.");
  return parsed as Candidate[];
}

const args = parseArgs(process.argv.slice(2));
discoverFeeds(readInput(args.in), {
  lang: args.lang,
  concurrency: args.concurrency,
  timeoutMs: args.timeoutMs,
})
  .then((sources) => {
    console.log(JSON.stringify(sources, null, 2));
  })
  .catch((e: unknown) => {
    console.error("discoverFeeds failed:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
