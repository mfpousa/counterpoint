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
// RUN (needs network + key). There is NO default collection — pass the id of a
// geographic collection from the Media Cloud Directory (https://search.mediacloud.org/):
//   MEDIACLOUD_API_KEY=xxxx npx tsx scripts/resolveSourcesMediaCloud.ts --collection <ID>
//
// OUTPUT: prints JSON candidate Source stubs to stdout (redirect to a file).

// Thin CLI over the shared resolver in scripts/lib/discovery.ts.
import { resolveMediaCloudOutlets } from "./lib/discovery";

function parseArgs(argv: string[]): { collection: string; limit: number } {
  const get = (flag: string, fallback: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  return { collection: get("--collection", ""), limit: Number(get("--limit", "500")) };
}

const args = parseArgs(process.argv.slice(2));
resolveMediaCloudOutlets({
  collection: args.collection,
  limit: args.limit,
  key: process.env.MEDIACLOUD_API_KEY || "",
  base: process.env.MEDIACLOUD_API_BASE,
})
  .then((candidates) => {
    console.error(`Resolved ${candidates.length} outlet candidate(s) (lean UNSET — AI-generated per item).`);
    console.log(JSON.stringify(candidates, null, 2));
  })
  .catch((e: unknown) => {
    console.error("resolveSourcesMediaCloud failed:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
