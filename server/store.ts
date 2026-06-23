// On-disk store of analyzed feed items.
//
// Analysis is interest-INDEPENDENT and expensive, so we persist it: restarts
// reuse prior work (no re-paying the model) and switching reader interests just
// re-ranks the cached pool. The store is a flat JSON file; writes are atomic
// (temp file + rename) and corruption is non-fatal (we start empty).

import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, resolve } from "node:path";
import type { FeedItem, LeanSource, Topic } from "../src/types";
import { DEFAULT_WORLD_ID, WORLDS } from "../src/data/worlds";
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
  /** Provenance of the effective lean: "llm" when the model refined this item's
   *  lean, "source" when it kept the curated source prior. Absent on pre-existing
   *  (older) stored items until they're re-analyzed. */
  leanSource?: LeanSource;
  /** Human-readable justification for the lean (model's when refined, else the
   *  source's). Shown in the UI; absent for non-political items. */
  leanRationale?: string;
  /** 0..1 general newsworthiness (NOT personalized). */
  importance: number;
  /** One-line AI summary of the subject. */
  summary: string;
  /** Lowercase topical keywords used to match reader interests. */
  keywords: string[];
  /** When this item was analyzed (epoch ms). */
  analyzedAt: number;
  /** Semantic embedding of the item (for meaning-based interest matching).
   *  Absent until backfilled, or when no embedding model is available. */
  embedding?: number[];
  /** REGIONAL pools only: the model judged this item to be a GLOBAL/international
   *  story (already covered by international sources) rather than genuinely local,
   *  so it's filtered out of the regional feed. Undefined = not yet classified. */
  global?: boolean;
  /** Coarse 0..1 newsworthiness from the cheap title-only triage/prescreen, scored
   *  for EVERY pool (topical, geo, regional). Drives provisional ranking + the
   *  analysis order before the deep pass; the deep pass overwrites `importance`
   *  with its real score. Undefined only on items predating the prescreen. */
  prescreenImportance?: number;
  /** Video/podcast items: a transcript-based RE-analysis has already run (the
   *  background enrichment tick). The fast analysis path skips transcript fetching
   *  (slow); this flag stops the tick from re-fetching/re-analyzing the same item.
   *  Undefined/false = not yet enriched (eligible). */
  transcriptEnriched?: boolean;
  /** Number of distinct outlets that carried this same story (>=1). Set by
   *  pre-analysis near-clone dedup: a CLONE inherits its representative's analysis
   *  and the cluster's source count, so the feed can show "covered by N outlets"
   *  without deep-analyzing every copy. Undefined when the item stands alone. */
  coveredBy?: number;
  /** The id of this item's REPRESENTATIVE when it's a near-clone of another (set
   *  by geo-pool dedup fan-out). Clones are kept in the store (for the coveredBy
   *  count + completeness) but HIDDEN from the feed/stories so each story shows as
   *  a single card. Undefined on representatives and stand-alone items. */
  cloneOf?: string;
}

interface StoreFile {
  version: number;
  items: StoredItem[];
}

const STORE_VERSION = 1;
// Coalesce rapid saves (deep analysis rewrites the WHOLE store — embeddings and all —
// every chunk) into ONE async write; doing it synchronously per chunk froze the server.
const SAVE_DEBOUNCE_MS = 1500;

/**
 * A single world's analyzed pool: an in-memory Map backed by its OWN JSON file.
 * The default world keeps the historical, unsuffixed filename so existing
 * analysis isn't discarded; other worlds get a `.<worldId>` suffix
 * (e.g. `.cache/feed-store.creative.json`).
 */
class WorldStore {
  private store = new Map<string, StoredItem>();
  private loaded = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saving = false;
  private saveAgain = false;
  constructor(readonly worldId: string) {}

  private filePath(): string {
    const base = config.feed.storePath;
    const abs = isAbsolute(base) ? base : resolve(process.cwd(), base);
    if (this.worldId === DEFAULT_WORLD_ID) return abs;
    const dir = dirname(abs);
    const ext = extname(abs);
    const name = basename(abs, ext);
    return resolve(dir, `${name}.${this.worldId}${ext}`);
  }

