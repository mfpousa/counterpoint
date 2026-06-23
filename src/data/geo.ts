// GEOGRAPHIC POOL MODEL — the source-geography hierarchy the reader drills through:
//
//   world → continent → country → region → province → locality/council
//
// A POOL is a set of outlets at one geographic granularity. Drilling down swaps
// the SOURCE SET, not a content filter: a region pool shows everything its outlets
// report. This SHARED module holds only the type model + the pool-id <-> node-id
// mapping. The TREE ITSELF is DATA-DRIVEN and built server-side from the discovered
// placeSources (see server/geoTree.ts) — there are no hardcoded places here, and
// the client gets the tree (and coverage) from the /api/coverage endpoint.

/** The levels of the geographic hierarchy, broad → narrow. */
export type GeoLevel =
  | "world"
  | "continent"
  | "country"
  | "region"
  | "province"
  | "locality";

/** Broad → narrow ordering, for sorting / depth math. */
export const GEO_LEVEL_ORDER: GeoLevel[] = [
  "world",
  "continent",
  "country",
  "region",
  "province",
  "locality",
];

/** One node in the geographic tree (built server-side from discovered data). */
export interface GeoNode {
  /** Stable id: continent slug ("europe"), ISO 3166-1 alpha-2 ("es"), or a
   *  slugified ISO 3166-2 region ("es-ga"). "world" is the root. */
  id: string;
  /** Parent node id; absent only for the root ("world"). */
  parent?: string;
  level: GeoLevel;
  /** Display label, e.g. "Galicia". */
  label: string;
  /** ISO 3166-1 alpha-2 this node sits under (absent for world/continent). */
  country?: string;
  /** ISO 3166-2 region code (e.g. "ES-GA") for region nodes — used to filter the
   *  country's outlets down to this region. Absent for non-region nodes. */
  regionCode?: string;
}

// --- Pool id <-> node id ----------------------------------------------------
// A geographic pool id is `geo-<nodeId>`. Encoding the node in the worldId lets
// ALL the per-world plumbing (store, build lock, view cache, status) work
// unchanged. These helpers are purely FORMAT-based (no membership check): the
// tree is data-driven and lives server-side (server/geoTree.ts), so the shared
// client never bundles it. The server validates node existence when it builds a
// pool's sources (an unknown node simply yields no outlets).

/** The root node id of the tree. */
export const GEO_ROOT_ID = "world";

export const GEO_POOL_PREFIX = "geo-";

/** True if a pool/world id is shaped like a geographic pool (`geo-<nodeId>`). */
export function isGeoPoolId(id: string | undefined | null): boolean {
  return !!id && id.startsWith(GEO_POOL_PREFIX) && id.length > GEO_POOL_PREFIX.length;
}

/** The node id of a geographic pool id ("geo-es-ga" -> "es-ga"), else null. */
export function geoNodeIdOf(poolId: string | undefined | null): string | null {
  return isGeoPoolId(poolId) ? (poolId as string).slice(GEO_POOL_PREFIX.length) : null;
}

/** The pool id for a node id ("es-ga" -> "geo-es-ga"). */
export function poolIdForNode(nodeId: string): string {
  return `${GEO_POOL_PREFIX}${nodeId}`;
}
