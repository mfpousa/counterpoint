// Pure, deterministic per-provider fair ordering (no I/O — unit-testable).
//
// Round-robin interleave so NO single source dominates the feed: each provider's
// items are sorted best-first by the caller's comparator, then we emit in ROUNDS
// — round k contains every provider's k-th best item — and within a round the
// items are ordered by the same comparator (so the most important lead). This
// guarantees a prolific provider can't stack many items ahead of others: its
// m-th best item can only appear after every other provider has had m-1 turns.

/**
 * Interleave `items` across providers for variety.
 *
 * @param keyOf   the provider key for an item (e.g. its sourceId).
 * @param compare best-first ordering WITHIN a provider AND across each round's
 *                heads (return <0 when `a` should rank before `b`).
 * @param opts.perSourceCap optional hard cap on items kept per provider.
 */
export function interleaveByProvider<T>(
  items: T[],
  keyOf: (it: T) => string,
  compare: (a: T, b: T) => number,
  opts: { perSourceCap?: number } = {},
): T[] {
  if (items.length <= 1) return items.slice();

  const groups = new Map<string, T[]>();
  for (const it of items) {
    const k = keyOf(it);
    const g = groups.get(k);
    if (g) g.push(it);
    else groups.set(k, [it]);
  }

  const cap = opts.perSourceCap && opts.perSourceCap > 0 ? opts.perSourceCap : 0;
  for (const [k, g] of groups) {
    g.sort(compare);
    if (cap && g.length > cap) groups.set(k, g.slice(0, cap));
  }

  const result: T[] = [];
  let remaining = true;
  while (remaining) {
    remaining = false;
    const heads: T[] = [];
    for (const g of groups.values()) {
      const it = g.shift();
      if (it !== undefined) {
        heads.push(it);
        if (g.length > 0) remaining = true;
      }
    }
    // Stable sort keeps first-seen providers ahead on ties — deterministic.
    heads.sort(compare);
    for (const h of heads) result.push(h);
  }
  return result;
}

/**
 * Recency-first ordering: group items into fixed-width time BUCKETS by age and
 * emit the FRESHEST bucket first, stepping backwards in time. Within each bucket,
 * items are interleaved per-provider (round-robin) using `compare`. This makes
 * very recent news lead the feed/backlog while still spreading coverage across
 * outlets and importance WITHIN a time band — rather than letting one provider's
 * older-but-important stories jump ahead of everyone's fresh ones.
 *
 * @param ageMsOf  age of an item in ms (now - publishedAt); negative is treated as 0.
 * @param bucketMs bucket width in ms (e.g. 2h). Must be > 0.
 */
export function interleaveByRecencyBuckets<T>(
  items: T[],
  ageMsOf: (it: T) => number,
  keyOf: (it: T) => string,
  compare: (a: T, b: T) => number,
  bucketMs: number,
): T[] {
  if (items.length <= 1) return items.slice();
  const width = bucketMs > 0 ? bucketMs : 1;

  const byBucket = new Map<number, T[]>();
  for (const it of items) {
    const bucket = Math.max(0, Math.floor(Math.max(0, ageMsOf(it)) / width));
    const g = byBucket.get(bucket);
    if (g) g.push(it);
    else byBucket.set(bucket, [it]);
  }

  const result: T[] = [];
  // Ascending bucket index = freshest first.
  for (const bucket of [...byBucket.keys()].sort((a, b) => a - b)) {
    result.push(...interleaveByProvider(byBucket.get(bucket) as T[], keyOf, compare));
  }
  return result;
}
