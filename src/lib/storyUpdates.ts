// "What changed since you last saw it" — pure helpers comparing a live Story to
// the reader's last-viewed snapshot (StoryView). No I/O, so they're trivially
// testable and reused by the StoryCard indicator, the "last minute" section, and
// the story panel's new-milestone highlighting.

import type { Story, StoryMilestone, StoryView } from "../types";

export interface StoryChange {
  /** The reader has opened this story before (we have a prior snapshot). */
  seen: boolean;
  /** New coverage since last seen: fresher articles and/or a larger source set. */
  hasUpdates: boolean;
  /** Number of NEW source articles since last seen (0 when none / never seen). */
  newSources: number;
  /** When the reader last viewed it (epoch ms), or null if never. */
  seenAt: number | null;
}

const NONE: StoryChange = { seen: false, hasUpdates: false, newSources: 0, seenAt: null };

/**
 * Compare a story to the reader's last-viewed snapshot. A never-seen story is NOT
 * treated as "changed" (it's simply new, and already surfaced in the normal list)
 * — `hasUpdates` is reserved for stories that genuinely moved since the reader
 * last opened them, which is what the request asks to highlight.
 */
export function storyChange(story: Story, view?: StoryView | null): StoryChange {
  if (!view) return NONE;
  const newSources = Math.max(0, story.sources.length - view.sourceCount);
  const hasUpdates = story.updatedAt > view.updatedAt || newSources > 0;
  return { seen: true, hasUpdates, newSources, seenAt: view.seenAt };
}

/**
 * The "last minute" set: stories that gained new coverage since the reader last
 * saw them. Developing issues sort first (they're the ones readers track over
 * time), then by most-recent activity.
 */
export function lastMinuteStories(
  stories: Story[],
  views: Record<string, StoryView>,
): Story[] {
  return stories
    .filter((s) => storyChange(s, views[s.id]).hasUpdates)
    .sort((a, b) => {
      const da = a.developing ? 1 : 0;
      const db = b.developing ? 1 : 0;
      if (db !== da) return db - da;
      return b.updatedAt - a.updatedAt;
    });
}

/**
 * True when a timeline milestone is NEW relative to the reader's prior view, i.e.
 * it happened after they last opened the story. `seenAt` null (never seen) ->
 * nothing is flagged as new.
 */
export function milestoneIsNew(mst: StoryMilestone, seenAt: number | null): boolean {
  return seenAt !== null && mst.at > seenAt;
}
