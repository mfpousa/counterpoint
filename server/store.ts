// On-disk store of analyzed feed items.
//
// Analysis is interest-INDEPENDENT and expensive, so we persist it: restarts
// reuse prior work (no re-paying the model) and switching reader interests just
// re-ranks the cached pool. The store is a flat JSON file; writes are atomic
// (temp file + rename) and corruption is non-fatal (we start empty).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { FeedItem, Topic } from "../src/types";
import { config } from "./config";

/** A feed item plus its persisted, interest-independent analysis. */
export interface StoredItem {
  item: FeedItem;
  /** Triaged as clickbait/junk — kept out of the feed but remembered so we
   *  never re-triage it. */
  clickbait: boolean;
  /** Deep analysis succeeded (topic/lean/importance/summary/keywords valid). */
  analyzed: boolean;
  topic: Topic;
  lean: number | null;
  /** 0..1 general newsworthiness (NOT personalized). */
  importance: number;
  /** One-line AI summary of the subject. */
  summary: string;
  /** Lowercase topical keywords used to match reader interests. */
  keywords: string[];
  /** When this item was analyzed (epoch ms). */
  analyzedAt: number;
}

interface StoreFile {
  version: number;
  items: StoredItem[];
}

const STORE_VERSION = 1;

const store = new Map<string, StoredItem>();
let loaded = false;

function storeFilePath(): string {
  const p = config.feed.storePath;
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

/** Lazily load the store from disk on first access. */
export function loadStore(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = readFileSync(storeFilePath(), "utf8");
    const parsed = JSON.parse(raw) as StoreFile;
    if (parsed?.version === STORE_VERSION && Array.isArray(parsed.items)) {
      for (const s of parsed.items) {
        if (s?.item?.id) store.set(s.item.id, s);
      }
      console.log(`[store] loaded ${store.size} analyzed item(s) from ${config.feed.storePath}`);
    }
  } catch {
    // No file yet, or unreadable/corrupt — start empty.
  }
}

/** Persist the store to disk atomically. */
export function saveStore(): void {
  const path = storeFilePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    const data: StoreFile = { version: STORE_VERSION, items: [...store.values()] };
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), "utf8");
    renameSync(tmp, path);
  } catch (e) {
    console.warn(`[store] failed to persist: ${e instanceof Error ? e.message : e}`);
  }
}

export function getStored(id: string): StoredItem | undefined {
  loadStore();
  return store.get(id);
}

export function hasStored(id: string): boolean {
  loadStore();
  return store.has(id);
}

export function upsertStored(entry: StoredItem): void {
  loadStore();
  store.set(entry.item.id, entry);
}

export function allStored(): StoredItem[] {
  loadStore();
  return [...store.values()];
}

export function storeSize(): number {
  loadStore();
  return store.size;
}

/**
 * Drop items older than retentionMs, then cap to maxStored (newest kept by
 * publishedAt). Returns the number removed. Caller persists afterwards.
 */
export function pruneStore(now = Date.now()): number {
  loadStore();
  const before = store.size;

  for (const [id, s] of store) {
    if (now - s.item.publishedAt > config.feed.retentionMs) store.delete(id);
  }

  if (store.size > config.feed.maxStored) {
    const sorted = [...store.values()].sort((a, b) => b.item.publishedAt - a.item.publishedAt);
    store.clear();
    for (const s of sorted.slice(0, config.feed.maxStored)) store.set(s.item.id, s);
  }

  return before - store.size;
}

/** Wipe the in-memory store (does not touch disk until saveStore is called). */
export function clearStore(): void {
  store.clear();
}