  /** Lazily load this world's store from disk on first access. */
  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = readFileSync(this.filePath(), "utf8");
      const parsed = JSON.parse(raw) as StoreFile;
      if (parsed?.version === STORE_VERSION && Array.isArray(parsed.items)) {
        for (const s of parsed.items) if (s?.item?.id) this.store.set(s.item.id, s);
        console.log(`[store:${this.worldId}] loaded ${this.store.size} analyzed item(s)`);
      }
    } catch {
      // No file yet, or unreadable/corrupt — start empty.
    }
  }

  /** Persist atomically + ASYNCHRONOUSLY, coalescing rapid calls. Analysis rewrites the
   *  whole store every chunk; doing that synchronously per chunk blocked the event loop,
   *  so we debounce and write off the hot path. Fire-and-forget (callers don't await). */
  save(): void {
    if (this.saveTimer) return; // a write is already scheduled; it captures the latest state
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flush();
    }, SAVE_DEBOUNCE_MS);
  }

  private async flush(): Promise<void> {
    if (this.saving) {
      this.saveAgain = true; // a write is in flight; remember to re-save the newer state
      return;
    }
    this.saving = true;
    const path = this.filePath();
    try {
      await mkdir(dirname(path), { recursive: true });
      const data: StoreFile = { version: STORE_VERSION, items: [...this.store.values()] };
      const tmp = `${path}.tmp`;
      await writeFile(tmp, JSON.stringify(data), "utf8");
      await rename(tmp, path);
    } catch (e) {
      console.warn(`[store:${this.worldId}] failed to persist: ${e instanceof Error ? e.message : e}`);
    } finally {
      this.saving = false;
      if (this.saveAgain) {
        this.saveAgain = false;
        this.save();
      }
    }
  }

  get(id: string): StoredItem | undefined {
    this.load();
    return this.store.get(id);
  }
  has(id: string): boolean {
    this.load();
    return this.store.has(id);
  }
  upsert(entry: StoredItem): void {
    this.load();
    this.store.set(entry.item.id, entry);
  }
  all(): StoredItem[] {
    this.load();
    return [...this.store.values()];
  }
  size(): number {
    this.load();
    return this.store.size;
  }

  /**
   * Drop items older than retentionMs, then cap to maxStored (newest kept by
   * publishedAt). Returns the number removed. Caller persists afterwards.
   */
  prune(now = Date.now()): number {
    this.load();
    const before = this.store.size;
    for (const [id, s] of this.store) {
      if (now - s.item.publishedAt > config.feed.retentionMs) this.store.delete(id);
    }
    if (this.store.size > config.feed.maxStored) {
      const sorted = [...this.store.values()].sort((a, b) => b.item.publishedAt - a.item.publishedAt);
      this.store.clear();
      for (const s of sorted.slice(0, config.feed.maxStored)) this.store.set(s.item.id, s);
    }
    return before - this.store.size;
  }

  clear(): void {
    this.store.clear();
  }
}

const stores = new Map<string, WorldStore>();

/** Get (or lazily create) the store for a world. */
export function getStore(worldId: string): WorldStore {
  let s = stores.get(worldId);
  if (!s) {
    s = new WorldStore(worldId);
    stores.set(worldId, s);
  }
  return s;
}

/**
 * Stored items across ALL instantiated pools whose id matches `include(worldId)`.
 * Lets the WORLD view synthesize ongoing stories from ALL the news the process has
 * fetched (front page + every geo/regional pool that's been loaded), instead of one
 * pool in isolation. Only LOADED pools contribute — we can't synthesize from news we
 * never fetched — so the world's stories get richer as more places are visited.
 */
export function storedAcrossPools(include: (worldId: string) => boolean): StoredItem[] {
  const out: StoredItem[] = [];
  for (const [worldId, store] of stores) {
    if (include(worldId)) out.push(...store.all());
  }
  return out;
}

/**
 * Find an analyzed item by id across EVERY known world. Used by the rewrite /
 * grade endpoints, which receive only an item id. `preferWorld` (the caller's
 * active world) is checked first for speed; otherwise we scan all worlds.
 */
export function getStoredAnyWorld(id: string, preferWorld?: string): StoredItem | undefined {
  if (preferWorld) {
    const hit = getStore(preferWorld).get(id);
    if (hit) return hit;
  }
  // Topical worlds (their stores may not be instantiated yet on a fresh process).
  for (const w of WORLDS) {
    if (w.id === preferWorld) continue;
    const hit = getStore(w.id).get(id);
    if (hit) return hit;
  }
  // Any OTHER instantiated pool the process has loaded — GEO pools (`geo-<node>`)
  // and REGIONAL pools (`place-<cc>`) live here, NOT in WORLDS. Without this scan
  // an item opened from the coverage-map / a regional pool 404s ("item not found")
  // because preferWorld + the WORLDS loop never cover those pools.
  for (const [worldId, store] of stores) {
    if (worldId === preferWorld) continue; // already checked above
    const hit = store.get(id);
    if (hit) return hit;
  }
  return undefined;
}
