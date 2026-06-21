// On-disk cache of AI-rewritten articles, SHARED across ALL users and surviving
// restarts. The rewrite is the highest-volume LLM call (one per article opened),
// so persisting it is the single biggest cost saver: the first reader to open an
// article pays for the rewrite once, and every other reader — and every future
// process — is served from disk for free. Keyed by `${itemId}:${lang}`.
//
// Flat JSON, atomic writes, debounced saves, corruption is non-fatal.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { RewrittenArticle } from "../src/types";
import { config } from "./config";

interface Entry {
  /** When this rewrite was produced (epoch ms), for TTL pruning. */
  at: number;
  article: RewrittenArticle;
}

interface StoreFile {
  version: number;
  entries: Record<string, Entry>;
}

const STORE_VERSION = 1;
const SAVE_DEBOUNCE_MS = 1500;

class RewriteStore {
  private map = new Map<string, Entry>();
  private loaded = false;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  private path(): string {
    const base = config.reader.cachePath;
    return isAbsolute(base) ? base : resolve(process.cwd(), base);
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(readFileSync(this.path(), "utf8")) as StoreFile;
      if (parsed?.version === STORE_VERSION && parsed.entries) {
        const now = Date.now();
        for (const [k, e] of Object.entries(parsed.entries)) {
          // Drop anything past its disk TTL on load (keeps the file from growing
          // unbounded and avoids serving very stale rewrites).
          if (e?.article && now - e.at <= config.reader.diskTtlMs) this.map.set(k, e);
        }
        console.log(`[rewriteStore] loaded ${this.map.size} cached rewrite(s)`);
      }
    } catch {
      // No file yet, or unreadable/corrupt — start empty.
    }
  }

  /** A fresh cached rewrite for `key`, or null (miss / expired). */
  get(key: string): RewrittenArticle | null {
    this.load();
    const e = this.map.get(key);
    if (!e) return null;
    if (Date.now() - e.at > config.reader.diskTtlMs) {
      this.map.delete(key);
      return null;
    }
    return e.article;
  }

  set(key: string, article: RewrittenArticle): void {
    this.load();
    this.map.set(key, { at: Date.now(), article });
    this.scheduleSave();
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (this.dirty) this.save();
    }, SAVE_DEBOUNCE_MS);
  }

  /** Persist now (atomic). Also called on shutdown to flush a pending debounce. */
  save(): void {
    this.dirty = false;
    const path = this.path();
    try {
      mkdirSync(dirname(path), { recursive: true });
      const now = Date.now();
      const entries: Record<string, Entry> = {};
      for (const [k, e] of this.map) {
        if (now - e.at <= config.reader.diskTtlMs) entries[k] = e;
      }
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: STORE_VERSION, entries } satisfies StoreFile), "utf8");
      renameSync(tmp, path);
    } catch (e) {
      console.warn(`[rewriteStore] failed to persist: ${e instanceof Error ? e.message : e}`);
    }
  }
}

export const rewriteStore = new RewriteStore();

// Flush any pending debounced save on shutdown so a restart (incl. dev `tsx
// watch` reloads) never loses freshly-produced rewrites.
let flushed = false;
const flush = () => {
  if (flushed) return;
  flushed = true;
  rewriteStore.save();
};
process.once("SIGINT", flush);
process.once("SIGTERM", flush);
process.once("beforeExit", flush);
