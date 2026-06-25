#!/usr/bin/env bash
# Download the free (CC-BY) GeoNames cities15000 dump used by scripts/buildCityCoords.ts to
# build the bundled city-coordinate gazetteer. Writes data/geonames/cities15000.txt.
set -euo pipefail

DIR="data/geonames"
BASE="https://download.geonames.org/export/dump"
mkdir -p "$DIR"

# GeoNames' download host 403s the default curl UA; send a browser-like one.
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"

echo "[geonames] downloading cities15000 into ${DIR} ..."
curl -fsSL -A "$UA" -o "$DIR/cities15000.zip" "$BASE/cities15000.zip"
unzip -o "$DIR/cities15000.zip" "cities15000.txt" -d "$DIR" >/dev/null
rm -f "$DIR/cities15000.zip"

echo "[geonames] done: $DIR/cities15000.txt"
