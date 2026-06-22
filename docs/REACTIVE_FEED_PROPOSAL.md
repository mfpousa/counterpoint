# Proposal: Reactive News Loading

**Goal:** the feed becomes usable in **seconds**, not minutes/hours. The reader
never waits on the full corpus to parse. Headlines appear immediately and
upgrade in place as the model finishes analyzing them, streamed (not polled).

---

## 1. How loading works today

The backend pipeline (`server/feedService.ts`) is already chunked and
background-drained:

```
fetchAll(sources)                       (network, all feeds)
  -> triage / prescreen (cheap, title-only: clickbait + coarse importance)
  -> store items as PENDING (analyzed: false)
  -> analyzePending(): deep-analyze ONE chunk of AI_MAX_ITEMS (default 200)
  -> scheduleCatchUp(): drain the rest in the background, holding a GLOBAL lock
  -> embedPending() + augmentReactively() (YouTube, intl zones)
```

On the client (`src/store/AppContext.tsx`):

- `refreshFeed()` shows a loading banner and calls `GET /api/feed`.
- A **3s status poll** watches `analyzed`; when it grows, `reloadPool()` silently
  re-fetches the whole feed so new items appear.
- `ensurePool()` blocks the request **only on a cold start** (empty store);
  otherwise it serves what exists and rebuilds in the background.

So the foundation for reactivity exists. The problem is **where it still
blocks** and **how coarse the increments are**.

---

## 2. Root causes of the wait

- **`assembleView()` requires `s.analyzed === true`** (`feedService.ts` ~L1190).
  Items that are fetched and triaged but not yet deep-analyzed are **invisible**.
  The reader waits for the LLM even though we already have the headline, source,
  lean prior, and a coarse importance from the cheap triage pass.
- **Cold start blocks on the first full chunk.** `AI_MAX_ITEMS = 200` items
  through a local model at `AI_CONCURRENCY = 2` can be **many minutes** before
  the first response returns.
- **Polling, not pushing.** The 3s poll + full-feed re-fetch adds latency and
  redundant work; updates land in 3s steps and re-rank the entire pool each time.
- **GLOBAL single-build lock.** Only one world analyzes at a time
  (`buildingWorld`), so switching worlds during a long drain serves stale/empty
  data and reports `busyWith`.
- **All-or-nothing increments.** A chunk of 200 is one visible step; the reader
  sees nothing improve until the whole chunk lands.

---

## 3. Proposed model: progressive enrichment + streaming

Two principles:

1. **Show immediately, enrich in place.** Render provisional cards from the
   cheap triage data the instant they're fetched; replace each card's fields as
   deep analysis arrives. Nothing user-visible blocks on the deep model.
2. **Push deltas, don't poll snapshots.** Stream newly-enriched items to the
   client over SSE as each small chunk completes.

### Item lifecycle (visible state machine)

```
fetched  -> triaged (provisional: title, source, lean prior, coarse importance)
         -> analyzed (topic, summary, refined lean, importance, keywords)
         -> embedded (semantic match / related / stories)
```

The feed renders from `triaged` onward; later stages **upgrade** the same card.

---

## 4. Concrete changes

### Backend

- **B1. Serve provisional items.** Add an `includePending` path to
  `assembleView()` that, when the analyzed pool is thin, also emits triaged-only
  items ranked by `prescreenImportance` + recency, each tagged
  `enrichment: "provisional"`. Deep-analyzed items always outrank provisional
  ones. *(Smallest change with the biggest perceived win.)*

- **B2. Time-to-first-content chunking.** Make the **first** chunk tiny and
  importance-ordered so a cold start returns in seconds, then grow:
  `AI_FIRST_CHUNK = 12`, ramping to `AI_MAX_ITEMS`. `pendingForAnalysis()`
  already returns importance-sorted backlog — analyze the top of it first.

- **B3. Stream feed deltas (SSE).** Add `GET /api/feed/stream?world=&interest=`
  that emits events as each chunk lands. Reuse the existing SSE pattern from
  `/api/briefing/stream` and `/api/rewrite/stream`:
  - `event: snapshot` — the initial ranked feed (provisional + analyzed).
  - `event: items` — the just-enriched items (id + upgraded fields) per chunk.
  - `event: status` — `{ phase, analyzed, pending }` for the progress UI.
  - `event: done` — backlog drained.
  This replaces the 3s poll with push and avoids full-feed re-fetches.

- **B4. Priority queue for analysis.** Bias `pendingForAnalysis()` ordering by:
  (1) coarse importance, (2) match to the reader's current `interest` (cheap
  keyword overlap is enough pre-embedding), (3) recency. So what the reader
  asked for enriches first instead of in arbitrary newest-first order.

- **B5. Relax the global lock (phase 2).** Replace the single `buildingWorld`
  lock with a small **concurrency budget** (e.g. 1 foreground + 1 background
  world) or a shared work queue, so switching worlds gets an immediate fast
  first chunk instead of `busyWith`. Keep total model concurrency bounded by
  `AI_CONCURRENCY`.

### Client

- **C1. Consume the SSE stream.** In `AppContext`, open the feed stream instead
  of polling: apply `snapshot`, then merge `items` deltas into `pool` by id
  (in-place upgrade — no flash, no scroll jump), drive the progress banner from
  `status`, close on `done`. Fall back to the existing poll if SSE is
  unavailable.

- **C2. Render provisional cards.** Show triaged cards with a subtle
  "analyzing…" affordance (shimmer on the summary/lean area). When the upgraded
  fields arrive via the stream, swap them in. `buildFeed` already tolerates
  un-enriched items (`relevanceOf` defaults to 0.5).

- **C3. Stable ordering during upgrades.** Merge by id and keep positions
  stable; only re-rank on explicit refresh or interest change so cards don't
  jump under the reader's thumb as analysis lands.

---

## 5. Phasing

- **Phase 1 (fast win, low risk):** B1 + B2 + C2. Feed shows headlines in
  seconds and fills in via the existing 3s poll. No new endpoint.
- **Phase 2 (responsiveness):** B3 + C1 + C3. Replace polling with SSE push.
- **Phase 3 (relevance + multi-world):** B4 + B5.

Each phase ships independently and is gated behind config flags
(`FEED_SERVE_PROVISIONAL`, `AI_FIRST_CHUNK`, `FEED_STREAM`) so we can A/B and
roll back cleanly.

---

## 6. Risks & mitigations

- **Provisional cards look incomplete.** Mitigate with a clear "analyzing"
  state and by only showing provisional items when the analyzed pool is thin.
- **Lean/relevance not yet known.** Use the curated source-level lean prior
  (already on every item) and neutral 0.5 relevance until refined — exactly
  what `buildFeed` assumes today.
- **SSE connection churn / proxies.** Keep the poll fallback (C1) and the
  existing no-buffering headers used by the other SSE routes.
- **Re-ranking jumps.** Solved by C3 (merge-by-id, re-rank only on explicit
  actions).
- **Relaxing the global lock could overload the local model.** Bound by a
  shared `AI_CONCURRENCY` semaphore, not per-world.

---

## 7. Expected outcome

- **Cold start:** first headlines in **~1-3s** (provisional), first deep
  summaries in **seconds** (tiny first chunk) instead of minutes.
- **Steady state:** the feed fills in smoothly and continuously via push; the
  reader never waits for the full corpus.
- **World switches:** immediate fast first chunk instead of a `busyWith` wait.
