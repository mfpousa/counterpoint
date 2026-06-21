// A tiny in-memory cache of the stories the feed has already loaded, shared
// across routes. Opening a story that's already listed should be INSTANT and must
// never dead-end: story ids are derived from their member articles, so a
// background rebuild can change an id. By rendering the clicked story from this
// cache we avoid both the long /api/stories rebuild wait and the "expired" race.

import type { Story } from "../types";

const byId = new Map<string, Story>();

/** Remember a freshly-loaded batch of stories (additive; never evicts a story
 *  the user might still be viewing). */
export function cacheStories(list: Story[]): void {
  for (const s of list) byId.set(s.id, s);
}

/** The cached story for an id, if we've seen it. */
export function getCachedStory(id: string): Story | undefined {
  return byId.get(id);
}

/** All currently-cached stories (used to resolve related links offline). */
export function getCachedStories(): Story[] {
  return Array.from(byId.values());
}
