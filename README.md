# Counterpoint

A mobile-first learning feed that works for **you**, not the engagement algorithm.

Set a daily learning quota (e.g. 2 hours). Counterpoint composes a feed of videos, podcasts
and news drawn from free, key-less RSS sources — deliberately balanced across **perspectives**
(left ↔ right) *and* **topics** (world, science, economics, history, …), so you escape echo
chambers and the attention-monopolising feeds of mainstream social media.

It tracks the perspective lean of what you actually **consume** and nudges you back toward a
**50/50** balance, warning you when you drift too far left or right.

## Why it's different

- **You set the quota.** The feed fills to *your* target, then stops. No infinite scroll.
- **Balance is a hard rule, not a vibe.** The feed engine targets a 50/50 left/right split of
  political content and counter-weights toward the side you've under-consumed.
- **Provenance is visible.** Every item shows its lean value, derived bucket, and whether the
  tag came from the curated source rating or the optional AI classifier.
- **Local & private.** Quota, progress and balance live on your device. Nothing is uploaded.
- **No ML engagement ranking.** The only personalisation is the 50/50 counter-weight.

## AI-first pipeline

A local **backend** (`server/`) does the heavy lifting and the Expo app just renders the result:

1. **Fetch (server-side).** The backend downloads every feed in `src/data/sources.ts` directly —
   no browser, no CORS, no public proxy. Fetches are concurrency-limited to be a good citizen.
2. **Transcripts (videos).** For YouTube sources, the backend pulls the caption transcript
   (`server/transcripts.ts`) so the model judges the *actual spoken content*, not just the
   description box. Transcripts are cached per video and truncated to a character budget.
3. **AI enrichment (local LLM).** Each article (plus its transcript, when available) is sent in
   batches to **your local model** via any OpenAI-compatible endpoint (LM Studio, Ollama,
   llama.cpp, vLLM). The model assigns a `topic`, a political `lean` (`-1` left → `+1` right, or
   `null` for non-political), a `relevance` score (0–1), and a one-line rationale. Enrichments are
   cached per item so we never re-pay.
4. **Rank + diversify.** `server/rank.ts` greedily orders items by relevance blended with recency,
   penalizing repeated topics, sources, and the over-represented political side — so the feed is
   high-signal *and* varied.
5. **Source-level prior (fallback).** If the model is unreachable or abstains, items keep the
   curated `lean`/`confidence` from `src/data/sources.ts` (cross-referenced against AllSides, Ad
   Fontes, MBFC). The app stays useful even with no LLM running.

The app then applies the **personal layer** in `src/lib/buildFeed.ts`: your daily quota and the
50/50 left/right counter-weight based on what you've already consumed today.

## Tech

- **Expo (SDK 51) + React Native + TypeScript**, file-based routing via `expo-router`.
- **Backend:** Node + Express (run with `tsx`), generic OpenAI-compatible LLM client.
- **Local persistence:** `@react-native-async-storage/async-storage`.
- **Feeds:** native `fetch` + `fast-xml-parser` (RSS 2.0, Atom, YouTube media RSS).

## Project layout

```
app/                      expo-router screens
  _layout.tsx             root (providers + stack)
  index.tsx               onboarding gate / redirect
  onboarding.tsx          quota + topics + kinds
  (tabs)/index.tsx        Today — quota bar, lean dial, balanced feed
  (tabs)/balance.tsx      Balance — lean dials + feed mix + topic diversity
  (tabs)/settings.tsx     quota, topics, drift sensitivity, AI tagging, data
src/
  data/sources.ts         curated, balanced source registry
  lib/buildFeed.ts        the feed engine (50/50 + counter-weight + diversity)
  lib/lean.ts             lean buckets, drift assessment, consumed-lean tally
  lib/duration.ts         consume-time estimation
  lib/rss.ts              fetch + parse + normalize feeds
  lib/llm.ts              optional opt-in item-level lean refinement
  storage/storage.ts      AsyncStorage + daily rollover + 30-day history
  lib/api.ts              client to the backend feed API
  store/AppContext.tsx    app state wiring
  components/             FeedCard, meters (quota + lean dial), ui atoms
server/
  index.ts                Express API: /api/feed, /api/health, /api/refresh
  config.ts               env-driven config (.env supported)
  ai.ts                   OpenAI-compatible batched enrichment client
  rank.ts                 pure relevance + diversity ranker
  feedService.ts          fetch -> enrich -> rank -> cache orchestration
__tests__/                pure-logic unit tests (buildFeed, lean, duration, rank)
```

