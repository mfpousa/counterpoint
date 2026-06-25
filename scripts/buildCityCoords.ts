// Build the compact, bundled CITY-COORDINATE gazetteer used to geocode a place NAME to a
// point — the first (most reliable) tier of resolving where a co-located "gathering"
// happened (see src/lib/placeGeocode.ts → src/lib/cityCoords.ts). Generated from the open
// (CC-BY) GeoNames cities15000 dump; never hand-edited. The model-coords + centroid tiers
// catch the long tail this population floor misses, so this set only needs decent coverage
// of major cities.
//
// INPUT (download once — see scripts/fetch-cities.sh, or):
//   mkdir -p data/geonames && cd data/geonames
//   curl -O https://download.geonames.org/export/dump/cities15000.zip
//   unzip cities15000.zip            # -> cities15000.txt
//
// RUN:  npx tsx scripts/buildCityCoords.ts
// OUT:  src/data/cityCoords.json  — compact [asciiname, iso2, lat, lon, population][]

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const IN = resolve(process.cwd(), "data/geonames/cities15000.txt");
const OUT = resolve(process.cwd(), "src/data/cityCoords.json");

if (!existsSync(IN)) {
  console.error(`Missing ${IN}. Download it first (scripts/fetch-cities.sh), e.g.:`);
  console.error(
    "  curl -O https://download.geonames.org/export/dump/cities15000.zip && " +
      "unzip cities15000.zip -d data/geonames",
  );
  process.exit(1);
}

// GeoNames "geoname" table is tab-separated; the columns we use:
//   1 name · 2 asciiname · 4 latitude · 5 longitude · 6 feature class · 8 country code · 14 population
const ROUND = (n: number) => Math.round(n * 1e4) / 1e4; // ~11 m precision, smaller file
type CityRow = [name: string, cc: string, lat: number, lon: number, pop: number];

const rows: CityRow[] = [];
for (const line of readFileSync(IN, "utf8").split("\n")) {
  if (!line) continue;
  const c = line.split("\t");
  if (c[6] !== "P") continue; // populated place only
  const name = (c[2] || c[1] || "").trim(); // prefer the ASCII name (matches model spelling)
  const cc = (c[8] || "").trim().toLowerCase();
  const lat = Number(c[4]);
  const lon = Number(c[5]);
  const pop = Number(c[14] || "0");
  if (!name || !/^[a-z]{2}$/.test(cc)) continue;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
  rows.push([name, cc, ROUND(lat), ROUND(lon), pop]);
}

rows.sort((a, b) => b[4] - a[4]); // most-populous first (stable disambiguation + readable)
writeFileSync(OUT, JSON.stringify(rows) + "\n", "utf8");
console.log(`Wrote ${OUT} (${rows.length} cities)`);
