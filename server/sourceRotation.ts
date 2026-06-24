// Per-world SOURCE ROTATION. Re-pulling every feed on every refresh is wasteful: a world
// can have hundreds of sources, most unchanged minute to minute, and we can only analyze a
// fraction of what we fetch. Each refresh therefore fetches a SUBSET (a "budget") of the
// sources, split into two halves:
//
//   • FRESH (no-repeat): dealt from a shuffled DECK so successive refreshes get a DIFFERENT
//     subset with NO repeats until every source has been fetched once, then the deck
//     reshuffles. This gives BREADTH — every source is visited once per cycle.
//   • REPEAT (on purpose): already-seen sources, LEAST-recently-fetched first. With many
//     sources, fresh-only rotation only ever samples each source's most-recent items (and
//     the prescreen queue is replaced each refresh), so older articles get starved. Re-
//     fetching keeps moving through time — catching what a source published since we last
//     saw it and giving earlier items another chance to be analyzed.
//
// `repeatRatio` sets the split (0 = pure rotation; ~0.5–0.8 = balance recent vs. catch-up).
// Pure + deterministic given an rng, so it's unit-testable in isolation.

export interface RotationState {
  /** Remaining (shuffled) source ids still undealt in the current FRESH cycle. */
  queue: string[];
  /** Signature of the id-set the current deck was built from; if the world's source
   *  set changes, the deck (and seen-history) is rebuilt so we never deal a stale id. */
  sig: string;
  /** id -> sequence number of the last refresh that dealt it. Drives REPEAT ordering
   *  (least-recently-dealt first) so repeats sweep the sources we've not touched longest. */
  seen: Map<string, number>;
  /** Monotonic refresh counter, stamped onto every dealt id via `seen`. */
  seq: number;
}

export function createRotation(): RotationState {
  return { queue: [], sig: "", seen: new Map(), seq: 0 };
}

/** Fisher-Yates on a COPY (never mutates the input). */
function shuffle(ids: readonly string[], rng: () => number): string[] {
  const a = ids.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function signatureOf(ids: readonly string[]): string {
  return [...ids].sort().join("\u0000");
}

/**
 * Deal the next subset of up to `budget` ids, split into FRESH (no-repeat, from the
 * shuffled deck) and REPEAT (already-seen, least-recently-dealt first) per `repeatRatio`.
 *
 *  - FRESH guarantees breadth: within a cycle (one full pass of the deck) every id is
 *    dealt once before any fresh repeat; the deck reshuffles only when exhausted.
 *  - REPEAT gives time-depth: re-fetching the sources we've not touched longest keeps the
 *    pipeline moving through time instead of only ever sampling the present.
 *
 * Early on (few sources seen) the repeat pool is small, so the unused budget falls back to
 * FRESH. `budget` of 0 (or >= the id count) disables rotation and returns ALL ids.
 *
 * Mutates `state`. Pure given `opts.rng`.
 */
export function dealNextBatch(
  state: RotationState,
  ids: readonly string[],
  budget: number,
  opts: { repeatRatio?: number; rng?: () => number } = {},
): string[] {
  const rng = opts.rng ?? Math.random;
  const repeatRatio = Math.min(1, Math.max(0, opts.repeatRatio ?? 0));
  if (ids.length === 0) return [];
  if (budget <= 0 || budget >= ids.length) return ids.slice();

  const sig = signatureOf(ids);
  if (sig !== state.sig) {
    // First use, or the source set changed — rebuild the deck AND the seen-history.
    state.sig = sig;
    state.queue = shuffle(ids, rng);
    state.seen = new Map();
    state.seq = 0;
  }

  const idSet = new Set(ids);

  // Pull `n` FRESH ids from the deck, reshuffling for a new cycle when it empties. `exclude`
  // avoids dealing an id already picked this refresh. Bounded so a degenerate deck can't spin.
  const dealFresh = (n: number, exclude: Set<string>): string[] => {
    const out: string[] = [];
    let guard = ids.length * 2 + budget;
    while (out.length < n && guard-- > 0) {
      if (state.queue.length === 0) state.queue = shuffle(ids, rng);
      const id = state.queue.shift()!;
      if (idSet.has(id) && !exclude.has(id)) out.push(id);
    }
    return out;
  };

  const repeatN = Math.min(budget, Math.round(budget * repeatRatio));
  const freshN = budget - repeatN;
  const picked = new Set<string>();

  // FRESH first — advance the deck (breadth).
  for (const id of dealFresh(freshN, picked)) picked.add(id);

  // REPEAT — least-recently-dealt already-seen sources (time-depth).
  if (repeatN > 0) {
    const repeatPool = [...state.seen.entries()]
      .filter(([id]) => idSet.has(id) && !picked.has(id))
      .sort((a, b) => a[1] - b[1])
      .map(([id]) => id);
    for (const id of repeatPool.slice(0, repeatN)) {
      picked.add(id);
      // If it was still queued for its fresh turn this cycle, drop it so we don't fetch the
      // same source twice in one cycle (the repeat already covers it).
      const qi = state.queue.indexOf(id);
      if (qi >= 0) state.queue.splice(qi, 1);
    }
  }

  // Not enough seen sources to repeat yet — spend the remainder on more FRESH.
  const deficit = budget - picked.size;
  if (deficit > 0) for (const id of dealFresh(deficit, picked)) picked.add(id);

  // Stamp every dealt id with this refresh's sequence for next time's repeat ordering.
  state.seq += 1;
  for (const id of picked) state.seen.set(id, state.seq);

  return [...picked];
}
