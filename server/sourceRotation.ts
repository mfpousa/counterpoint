// Per-world SOURCE ROTATION. Re-pulling every feed on every refresh is wasteful: a
// world has dozens of sources, most unchanged hour to hour, and we can only analyze a
// fraction of what we fetch. Instead, each warm refresh fetches a random SUBSET (a
// "budget") of the sources, dealt from a shuffled DECK so that successive refreshes get
// a DIFFERENT subset with NO repeats until every source has been fetched once; only then
// is the deck reshuffled for the next cycle. This spreads fetch cost/bytes over time
// while still covering every source across a handful of refreshes.
//
// Pure + deterministic given an rng, so it's unit-testable in isolation.

export interface RotationState {
  /** Remaining (shuffled) source ids still undealt in the current cycle. */
  queue: string[];
  /** Signature of the id-set the current deck was built from; if the world's source
   *  set changes, the deck is rebuilt so we never deal a stale/removed source. */
  sig: string;
}

export function createRotation(): RotationState {
  return { queue: [], sig: "" };
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
 * Deal the next rotating subset of up to `budget` ids.
 *
 * Guarantees within a cycle (one full pass of the deck): every id is dealt exactly
 * once before any id repeats. The deck reshuffles only when exhausted, so consecutive
 * refreshes see different subsets. A `budget` of 0 (or >= the number of ids) disables
 * rotation and returns ALL ids — used for cold starts that must seed the whole pool.
 *
 * Mutates `state` (consumes from its queue / reshuffles as needed).
 */
export function dealNextBatch(
  state: RotationState,
  ids: readonly string[],
  budget: number,
  rng: () => number = Math.random,
): string[] {
  if (ids.length === 0) return [];
  if (budget <= 0 || budget >= ids.length) return ids.slice();

  const sig = signatureOf(ids);
  if (sig !== state.sig) {
    // First use, or the world's source set changed — start a fresh deck.
    state.sig = sig;
    state.queue = shuffle(ids, rng);
  }
  if (state.queue.length === 0) {
    // Previous cycle fully dealt — reshuffle for a new cycle.
    state.queue = shuffle(ids, rng);
  }
  return state.queue.splice(0, budget);
}
