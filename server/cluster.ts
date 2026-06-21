// Deterministic same-event clustering for cross-source story synthesis.
//
// Groups articles that cover the SAME event so we can dedupe them and synthesize
// one neutral story per cluster. Pure & side-effect-free (no LLM, no I/O) so it
// is fully unit-testable. Similarity is embedding cosine when vectors are
// available, falling back to title/keyword Jaccard when they aren't — both gated
// by a publish-time window so unrelated articles that merely sound alike (but are
// weeks apart) never merge.

import { cosineSim } from "./embeddings";

/** The minimal shape clustering needs from an analyzed item. */
export interface ClusterInput {
  id: string;
  sourceId: string;
  publishedAt: number;
  topic: string;
  /** 0..1 newsworthiness (drives seed ordering and ranking). */
  importance: number;
  title: string;
  keywords: string[];
  /** Semantic embedding, when available (preferred similarity signal). */
  embedding?: number[];
}

export interface ClusterOptions {
  /** Cosine threshold to join a cluster when embeddings are available. */
  simThreshold: number;
  /** Title/keyword Jaccard threshold used when embeddings are absent. */
  textSimThreshold: number;
  /** Max publish-time gap (ms) between an item and a cluster to join it. */
  windowMs: number;
}

export interface Cluster<T> {
  members: T[];
  /** Mean embedding of members that have one; null in text-only mode. */
  centroid: number[] | null;
}

const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "any", "can", "her",
  "was", "one", "our", "out", "his", "has", "had", "him", "she", "they", "them",
  "their", "this", "that", "with", "from", "have", "will", "would", "could",
  "after", "over", "into", "amid", "says", "say", "said", "new", "how", "why",
  "what", "who", "when", "where", "amid", "than", "then", "its", "it's", "as",
]);

/** Lowercase content tokens (>=3 chars, no stopwords) from a title + keywords. */
export function titleTokens(title: string, keywords: string[] = []): Set<string> {
  const out = new Set<string>();
  const add = (s: string) => {
    for (const tok of s.toLowerCase().split(/[^a-z0-9]+/)) {
      if (tok.length >= 3 && !STOPWORDS.has(tok)) out.add(tok);
    }
  };
  add(title);
  for (const k of keywords) add(k);
  return out;
}

/** Jaccard overlap of two token sets in [0,1]. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

interface WorkingCluster<T extends ClusterInput> {
  members: T[];
  tokens: Set<string>[]; // per-member tokens (text-mode similarity)
  sum: number[] | null; // running vector sum (embedding-mode centroid)
  embeddedCount: number;
  latestAt: number;
  earliestAt: number;
}

function centroidOf<T extends ClusterInput>(c: WorkingCluster<T>): number[] | null {
  if (!c.sum || c.embeddedCount === 0) return null;
  return c.sum.map((v) => v / c.embeddedCount);
}

/** Best similarity of an item to a cluster, honoring the time window. */
function similarity<T extends ClusterInput>(
  item: T,
  itemTokens: Set<string>,
  c: WorkingCluster<T>,
  opts: ClusterOptions,
): { score: number; threshold: number } {
  // Time gate first: too far apart in time -> never the same event.
  const gap = Math.min(
    Math.abs(item.publishedAt - c.latestAt),
    Math.abs(item.publishedAt - c.earliestAt),
  );
  if (gap > opts.windowMs) return { score: -1, threshold: Infinity };

  const centroid = centroidOf(c);
  if (item.embedding && centroid) {
    return { score: cosineSim(item.embedding, centroid), threshold: opts.simThreshold };
  }
  // Text fallback: max Jaccard against any member.
  let best = 0;
  for (const t of c.tokens) best = Math.max(best, jaccard(itemTokens, t));
  return { score: best, threshold: opts.textSimThreshold };
}

/**
 * Greedy, deterministic single-pass clustering. Items are processed
 * importance-first (then newest, then id) so the most newsworthy article seeds
 * each cluster; later items join the best-matching existing cluster above
 * threshold, or start a new one.
 */
export function clusterItems<T extends ClusterInput>(
  items: T[],
  opts: ClusterOptions,
): Cluster<T>[] {
  const sorted = items.slice().sort((a, b) => {
    if (b.importance !== a.importance) return b.importance - a.importance;
    if (b.publishedAt !== a.publishedAt) return b.publishedAt - a.publishedAt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const clusters: WorkingCluster<T>[] = [];
  for (const item of sorted) {
    const tokens = titleTokens(item.title, item.keywords);
    let bestIdx = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < clusters.length; i++) {
      const { score, threshold } = similarity(item, tokens, clusters[i], opts);
      if (score >= threshold && score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    if (bestIdx === -1) {
      clusters.push({
        members: [item],
        tokens: [tokens],
        sum: item.embedding ? item.embedding.slice() : null,
        embeddedCount: item.embedding ? 1 : 0,
        latestAt: item.publishedAt,
        earliestAt: item.publishedAt,
      });
    } else {
      const c = clusters[bestIdx];
      c.members.push(item);
      c.tokens.push(tokens);
      if (item.embedding) {
        if (!c.sum) c.sum = new Array(item.embedding.length).fill(0);
        for (let k = 0; k < item.embedding.length && k < c.sum.length; k++) {
          c.sum[k] += item.embedding[k];
        }
        c.embeddedCount += 1;
      }
      c.latestAt = Math.max(c.latestAt, item.publishedAt);
      c.earliestAt = Math.min(c.earliestAt, item.publishedAt);
    }
  }

  return clusters.map((c) => ({ members: c.members, centroid: centroidOf(c) }));
}

/** Count of DISTINCT sources in a member list (a story needs several outlets). */
export function distinctSources<T extends ClusterInput>(members: T[]): number {
  return new Set(members.map((m) => m.sourceId)).size;
}

/**
 * Rank clusters for synthesis: more outlets first (richer comparison), then
 * higher peak importance, then more recent. Deterministic.
 */
export function rankClusters<T extends ClusterInput>(clusters: Cluster<T>[]): Cluster<T>[] {
  return clusters.slice().sort((a, b) => {
    const sa = distinctSources(a.members);
    const sb = distinctSources(b.members);
    if (sb !== sa) return sb - sa;
    const ia = Math.max(...a.members.map((m) => m.importance), 0);
    const ib = Math.max(...b.members.map((m) => m.importance), 0);
    if (ib !== ia) return ib - ia;
    const la = Math.max(...a.members.map((m) => m.publishedAt), 0);
    const lb = Math.max(...b.members.map((m) => m.publishedAt), 0);
    return lb - la;
  });
}
