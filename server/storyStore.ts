// On-disk store of SYNTHESIZED stories (developing issues + cross-source events).
//
// Synthesis is expensive (an LLM call per story), so — exactly like analyzed
// articles — we persist it and reuse it across refreshes and restarts. On a
// rebuild we match each freshly-computed cluster/issue to a cached story by
// article-set overlap, so:
//   - identical membership  -> reuse the cached story verbatim (no model call);
//   - membership grew/shrank -> re-synthesize but KEEP the same id (continuity);
//   - no match               -> a brand-new story.
// This is what lets a refresh add new coverage to existing developments instead
// of recomputing everything. Flat JSON, atomic writes, corruption is non-fatal.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, resolve } from "node:path";
import type { Story } from "../src/types";
import { DEFAULT_WORLD_ID } from "../src/data/worlds";
import { config } from "./config";

export type StoryKind = "issue" | "event";

export interface CachedStory {
  /** Stable id (== story.id); preserved across membership changes. */
  id: string;
  kind: StoryKind;
  /** Sorted article ids that produced this story (the matching key). */
  memberIds: string[];
  story: Story;
  /** When it was last synthesized (epoch ms). */
  builtAt: number;
  /** Latest contributing article time (for retention pruning). */
  updatedAt: number;
}

interface StoreFile {
  version: number;
  stories: CachedStory[];
}

const STORE_VERSION = 1;

/** Jaccard overlap of two id lists in [0,1]. */
export function jaccardIds(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  let inter = 0;
  for (const x of a) if (setB.has(x)) inter += 1;
  return inter / (a.length + b.length - inter);
}

/**
 * Pure matcher (no I/O): best same-kind cached story by article-set overlap,
 * ignoring ids already claimed this round. Returns null below `threshold`;
 * `equal` is true when the article sets are identical (reuse verbatim).
 */
export function pickBestMatch(
  entries: CachedStory[],
  kind: StoryKind,
  memberIds: string[],
  used: Set<string>,
  threshold: number,
): { entry: CachedStory; equal: boolean } | null {
  let best: CachedStory | null = null;
  let bestScore = 0;
  for (const e of entries) {
    if (e.kind !== kind || used.has(e.id)) continue;
    const score = jaccardIds(memberIds, e.memberIds);
    if (score > bestScore) {
      bestScore = score;
      best = e;
    }
  }
  if (!best || bestScore < threshold) return null;
  return { entry: best, equal: bestScore === 1 };
}

class WorldStoryStore {
  private store = new Map<string, CachedStory>();
  private loaded = false;
  constructor(readonly worldId: string) {}

  private filePath(): string {
    const base = config.stories.storePath;
    const abs = isAbsolute(base) ? base : resolve(process.cwd(), base);
    if (this.worldId === DEFAULT_WORLD_ID) return abs;
    const dir = dirname(abs);
    const ext = extname(abs);
    const name = basename(abs, ext);
    return resolve(dir, `${name}.${this.worldId}${ext}`);
  }

  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath(), "utf8")) as StoreFile;
      if (parsed?.version === STORE_VERSION && Array.isArray(parsed.stories)) {
        for (const s of parsed.stories) if (s?.id && s.story) this.store.set(s.id, s);
        console.log(`[storyStore:${this.worldId}] loaded ${this.store.size} synthesized stor${this.store.size === 1 ? "y" : "ies"}`);
      }
    } catch {
      // No file yet, or unreadable/corrupt — start empty.
    }
  }

  save(): void {
    const path = this.filePath();
    try {
      mkdirSync(dirname(path), { recursive: true });
      const data: StoreFile = { version: STORE_VERSION, stories: [...this.store.values()] };
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(data), "utf8");
      renameSync(tmp, path);
    } catch (e) {
      console.warn(`[storyStore:${this.worldId}] failed to persist: ${e instanceof Error ? e.message : e}`);
    }
  }

  upsert(entry: CachedStory): void {
    this.load();
    this.store.set(entry.id, entry);
  }

  /**
   * Best same-kind cached story by article-set overlap, ignoring ids already
   * claimed this round. Returns null below `threshold`. `equal` is true when the
   * sets are identical (the story can be reused verbatim, no re-synthesis).
   */
  bestMatch(
    kind: StoryKind,
    memberIds: string[],
    used: Set<string>,
    threshold: number,
  ): { entry: CachedStory; equal: boolean } | null {
    this.load();
    return pickBestMatch([...this.store.values()], kind, memberIds, used, threshold);
  }

  /** Keep `keepIds` (in the current result) plus any entry still within the feed
   *  retention window (so a temporarily-quiet development survives to revive
   *  without re-synthesis); drop the rest. Returns the number removed. */
  prune(keepIds: Set<string>, now = Date.now()): number {
    this.load();
    const before = this.store.size;
    for (const [id, e] of this.store) {
      if (keepIds.has(id)) continue;
      if (now - e.updatedAt > config.feed.retentionMs) this.store.delete(id);
    }
    return before - this.store.size;
  }

  all(): CachedStory[] {
    this.load();
    return [...this.store.values()];
  }
}

const stores = new Map<string, WorldStoryStore>();

/** Get (or lazily create) the synthesized-story store for a world. */
export function getStoryStore(worldId: string): WorldStoryStore {
  let s = stores.get(worldId);
  if (!s) {
    s = new WorldStoryStore(worldId);
    stores.set(worldId, s);
  }
  return s;
}
