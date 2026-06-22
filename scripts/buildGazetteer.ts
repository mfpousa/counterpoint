// Build a hierarchical PLACE GAZETTEER (country → region → locality, each with
// alias tokens) from open GeoNames data. The gazetteer powers the geographic
// relevance BOOST in src/lib/places.ts — so local stories surface from any feed —
// without hand-mapping the world. Generated, never hand-edited.
//
// ─────────────────────────────────────────────────────────────────────────────
// INPUT (free, CC-BY GeoNames dumps — download once, no API key):
//   mkdir -p data/geonames && cd data/geonames
//   curl -O https://download.geonames.org/export/dump/countryInfo.txt
//   curl -O https://download.geonames.org/export/dump/admin1CodesASCII.txt
//   curl -O https://download.geonames.org/export/dump/ES.zip   # per-country dump
//   unzip ES.zip                                               # -> ES.txt
//
// RUN:
//   npx tsx scripts/buildGazetteer.ts --country es --min-pop 20000
//
// OUTPUT:
//   src/data/gazetteer/<cc>.json  — PlaceNode[] for that country.
//
// NOTE ON ALIASES: GeoNames gives multilingual `alternatenames`; we keep the name,
// asciiname and alternate names as aliases. Demonyms and key local figures are
// best enriched from Wikidata later (see scripts/resolveSources.ts) — flagged,
// not silently assumed.
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { PlaceNode } from "../src/types";

interface Args {
  country: string;
  inDir: string;
  outDir: string;
  minPop: number;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string, fallback: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  return {
    country: get("--country", "es").toLowerCase(),
    inDir: get("--in", "data/geonames"),
    outDir: get("--out", "src/data/gazetteer"),
    minPop: Number(get("--min-pop", "20000")),
  };
}

/** Accent/punctuation-insensitive slug for stable ids. */
function slug(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Clean + dedupe a list of candidate aliases into lowercase signal tokens. */
function cleanAliases(raw: string[]): string[] {
  const out = new Set<string>();
  for (const r of raw) {
    const a = r.trim().toLowerCase();
    // Drop too-short, purely numeric, or code-like tokens (airport codes, links).
    if (a.length < 3) continue;
    if (!/\p{L}/u.test(a)) continue;
    if (/^https?:/.test(a)) continue;
    out.add(a);
  }
  return [...out];
}

function readLines(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l: string) => l.length > 0);
}

/** countryInfo.txt → { iso: EnglishName } (skips the leading '#'-comment block). */
function readCountryNames(inDir: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of readLines(resolve(inDir, "countryInfo.txt"))) {
    if (line.startsWith("#")) continue;
    const c = line.split("\t");
    if (c[0] && c[4]) map.set(c[0].toLowerCase(), c[4]);
  }
  return map;
}

/** admin1CodesASCII.txt → Map<"CC.A1", { name, code }> for one country. */
function readAdmin1(inDir: string, cc: string): Map<string, { name: string }> {
  const upper = cc.toUpperCase();
  const map = new Map<string, { name: string }>();
  for (const line of readLines(resolve(inDir, "admin1CodesASCII.txt"))) {
    const [code, name] = line.split("\t");
    if (!code || !name) continue;
    if (code.startsWith(`${upper}.`)) map.set(code, { name });
  }
  return map;
}

function build(args: Args): { nodes: PlaceNode[]; summary: string } {
  const { country: cc, inDir, minPop } = args;
  const countryFile = resolve(inDir, `${cc.toUpperCase()}.txt`);
  for (const f of ["countryInfo.txt", "admin1CodesASCII.txt", `${cc.toUpperCase()}.txt`]) {
    if (!existsSync(resolve(inDir, f))) {
      throw new Error(
        `Missing ${f} in ${inDir}. See the download instructions at the top of this script.`,
      );
    }
  }

  const countryNames = readCountryNames(inDir);
  const admin1 = readAdmin1(inDir, cc);
  const countryLabel = countryNames.get(cc) ?? cc.toUpperCase();

  const nodes: PlaceNode[] = [];

  // Country node.
  const countryNode: PlaceNode = {
    id: cc,
    level: "country",
    label: countryLabel,
    country: cc,
    aliases: cleanAliases([countryLabel, cc]),
  };
  nodes.push(countryNode);

  // Region nodes (first-level admin divisions), keyed by GeoNames "CC.A1" code.
  const regionIdByA1 = new Map<string, string>(); // "CC.29" -> "es-comunidad-de-madrid"
  for (const [code, { name }] of admin1) {
    const id = `${cc}-${slug(name)}`;
    regionIdByA1.set(code, id);
    nodes.push({
      id,
      parent: cc,
      level: "region",
      label: name,
      country: cc,
      aliases: cleanAliases([name]),
    });
  }

  // Locality nodes from the per-country dump: populated places (feature class P)
  // at/above the population floor, grouped under their admin1 region.
  let localities = 0;
  for (const line of readLines(countryFile)) {
    const c = line.split("\t");
    const featureClass = c[6];
    if (featureClass !== "P") continue;
    const population = Number(c[14] || "0");
    if (population < minPop) continue;

    const name = c[1];
    const asciiname = c[2];
    const alternates = (c[3] || "").split(",");
    const a1 = c[10];
    const parent = regionIdByA1.get(`${cc.toUpperCase()}.${a1}`) ?? cc;

    nodes.push({
      id: `${parent}-${slug(name)}`,
      parent,
      level: "locality",
      label: name,
      country: cc,
      aliases: cleanAliases([name, asciiname, ...alternates]),
      population,
    });
    localities += 1;
  }

  const summary =
    `Gazetteer ${cc.toUpperCase()} (${countryLabel}): ` +
    `${admin1.size} region(s), ${localities} localit(ies) ≥ ${minPop.toLocaleString()} pop.`;
  return { nodes, summary };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { nodes, summary } = build(args);
  const out = resolve(process.cwd(), args.outDir, `${args.country}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(nodes, null, 2) + "\n", "utf8");
  console.log(`Wrote ${out} (${nodes.length} nodes)`);
  console.log(summary);
}

main();
