// PRE-ANALYSIS near-clone deduplication.
//
// Local + national outlets run huge amounts of identical or near-identical wire
// copy (the same agency story republished verbatim). Deep-analyzing every copy
// is pure waste on a token-bound model. This module groups near-clones BEFORE
// the expensive pass so we can analyze ONE representative per cluster and fan its
// analysis out to the rest.
//
// It is deliberately PURE (no LLM, no embeddings, no I/O): pre-analysis we only
// have the RSS title + summary, so similarity is title+summary token Jaccard —
// the same primitive `cluster.ts` falls back to. A tight publish-time window
// stops unrelated items that merely share vocabulary (weeks apart) from merging.

import { jaccard, titleTokens } from "./cluster";

/** The minimal shape dedup needs from an un-analyzed item. */
export interface DedupeInput {
  id: string;
  sourceId: string;
  title: string;
  summary: string;
  publishedAt: number;
  /** Coarse prescreen importance (0..1), when known — biases representative pick. */
  importance?: number;
}

export interface DedupeOptions {
  /** Min title+summary Jaccard to treat two items as the SAME story. */
  jaccardThreshold: number;
  /** Max publish-time gap (ms) for two items to be considered clones. */
  windowMs: number;
}

export interface DedupeCluster {
  /** The item we deep-analyze; its analysis is fanned out to the rest. */
  representativeId: string;
  /** All member ids (INCLUDING the representative). */
  memberIds: string[];
  /** Distinct sources covering this story (>=1). Drives "covered by N outlets". */
  sourceCount: number;
}

/** Token signature of an item: the TITLE, stopword-filtered. Wire clones share
 *  their headline almost verbatim, while each outlet edits the summary
 *  differently — so keying on the title is both the strongest clone signal and
 *  the most robust to the noisy/empty RSS summaries we have pre-analysis. (The
 *  summary is still used to pick the richest representative below.) */
function signature(item: DedupeInput): Set<string> {
  return titleTokens(item.title);
}

interface Working {
  members: DedupeInput[];
  tokens: Set<string>[];
  earliestAt: number;
  latestAt: number;
}

/** Best Jaccard of an item against any member of a cluster, honoring the window. */
function bestScore(
  item: DedupeInput,
  itemTokens: Set<string>,
  c: Working,
  windowMs: number,
): number {
  const gap = Math.min(
    Math.abs(item.publishedAt - c.latestAt),
    Math.abs(item.publishedAt - c.earliestAt),
  );
  if (gap > windowMs) return -1;
  let best = 0;
  for (const t of c.tokens) best = Math.max(best, jaccard(itemTokens, t));
  return best;
}

/**
 * Pick the representative of a cluster: the copy most worth analyzing. Highest
 * coarse importance, then the richest summary (longest, a proxy for the most
 * complete write-up), then the earliest to publish (first to report), then id —
 * fully deterministic so a given pool always yields the same representative.
 */
function pickRepresentative(members: DedupeInput[]): DedupeInput {
  return members.slice().sort((a, b) => {
    const ia = a.importance ?? 0.5;
    const ib = b.importance ?? 0.5;
    if (ib !== ia) return ib - ia;
    if (b.summary.length !== a.summary.length) return b.summary.length - a.summary.length;
    if (a.publishedAt !== b.publishedAt) return a.publishedAt - b.publishedAt;
    return a.id < b.id ? -1 : 1;
  })[0];
}

/**
 * Group near-clone items into clusters. Greedy single pass: each item joins the
 * best existing cluster above threshold (within the time window) or starts a new
 * one. Processing order is importance-first then earliest, so the strongest copy
 * tends to seed each cluster. Pure & deterministic.
 *
 * Every input id appears in exactly one returned cluster (singletons included),
 * so callers can rely on the clusters being a complete partition of the input.
 */
export function dedupeNearClones(
  items: DedupeInput[],
  opts: DedupeOptions,
): DedupeCluster[] {
  const sorted = items.slice().sort((a, b) => {
    const ia = a.importance ?? 0.5;
    const ib = b.importance ?? 0.5;
    if (ib !== ia) return ib - ia;
    if (a.publishedAt !== b.publishedAt) return a.publishedAt - b.publishedAt;
    return a.id < b.id ? -1 : 1;
  });

  const clusters: Working[] = [];
  for (const item of sorted) {
    const tokens = signature(item);
    let bestIdx = -1;
    let best = -Infinity;
    for (let i = 0; i < clusters.length; i++) {
      const score = bestScore(item, tokens, clusters[i], opts.windowMs);
      if (score >= opts.jaccardThreshold && score > best) {
        best = score;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) {
      clusters.push({
        members: [item],
        tokens: [tokens],
        earliestAt: item.publishedAt,
        latestAt: item.publishedAt,
      });
    } else {
      const c = clusters[bestIdx];
      c.members.push(item);
      c.tokens.push(tokens);
      c.earliestAt = Math.min(c.earliestAt, item.publishedAt);
      c.latestAt = Math.max(c.latestAt, item.publishedAt);
    }
  }

  return clusters.map((c) => {
    const rep = pickRepresentative(c.members);
    return {
      representativeId: rep.id,
      memberIds: c.members.map((m) => m.id),
      sourceCount: new Set(c.members.map((m) => m.sourceId)).size,
    };
  });
}
