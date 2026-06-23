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
  /** Outlets this item REPRESENTS after near-clone dedup (>=1). A deduped wire-copy
   *  representative stands in for its whole group, so coverage counts it as `coveredBy`
   *  outlets even though only one copy is clustered. Absent/1 for a stand-alone item. */
  coveredBy?: number;
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

/** Total OUTLET coverage of a member list. A near-clone REPRESENTATIVE stands in for
 *  its whole group (`coveredBy` outlets), so we count that rather than one — which lets
 *  us DEDUP duplicates out of the cluster (keeping member sets small + stable across
 *  rebuilds) WITHOUT under-counting the many outlets that actually carried the story.
 *  This is what stops a flood of near-clones from churning an ongoing issue's identity
 *  while still letting genuinely multi-source events clear the story thresholds. */
export function coverageOf<T extends ClusterInput>(members: T[]): number {
  let n = 0;
  for (const m of members) n += Math.max(1, m.coveredBy ?? 1);
  return n;
}

/**
 * Rank clusters for synthesis: more outlets first (richer comparison), then
 * higher peak importance, then more recent. Deterministic.
 */
export function rankClusters<T extends ClusterInput>(clusters: Cluster<T>[]): Cluster<T>[] {
  return clusters.slice().sort((a, b) => {
    const sa = coverageOf(a.members);
    const sb = coverageOf(b.members);
    if (sb !== sa) return sb - sa;
    const ia = Math.max(...a.members.map((m) => m.importance), 0);
    const ib = Math.max(...b.members.map((m) => m.importance), 0);
    if (ib !== ia) return ib - ia;
    const la = Math.max(...a.members.map((m) => m.publishedAt), 0);
    const lb = Math.max(...b.members.map((m) => m.publishedAt), 0);
    return lb - la;
  });
}

// ---------------------------------------------------------------------------
// Second level: group same-EVENT clusters into broader ONGOING ISSUES.
//
// A developing issue (e.g. a conflict) spans many distinct sub-events over days
// — strikes, a blockade, peace talks — each of which is its own event cluster.
// We group those clusters with a LOOSER similarity threshold and a WIDER time
// window so the storyline holds together while individual events stay crisp.
// ---------------------------------------------------------------------------

/** A storyline grouping several event clusters that evolve over time. */
export interface Issue<T extends ClusterInput> {
  /** Constituent event clusters, time-ordered (earliest first). */
  clusters: Cluster<T>[];
  /** All members across clusters. */
  members: T[];
  /** Mean embedding across members; null in text-only mode. */
  centroid: number[] | null;
  earliestAt: number;
  latestAt: number;
}

export interface IssueOptions {
  /** Cosine threshold to join an issue (looser than the event threshold). */
  simThreshold: number;
  /** Title/keyword Jaccard threshold used when embeddings are absent. */
  textSimThreshold: number;
  /** Max time gap (ms) between a cluster and an issue's span to join it. */
  windowMs: number;
}

function clusterTokens<T extends ClusterInput>(c: Cluster<T>): Set<string> {
  const out = new Set<string>();
  for (const m of c.members) for (const t of titleTokens(m.title, m.keywords)) out.add(t);
  return out;
}

function span<T extends ClusterInput>(members: T[]): { earliestAt: number; latestAt: number } {
  let earliestAt = Infinity;
  let latestAt = -Infinity;
  for (const m of members) {
    if (m.publishedAt < earliestAt) earliestAt = m.publishedAt;
    if (m.publishedAt > latestAt) latestAt = m.publishedAt;
  }
  return { earliestAt, latestAt };
}

function meanEmbedding<T extends ClusterInput>(members: T[]): number[] | null {
  let sum: number[] | null = null;
  let n = 0;
  for (const m of members) {
    if (!m.embedding) continue;
    if (!sum) sum = new Array(m.embedding.length).fill(0);
    for (let k = 0; k < m.embedding.length && k < sum.length; k++) sum[k] += m.embedding[k];
    n += 1;
  }
  return sum && n > 0 ? sum.map((v) => v / n) : null;
}

