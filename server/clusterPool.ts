// Runs the story-planning pipeline (storyPlan.computeStoryPlan) on a background
// worker_threads worker so the heavy, O(n^2) clustering NEVER blocks the server's
// event loop — that synchronous block on the request path was what made switching to a
// pool with a thousand+ analyzed items freeze the whole app (feed, status poll, the next
// globe selection) until it finished.
//
// One long-lived worker, jobs serialized through it (clustering is per-pool and
// infrequent — a single off-thread lane is plenty and keeps memory flat). If the worker
// can't be spawned (or dies), we fall back to running the SAME pure function IN-PROCESS,
// so the feature degrades to today's behavior rather than breaking. The worker is
// unref()'d so it never keeps the process alive.

import path from "node:path";
import { Worker } from "node:worker_threads";
import type { ClusterInput } from "./cluster";
import { computeStoryPlan, type StoryPlan, type StoryPlanConfig } from "./storyPlan";

interface Pending {
  resolve: (plan: StoryPlan) => void;
  reject: (err: Error) => void;
}

let worker: Worker | null = null;
let workerBroken = false; // once a worker fails, stop trying — use the in-process fallback
let nextId = 1;
const pending = new Map<number, Pending>();

/** The server always runs from the repo root (`tsx (watch) server/index.ts`), so resolve
 *  the worker entry from cwd. Avoids import.meta.url, which the Jest/Babel transform that
 *  loads this module's importers can't parse. */
function workerEntry(): string {
  return path.join(process.cwd(), "server", "clusterWorker.ts");
}

function spawnWorker(): Worker | null {
  if (workerBroken) return null;
  if (worker) return worker;
  try {
    // Under tsx (dev + server:start) Worker is patched to load .ts entries. If that's not
    // the case in some runtime, the 'error' handler below trips the in-process fallback.
    const w = new Worker(workerEntry());
    w.on("message", (msg: { id: number; ok: boolean; result?: StoryPlan; error?: string }) => {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok && msg.result) p.resolve(msg.result);
      else p.reject(new Error(msg.error ?? "cluster worker failed"));
    });
    w.on("error", (err) => {
      console.warn("[clusterPool] worker error — falling back to in-process clustering:", err);
      workerBroken = true;
      worker = null;
      for (const p of pending.values()) p.reject(err);
      pending.clear();
    });
    w.on("exit", (code) => {
      worker = null;
      if (code !== 0) {
        for (const p of pending.values()) p.reject(new Error(`cluster worker exited (${code})`));
        pending.clear();
      }
    });
    // Don't let the worker keep the process alive on shutdown.
    w.unref();
    worker = w;
    console.log("[clusterPool] story-clustering worker ready (off-event-loop)");
    return w;
  } catch (e) {
    console.warn("[clusterPool] could not spawn worker — using in-process clustering:", e);
    workerBroken = true;
    return null;
  }
}

/**
 * Compute the story plan OFF the event loop. Resolves with the same {specs, stats} the
 * pure function returns. Falls back to in-process computation (yielded one tick so it
 * doesn't run synchronously inside the caller's await) if no worker is available.
 */
export function runStoryPlan(
  inputs: ClusterInput[],
  cfg: StoryPlanConfig,
  now: number = Date.now(),
): Promise<StoryPlan> {
  const w = spawnWorker();
  if (!w) {
    // Degraded path: keep working, just on the main thread (as before this optimization).
    return Promise.resolve().then(() => computeStoryPlan(inputs, cfg, now));
  }
  const id = nextId++;
  return new Promise<StoryPlan>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, inputs, cfg, now });
  }).catch((err) => {
    // The worker died mid-flight (already logged) — finish the job in-process so the
    // reader still gets stories.
    console.warn("[clusterPool] job failed on worker, retrying in-process:", err);
    return computeStoryPlan(inputs, cfg, now);
  });
}
