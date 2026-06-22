# Sourcing news outlets from open datasets

Investigation into whether **Media Cloud** and **Wikidata** can replace or augment
Counterpoint's hand-curated source set (`src/data/sources.ts`) and power the new
**place lens** (`src/lib/places.ts`, `scripts/buildGazetteer.ts`).

> TL;DR: **Augment, don't replace.** Datasets are excellent for *geographic breadth*
> and *candidate discovery*, but none of them carry the **political-lean priors**
> that are the heart of this product. Keep human-curated lean; let datasets feed
> the geographic (lean-`null`) layers and surface candidates for human review.

## The hard constraint: lean priors

Every `Source` carries a curated `lean` (−1..+1), `confidence`, and an auditable
`leanRationale` (`src/types.ts`). These drive the balance dial, drift detection,
and counter-weighting — the entire counterpoint premise.

| Dataset | Outlets by country | Region/city tag | Website | RSS feed | **Political lean** | Key/keyless |
| --- | --- | --- | --- | --- | --- | --- |
| **Media Cloud** | Yes (geo collections) | Often | Yes | Sometimes | **No** | API key (free) |
| **Wikidata** | Yes (`P17`) | Yes (`P131`) | Yes (`P856`) | Rarely (`P1019`) | **No** | Keyless (SPARQL) |
| **GDELT** | Yes (domain list) | Country-level | Domain | No | **No** | Keyless (TOS) |
| GeoNames | n/a (places, not outlets) | — | — | — | — | Keyless dumps |

**Conclusion:** a wholesale replacement would strip the lean priors and degrade the
core feature. Lean must stay human-assigned (optionally seeded from a media-bias
dataset like AllSides/Ad Fontes/MBFC — but those are US-centric and licence-bound).

## What each dataset is genuinely good for

- **GeoNames** (CC-BY, keyless dumps) → the **gazetteer**. Countries, regions
  (admin1), and localities with multilingual aliases. Implemented in
  `scripts/buildGazetteer.ts`; consumed by `src/lib/places.ts`. This makes the
  relevance-boost work for *any* place with zero curated feeds.
- **Wikidata** (CC0, keyless SPARQL) → **outlet discovery** + home region (`P131`)
  + website (`P856`). Prototyped in `scripts/resolveSources.ts`. Emits candidates
  with `lean: null` + a "requires human review" rationale — by design.
- **Media Cloud** (open, free API key) → the broadest **geo-tagged outlet
  catalogue**; best for bulk per-country/region discovery. Needs a key (flag to
  the user before wiring; do not hard-code — env var).
- **GDELT** → breadth/volume signal and a master domain list; useful to rank
  which discovered outlets actually publish a lot.

## Recommended pipeline (augmenting, lazy, lock-friendly)

1. **Gazetteer up front, globally** — GeoNames import (done). Powers the boost for
   every place immediately, no feeds required.
2. **Discover outlets per place on demand** — Wikidata/Media Cloud query when a
   reader first selects a place; **RSS-autodiscover** each website; **validate**
   the feed (fetch+parse, reusing `server`'s existing prune/validate); cache the
   survivors into the place registry. Mirrors the zones reactive pattern — no
   global pre-fetch, respects the single-build lock.
3. **Lean stays human** — discovered outlets used for *local/geographic* layers
   inherit `lean: null` (like zones — domestic axes don't map to US left/right).
   Any outlet promoted into the *front-page balance set* gets a human lean prior.

## Licensing notes

- **Wikidata** CC0, **GeoNames** CC-BY — safe to redistribute (attribute GeoNames).
- **Media Cloud** / **GDELT** — fine to *use*; verify redistribution terms before
  bundling their lists into the repo.
- Media-bias ratings (AllSides/Ad Fontes/MBFC) are **proprietary** — don't ingest
  without a licence; use only as human reference when assigning `lean`.

## Prototypes delivered

- `scripts/buildGazetteer.ts` — GeoNames → `src/data/gazetteer/<cc>.json` (`PlaceNode[]`).
- `scripts/resolveSources.ts` — Wikidata SPARQL → outlet candidates (lean unset).
- `src/lib/places.ts` + `__tests__/places.test.ts` — the pure relevance-boost engine.

## Open decisions for the user

1. **Augment vs replace** — DECIDED: augment.
2. **Media Cloud key** — DECIDED: user has a key (pass via `MEDIACLOUD_API_KEY` env var).
3. **Lean seeding** — DECIDED: lean is AI-generated per item; discovered sources carry `lean: null`.

## Running the validations (on an un-proxied machine)

Some corporate networks 403 archive (`.zip`) downloads, which blocks the GeoNames
per-country dump. Run these where downloads are unrestricted.

**1. GeoNames gazetteer (keyless).** Downloads the Spain dumps and builds the
gazetteer; the generated `src/data/gazetteer/es.json` then supersedes the built-in
seed in `server/places.ts`.

```bash
npm run gazetteer:fetch -- ES
npm run gazetteer:build -- --country es --min-pop 20000
```

Verify: `src/data/gazetteer/es.json` exists with a country node, ~17 regions
(Comunidades Autónomas), and a few hundred localities ≥ 20k population.

**2. Wikidata outlet discovery (keyless).** `Q29` = Spain.

```bash
npm run sources:wikidata -- --qid Q29 --lang es > /tmp/wikidata-es.json
```

Verify: a JSON array of outlet candidates, each with `homepage` and `lean: null`.

**3. Media Cloud outlet discovery (needs your key).** Find a geographic collection
id on https://search.mediacloud.org/ (Directory → Collections), then:

```bash
export MEDIACLOUD_API_KEY=your_key_here
npm run sources:mediacloud -- --collection <COLLECTION_ID> > /tmp/mediacloud.json
```

Verify: a JSON array of outlet candidates with `homepage` and `lean: null`. If the
request 401s, re-check the key; if the result shape differs, adjust the `BASE`/
parsing in `scripts/resolveSourcesMediaCloud.ts` (endpoint paths are documented but
unverified — see the script header).

> Next step after validation: RSS-autodiscover each candidate `homepage`, validate
> the feeds, and fold survivors into the place registries (lean stays `null` — the
> analysis pass assigns lean per item).
