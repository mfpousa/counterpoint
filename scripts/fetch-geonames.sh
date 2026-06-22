#!/usr/bin/env bash
# Download the free (CC-BY) GeoNames dumps needed by scripts/buildGazetteer.ts.
# Usage:  bash scripts/fetch-geonames.sh [COUNTRY_CODE]   (default: ES)
# Writes into data/geonames/ : countryInfo.txt, admin1CodesASCII.txt, <CC>.txt
set -euo pipefail

CC="${1:-ES}"
DIR="data/geonames"
BASE="https://download.geonames.org/export/dump"

mkdir -p "$DIR"
echo "[geonames] downloading into $DIR (country: $CC)…"

# GeoNames' download host 403s the default curl UA; send a browser-like one.
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
GET() { curl -fsSL -A "$UA" -o "$1" "$2"; }

GET "$DIR/countryInfo.txt"     "$BASE/countryInfo.txt"
GET "$DIR/admin1CodesASCII.txt" "$BASE/admin1CodesASCII.txt"
GET "$DIR/$CC.zip"             "$BASE/$CC.zip"

# Per-country dump is zipped; extract the <CC>.txt table.
unzip -o "$DIR/$CC.zip" "$CC.txt" -d "$DIR" >/dev/null
rm -f "$DIR/$CC.zip"

echo "[geonames] done: $DIR/countryInfo.txt, $DIR/admin1CodesASCII.txt, $DIR/$CC.txt"