## Getting started

This project uses the corporate Nexus npm registry (`.npmrc`). Use Node via nvm:

```bash
nvm use 20            # or any Node 18/20 LTS
npm install
```

Run the **backend** and the **app** in two terminals:

```bash
# 1. Start your local model server (LM Studio / Ollama / …) and load a model.
# 2. Configure + run the backend:
cp .env.example .env  # set AI_BASE_URL / AI_MODEL for your runtime
npm run server        # http://localhost:8787  (tsx watch)
# 3. Run the app:
npm run web           # or: npm start, then press i / a / scan QR
```

The app talks to the backend at `http://localhost:8787` by default; override with
`EXPO_PUBLIC_API_URL`. Backend tuning (model, batch size, concurrency, cache TTL) lives in `.env`
— see `.env.example`.

### Corporate TLS interception

This machine sits behind a TLS-intercepting proxy, so Node (which ships its own CA list) fails
feed fetches with `SELF_SIGNED_CERT_IN_CHAIN` even though your browser works. Fix it one of two
ways before running the backend:

```bash
# SECURE (recommended): trust your corporate root CA
export NODE_EXTRA_CA_CERTS=/path/to/corporate-root-ca.pem
# DEV-ONLY: disable TLS verification (insecure; local use only)
# set ALLOW_INSECURE_TLS=1 in .env
```

The same two settings also drive **yt-dlp** (used for YouTube transcripts): with
`NODE_EXTRA_CA_CERTS` the backend passes the CA to yt-dlp via `SSL_CERT_FILE`; with
`ALLOW_INSECURE_TLS=1` it adds `--no-check-certificates`. Install yt-dlp with
`brew install yt-dlp`, `python3 -m pip install -U yt-dlp`, or the standalone binary from its
GitHub releases. Transcripts degrade gracefully (description-only) if yt-dlp is missing.

> If you're off the corporate VPN, `npm install` may fail to resolve `nexus-proxy.…`. Connect to
> the VPN (or point `.npmrc` at a reachable registry) and re-run `npm install`.
>
> The `start`/`ios`/`android`/`web` scripts set `EXPO_OFFLINE=1` so Metro doesn't fail against the
> corporate TLS-intercepting proxy when it tries to reach `api.expo.dev`. Use `npm run start:online`
> if you need the remote SDK checks and have a clean cert chain.

### Tests & type-check

```bash
npm test              # jest (pure logic: buildFeed / lean / duration)
npm run typecheck     # tsc --noEmit
```

## Adding or re-rating sources

Edit `src/data/sources.ts`. Each entry needs `kind`, `topic`, a numeric `lean` (or `null` for
non-political), a `confidence`, and a `leanRationale` citing your basis for the rating. Keep the
registry balanced — for any contested topic, include sources spanning the spectrum.

## Notes & caveats

- Lean ratings are approximate and editable; they're a starting point, not gospel.
- Some RSS endpoints change over time; if a source stops loading, update its `url`.
- The backend fetches feeds directly (no CORS). The legacy in-app web CORS-proxy path in
  `src/lib/rss.ts` is retained for reuse/tests but is no longer the primary fetch route.
- Diagnostics: `node scripts/diag-direct.mjs` (direct fetch) and `node scripts/diag-feeds.mjs`
  (via CORS proxies) report per-source reachability and item counts.

## Roadmap

- In-app audio/video playback (v1 opens links externally).
- Trailing-window balance trends and streaks.
- Smarter duration estimates and richer source metadata.
