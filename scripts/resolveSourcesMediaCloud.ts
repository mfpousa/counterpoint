// Resolve candidate news OUTLETS for a place from MEDIA CLOUD's Directory API, as
// raw material for the local-place source registries (the "augment sources"
// track). Media Cloud has the broadest geo-tagged outlet catalogue; this pulls a
// collection's sources (name + homepage) for RSS autodiscovery downstream.
//
// AUTH (required): Media Cloud's API needs a FREE API key. Provide it via the
// MEDIACLOUD_API_KEY env var — NEVER hardcode it. Get one at https://search.mediacloud.org/.
//
// CRITICAL (same as the Wikidata resolver): Media Cloud does NOT provide political
// LEAN. Per the project decision, lean is AI-GENERATED per item by the analysis
// pass, so candidates are emitted with `lean: null` — these feed the GEOGRAPHIC
// (lean-null) layers, not the curated front-page balance set.
//
// NOTE: endpoint paths follow Media Cloud's documented Directory API. They are
// UNVERIFIED against the live service in this environment — confirm the base URL,
// auth scheme, and result shape on first run and adjust `BASE`/parsing if needed.
//
// RUN (needs network + key):
//   MEDIACLOUD_API_KEY=xxxx npx tsx scripts/resolveSourcesMediaCloud.ts --collection 34412234
//
// OUTPUT: prints JSON candidate Source stubs to stdout (redirect to a file).

const BASE = process.env.MEDIACLOUD_API_BASE || "https://search.mediacloud.org/api";
const KEY = process.env.MEDIACLOUD_API_KEY || "";
const UA = "CounterpointResearch/0.1 (source discovery prototype)";

interface Args {
  collection: string;
  limit: number;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string, fallback: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  return { collection: get("--collection", ""), limit: Number(get("--limit", "500")) };
}

/** One Media Cloud "source" row (subset of fields we use). */
interface MCSource {
  id?: number;
  name?: string;
  label?: string;
  homepage?: string;
  url?: string;
}
interface MCPage {
  count?: number;
  next?: string | null;
  results?: MCSource[];
}

/** A discovery candidate — NOT a finished Source (no lean, RSS still to discover). */
interface SourceCandidate {
  title: string;
  homepage: string | null;
  lean: null;
  leanRationale: string;
  needsRssDiscovery: boolean;
}

async function fetchPage(url: string): Promise<MCPage> {
  const res = await fetch(url, {
    headers: { Authorization: `Token ${KEY}`, "User-Agent": UA, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Media Cloud ${res.status} ${res.statusText} for ${url}`);
  return (await res.json()) as MCPage;
}

async function run(args: Args): Promise<SourceCandidate[]> {
  if (!KEY) throw new Error("Set MEDIACLOUD_API_KEY in the environment (do not hardcode).");
  if (!args.collection) throw new Error("Pass --collection <id> (a Media Cloud collection id).");

  const out = new Map<string, SourceCandidate>();
  let url: string | null =
    `${BASE}/sources/sources/?collection_id=${encodeURIComponent(args.collection)}&limit=100`;

  while (url && out.size < args.limit) {
    const page: MCPage = await fetchPage(url);
    for (const s of page.results ?? []) {
      const title = (s.name || s.label || "").trim();
      if (!title) continue;
      const homepage = s.homepage || s.url || null;
      if (!out.has(title)) {
        out.set(title, {
          title,
          homepage,
          lean: null,
          leanRationale: "Unrated — Media Cloud-discovered; lean is AI-generated per item.",
          needsRssDiscovery: !!homepage,
        });
      }
    }
    url = page.next ?? null;
  }
  return [...out.values()].slice(0, args.limit);
}

run(parseArgs(process.argv.slice(2)))
  .then((candidates) => {
    console.error(`Resolved ${candidates.length} outlet candidate(s) (lean UNSET — AI-generated per item).`);
    console.log(JSON.stringify(candidates, null, 2));
  })
  .catch((e: unknown) => {
    console.error("resolveSourcesMediaCloud failed:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });

// Make this file a MODULE (isolated scope) so its top-level names don't collide
// with the sibling resolver scripts when type-checked together.
export {};
