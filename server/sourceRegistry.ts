// NODE-KEYED SOURCE REGISTRY for the geographic pool tree (src/data/geo.ts).
//
// Each geographic node (world / continent / country / region / province /
// locality) draws its feed from its OWN set of outlets, stored as:
//
//   src/data/geoSources/<nodeId>.json   — a Source[] (may be hand-seeded now,
//                                          discovered on demand later)
//
// Coverage is intentionally sparse: we can't precompute the planet. The map
// colors nodes by their coverage state, resolved here:
//
//   ready    — a registry file exists with >= 1 source
//   none     — a registry file exists but is empty (we looked, found nothing)
//   unknown  — no registry file yet (discoverable on demand)
//
// Results are cached per node for the process lifetime (cleared in tests).

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Source } from "../src/types";
import { isGeoNode } from "../src/data/geo";

/** Whether (and how well) a node is covered by discovered sources. */
export type CoverageState = "ready" | "none" | "unknown";

export interface NodeRegistry {
  sources: Source[];
  state: CoverageState;
}

const cache = new Map<string, NodeRegistry>();

function registryPath(nodeId: string): string {
  return resolve(process.cwd(), "src/data/geoSources", `${nodeId}.json`);
}

/**
 * The source registry for a geographic node: its outlets plus a coverage state.
 * Unknown node ids (not in the tree) are reported as `unknown` with no sources.
 */
export function registryForNode(nodeId: string | undefined | null): NodeRegistry {
  const id = (nodeId ?? "").trim();
  if (!id || !isGeoNode(id)) return { sources: [], state: "unknown" };

  const hit = cache.get(id);
  if (hit) return hit;

  let result: NodeRegistry = { sources: [], state: "unknown" };
  const file = registryPath(id);
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (Array.isArray(parsed)) {
        const sources = parsed as Source[];
        result = { sources, state: sources.length > 0 ? "ready" : "none" };
      }
    } catch (e) {
      console.warn(
        `[sourceRegistry] failed to parse ${file}:`,
        e instanceof Error ? e.message : e,
      );
    }
  }
  cache.set(id, result);
  return result;
}

/** The outlets for a node (empty when uncovered). */
export function sourcesForNode(nodeId: string | undefined | null): Source[] {
  return registryForNode(nodeId).sources;
}

/** The coverage state for a node (cheap — used to color the navigation map). */
export function coverageStateOf(nodeId: string | undefined | null): CoverageState {
  return registryForNode(nodeId).state;
}

/** Test-only: drop the cached registries. */
export function _clearRegistryCache(): void {
  cache.clear();
}