interface WorkingIssue<T extends ClusterInput> {
  clusters: Cluster<T>[];
  tokens: Set<string>;
  earliestAt: number;
  latestAt: number;
}

/**
 * Greedy second-level grouping of event clusters into issues. Clusters are
 * processed largest-first (most outlets) so the dominant storyline seeds each
 * issue. A cluster joins the best issue above threshold AND within the (wide)
 * time window, else starts a new one.
 */
export function groupIntoIssues<T extends ClusterInput>(
  clusters: Cluster<T>[],
  opts: IssueOptions,
): Issue<T>[] {
  const ordered = clusters.slice().sort((a, b) => {
    const sa = coverageOf(a.members);
    const sb = coverageOf(b.members);
    if (sb !== sa) return sb - sa;
    return Math.max(...b.members.map((m) => m.publishedAt)) -
      Math.max(...a.members.map((m) => m.publishedAt));
  });

  const issues: WorkingIssue<T>[] = [];
  for (const c of ordered) {
    const toks = clusterTokens(c);
    const cSpan = span(c.members);
    let bestIdx = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < issues.length; i++) {
      const iss = issues[i];
      // Time gate: the cluster must fall within `windowMs` of the issue's span.
      const gap = Math.max(0, Math.max(cSpan.earliestAt, iss.earliestAt) - Math.min(cSpan.latestAt, iss.latestAt));
      if (gap > opts.windowMs) continue;

      const issMembers = iss.clusters.flatMap((x) => x.members);
      const ce = meanEmbedding(c.members);
      const ie = meanEmbedding(issMembers);
      let score: number;
      let threshold: number;
      if (ce && ie) {
        score = cosineSim(ce, ie);
        threshold = opts.simThreshold;
      } else {
        score = jaccard(toks, iss.tokens);
        threshold = opts.textSimThreshold;
      }
      if (score >= threshold && score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    if (bestIdx === -1) {
      issues.push({ clusters: [c], tokens: toks, earliestAt: cSpan.earliestAt, latestAt: cSpan.latestAt });
    } else {
      const iss = issues[bestIdx];
      iss.clusters.push(c);
      for (const t of toks) iss.tokens.add(t);
      iss.earliestAt = Math.min(iss.earliestAt, cSpan.earliestAt);
      iss.latestAt = Math.max(iss.latestAt, cSpan.latestAt);
    }
  }

  return issues.map((iss) => {
    const members = iss.clusters.flatMap((c) => c.members);
    const clustersByTime = iss.clusters
      .slice()
      .sort((a, b) => span(a.members).earliestAt - span(b.members).earliestAt);
    return {
      clusters: clustersByTime,
      members,
      centroid: meanEmbedding(members),
      earliestAt: iss.earliestAt,
      latestAt: iss.latestAt,
    };
  });
}

export interface DevelopingOptions {
  /** Minimum elapsed time the issue must span (ms). */
  minSpanMs: number;
  /** Minimum number of distinct sub-events (clusters). */
  minEvents: number;
  /** Minimum number of distinct sources across the issue. */
  minSources: number;
  /** The issue must have new coverage within this recency window (ms). */
  activeMs: number;
  /** "Now" for the recency check (injectable for tests). */
  now?: number;
}

/**
 * Heuristic gate for an ONGOING/DEVELOPING issue: it must span enough time,
 * contain several distinct sub-events from multiple outlets, and still be
 * receiving fresh coverage. (An LLM later confirms developing-vs-resolved.)
 */
export function isDevelopingIssue<T extends ClusterInput>(
  issue: Issue<T>,
  opts: DevelopingOptions,
): boolean {
  const now = opts.now ?? Date.now();
  const issueSpan = issue.latestAt - issue.earliestAt;
  return (
    issue.clusters.length >= opts.minEvents &&
    issueSpan >= opts.minSpanMs &&
    coverageOf(issue.members) >= opts.minSources &&
    now - issue.latestAt <= opts.activeMs
  );
}
