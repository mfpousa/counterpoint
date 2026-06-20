// The LOCAL half of the (hybrid) knowledge profile. From the reader's graded
// recall summaries we compute, deterministically and offline:
//   - per-topic mastery (how well they recall what they've read),
//   - "weak topics": poorly recalled OR barely covered (the gaps), and
//   - "weak concepts": phrases the AI repeatedly flagged as missed/inaccurate.
// We then shortlist pool items that target those gaps. The AI layer
// (server/knowledge.ts) only writes the narrative + per-suggestion reasons.

import type { FeedItem, KnowledgeProfile, StoredSummary, Topic, TopicMastery } from "../types";
import { TOPIC_ORDER } from "./topics";

/** Scores at/above this (0..100) count as "well recalled". */
export const PASS_SCORE = 70;

const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "any", "was", "its", "with", "from",
  "this", "that", "their", "what", "when", "more", "about", "into", "than", "then", "they",
  "have", "has", "had", "will", "would", "could", "should", "which", "while", "your", "over",
  "a", "an", "of", "to", "in", "is", "it", "on", "as", "at", "by", "or", "be", "we", "do", "how",
]);

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (w) => w.length >= 4 && !STOPWORDS.has(w),
  );
}

/**
 * Roll graded summaries up into a knowledge profile. A topic is "weak" when its
 * mean score is below PASS_SCORE; topics the reader has barely touched are also
 * surfaced as gaps so the feed can broaden their coverage.
 */
export function computeProfile(summaries: StoredSummary[]): KnowledgeProfile {
  const byTopic = new Map<Topic, { sum: number; count: number }>();
  for (const s of summaries) {
    const t = byTopic.get(s.topic) ?? { sum: 0, count: 0 };
    t.sum += s.grade.score;
    t.count += 1;
    byTopic.set(s.topic, t);
  }

  const topics: TopicMastery[] = [...byTopic.entries()]
    .map(([topic, { sum, count }]) => ({ topic, count, avgScore: Math.round(sum / count) }))
    .sort((a, b) => b.count - a.count);

  // Gaps = topics recalled below the pass mark, plus topics never (or barely)
  // covered relative to the reader's typical activity.
  const covered = new Set(topics.map((t) => t.topic));
  const poorlyRecalled = topics.filter((t) => t.avgScore < PASS_SCORE).map((t) => t.topic);
  const uncovered = TOPIC_ORDER.filter((t) => !covered.has(t));
  const weakTopics = [...new Set([...poorlyRecalled, ...uncovered])];

  // Weak concepts: most-frequent tokens across what the AI said the reader
  // missed or got wrong (the recurring blind spots).
  const freq = new Map<string, number>();
  for (const s of summaries) {
    for (const phrase of [...s.grade.missed, ...s.grade.inaccuracies]) {
      for (const tok of tokenize(phrase)) freq.set(tok, (freq.get(tok) ?? 0) + 1);
    }
  }
  const weakConcepts = [...freq.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([w]) => w);

  const totalGraded = summaries.length;
  const avgScore =
    totalGraded > 0
      ? Math.round(summaries.reduce((acc, s) => acc + s.grade.score, 0) / totalGraded)
      : 0;

  return { totalGraded, avgScore, topics, weakTopics, weakConcepts };
}

/**
 * Shortlist pool items that fill the reader's gaps: prefer weak/uncovered topics
 * and items whose text touches a weak concept; never re-suggest something already
 * summarized. Returns at most `limit` candidates for the AI to rank + explain.
 */
export function pickCandidates(
  pool: FeedItem[],
  profile: KnowledgeProfile,
  summaries: StoredSummary[],
  limit = 12,
): FeedItem[] {
  const seen = new Set(summaries.map((s) => s.id));
  const weakTopics = new Set(profile.weakTopics);
  const concepts = profile.weakConcepts;

  const scored = pool
    .filter((it) => !seen.has(it.id))
    .map((it) => {
      let score = 0;
      if (weakTopics.has(it.topic)) score += 3;
      const hay = `${it.title} ${it.summary}`.toLowerCase();
      for (const c of concepts) if (hay.includes(c)) score += 1;
      // Light tie-break toward higher-importance items.
      score += (it.relevance ?? 0) * 0.5;
      return { it, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map((x) => x.it);
}
