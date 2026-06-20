// Pure, deterministic ranking + diversification (no I/O, fully unit-testable).
//
// Given AI-enriched items, produce an ordered list that surfaces the most
// RELEVANT content while guaranteeing VARIETY. We use a greedy maximal-marginal-
// relevance style loop: each pick is the candidate with the best base score
// (relevance blended with recency) MINUS penalties for repeating a topic, a
// source, or the politically over-represented side picked so far.

import type { FeedItem } from "../src/types";

export interface RankOptions {
  now?: number;
  /** 0..1 — how much recency matters vs. AI relevance. */
  recencyWeight?: number;
  /** Recency half-life: an item this old scores half the recency points. */
  halfLifeMs?: number;
  /** Score deducted per prior item sharing the same topic. */
  topicPenalty?: number;
  /** Score deducted per prior item from the same source. */
  sourcePenalty?: number;
  /** Score deducted per unit of left/right imbalance when picking a side. */
  sidePenalty?: number;
}

const DEFAULTS: Required<Omit<RankOptions, "now">> = {
  recencyWeight: 0.3,
  halfLifeMs: 24 * 60 * 60 * 1000, // 1 day
  topicPenalty: 0.15,
  sourcePenalty: 0.25,
  sidePenalty: 0.1,
};

type Side = "left" | "right" | "neutral";

function sideOf(lean: number | null): Side {
  if (lean === null || Number.isNaN(lean)) return "neutral";
  if (lean < 0) return "left";
  if (lean > 0) return "right";
  return "neutral"; // exactly-center counts as neutral for balance
}

function relevanceOf(item: FeedItem): number {
  return typeof item.relevance === "number" ? item.relevance : 0.5;
}

/** Base desirability: AI relevance blended with exponential recency decay. */
function baseScore(item: FeedItem, now: number, recencyWeight: number, halfLifeMs: number): number {
  const age = Math.max(0, now - item.publishedAt);
  const recency = Math.pow(2, -age / halfLifeMs); // 1 (fresh) -> 0 (old)
  return (1 - recencyWeight) * relevanceOf(item) + recencyWeight * recency;
}

/** Stable tiebreak: higher base, then newer, then id. */
function tiebreak(a: FeedItem, b: FeedItem, baseA: number, baseB: number): number {
  if (baseB !== baseA) return baseB - baseA;
  if (b.publishedAt !== a.publishedAt) return b.publishedAt - a.publishedAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Rank items for relevance + variety. Pure; returns a new array. `limit` caps
 * the output length (default: all items).
 */
export function rankItems(items: FeedItem[], options: RankOptions = {}, limit?: number): FeedItem[] {
  const o = { ...DEFAULTS, ...options };
  const now = options.now ?? Date.now();

  const pool = items.slice();
  const base = new Map<string, number>();
  for (const it of pool) base.set(it.id, baseScore(it, now, o.recencyWeight, o.halfLifeMs));

  const selected: FeedItem[] = [];
  const topicCount = new Map<string, number>();
  const sourceCount = new Map<string, number>();
  let left = 0;
  let right = 0;

  const max = limit ?? pool.length;
  while (selected.length < max && pool.length > 0) {
    let bestIdx = -1;
    let bestAdj = -Infinity;
    let bestBase = -Infinity;

    for (let i = 0; i < pool.length; i++) {
      const it = pool[i];
      const b = base.get(it.id) ?? 0.5;
      const tPenalty = o.topicPenalty * (topicCount.get(it.topic) ?? 0);
      const sPenalty = o.sourcePenalty * (sourceCount.get(it.sourceId) ?? 0);
      const side = sideOf(it.lean);
      let imbalance = 0;
      if (side === "left") imbalance = Math.max(0, left - right);
      else if (side === "right") imbalance = Math.max(0, right - left);
      const sidePen = o.sidePenalty * imbalance;

      const adj = b - tPenalty - sPenalty - sidePen;
      if (
        adj > bestAdj ||
        (adj === bestAdj && bestIdx !== -1 && tiebreak(it, pool[bestIdx], b, bestBase) < 0)
      ) {
        bestAdj = adj;
        bestBase = b;
        bestIdx = i;
      }
    }

    if (bestIdx === -1) break;
    const chosen = pool.splice(bestIdx, 1)[0];
    selected.push(chosen);
    topicCount.set(chosen.topic, (topicCount.get(chosen.topic) ?? 0) + 1);
    sourceCount.set(chosen.sourceId, (sourceCount.get(chosen.sourceId) ?? 0) + 1);
    const side = sideOf(chosen.lean);
    if (side === "left") left += 1;
    else if (side === "right") right += 1;
  }

  return selected;
}
