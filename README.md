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

## How content is tagged

1. **Source-level prior (default).** Each source in `src/data/sources.ts` is tagged once with a
   numeric `lean` (`-1` far-left → `0` center → `+1` far-right) + `confidence`, cross-referenced
   against published media-bias data (AllSides, Ad Fontes Media, Media Bias/Fact Check) with a
   short `leanRationale`. Items inherit their source's lean.
2. **Non-political content** (science, history, tech) is tagged `lean: null` and is excluded from
   the left/right math — it only contributes to topic diversity.
3. **Optional AI refinement (opt-in).** In Settings you can enable an LLM pass (needs your own
   OpenAI-compatible API key) that classifies each item individually and overrides the source
   prior. Results are cached. The model has its own biases — treat AI tags as a second opinion.

## Tech

- **Expo (SDK 51) + React Native + TypeScript**, file-based routing via `expo-router`.
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
  store/AppContext.tsx    app state wiring
  components/             FeedCard, meters (quota + lean dial), ui atoms
__tests__/                pure-logic unit tests (buildFeed, lean, duration)
```

## Getting started

This project uses the corporate Nexus npm registry (`.npmrc`). Use Node via nvm:

```bash
nvm use 20            # or any Node 18/20 LTS
npm install
npm start             # then press i / a, or scan the QR with Expo Go
```

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
- On Expo **web**, direct RSS fetches are proxied through a public CORS proxy (see `src/lib/rss.ts`);
  on native there's no CORS restriction.

## Roadmap

- In-app audio/video playback (v1 opens links externally).
- Trailing-window balance trends and streaks.
- Smarter duration estimates and richer source metadata.
