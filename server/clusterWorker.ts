// worker_threads entry: runs the PURE story-planning pipeline (storyPlan.ts) off the
// main event loop, so the O(n^2) clustering for a large pool never freezes the server
// while a reader switches pools. Receives { id, inputs, cfg, now }, posts back
// { id, ok, result | error }. Spawned (and load-balanced 1:1) by clusterPool.ts.
//
// Kept deliberately tiny and dependency-light: it imports only the pure pipeline, which
// in turn imports only ./cluster — no config/env, no store, no model client — so it loads
// fast in the worker and can't accidentally do I/O off-thread.

import { parentPort } from "node:worker_threads";
import { computeStoryPlan, type StoryPlanConfig } from "./storyPlan";
import type { ClusterInput } from "./cluster";

interface PlanRequest {
  id: number;
  inputs: ClusterInput[];
  cfg: StoryPlanConfig;
  now: number;
}

parentPort?.on("message", (msg: PlanRequest) => {
  try {
    const result = computeStoryPlan(msg.inputs, msg.cfg, msg.now);
    parentPort!.postMessage({ id: msg.id, ok: true, result });
  } catch (e) {
    parentPort!.postMessage({ id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});
