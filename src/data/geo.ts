// GEOGRAPHIC POOL TREE — the source-geography hierarchy the reader drills through:
//
//   world → continent → country → region → province → locality/council
//
// A POOL is a set of outlets at one geographic granularity. Drilling down swaps
// the SOURCE SET (handled server-side by the source registry), not a content
// filter: a locality pool shows everything its outlets report — local, national
// or international. This module is the SHARED model (client + server): the tree
// itself plus the pool-id <-> node-id mapping. Coverage (which nodes actually
// have discovered sources) is resolved separately, on demand, by the server.

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

/** One node in the geographic tree. */
export interface GeoNode {
  /** Hierarchical id, hyphen-joined: "world", "eu", "es", "es-galicia",
   *  "es-galicia-pontevedra", "es-galicia-pontevedra-vigo". */
  id: string;
  /** Parent node id; absent only for the root ("world"). */
  parent?: string;
  level: GeoLevel;
  /** Display label, e.g. "Galicia". */
  label: string;
  /** ISO 3166-1 alpha-2 this node sits under (absent for world/continent). */
  country?: string;
}

// --- Seed tree --------------------------------------------------------------
// A deliberately small, REAL vertical slice (World → Europe → Spain → Galicia →
// Pontevedra → Vigo) plus the continents, so navigation works end to end before
// discovery is automated. New branches are added here (or, later, merged from
// on-demand discovery) without touching the plumbing.

const NODES: GeoNode[] = [
  { id: "world", level: "world", label: "World" },

  // Continents (children of world).
  { id: "eu", parent: "world", level: "continent", label: "Europe" },
  { id: "am", parent: "world", level: "continent", label: "Americas" },
  { id: "af", parent: "world", level: "continent", label: "Africa" },
  { id: "as", parent: "world", level: "continent", label: "Asia" },
  { id: "oc", parent: "world", level: "continent", label: "Oceania" },

  // Spain vertical slice.
  { id: "es", parent: "eu", level: "country", label: "Spain", country: "es" },
  { id: "es-galicia", parent: "es", level: "region", label: "Galicia", country: "es" },
  {
    id: "es-galicia-pontevedra",
    parent: "es-galicia",
    level: "province",
    label: "Pontevedra",
    country: "es",
  },
  {
    id: "es-galicia-pontevedra-vigo",
    parent: "es-galicia-pontevedra",
    level: "locality",
    label: "Vigo",
    country: "es",
  },
];

const BY_ID = new Map<string, GeoNode>(NODES.map((n) => [n.id, n]));

const CHILDREN = ((): Map<string, GeoNode[]> => {
  const m = new Map<string, GeoNode[]>();
  for (const n of NODES) {
    if (!n.parent) continue;
    const arr = m.get(n.parent) ?? [];
    arr.push(n);
    m.set(n.parent, arr);
  }
  return m;
})();

/** The root node id of the tree. */
export const GEO_ROOT_ID = "world";

/** Resolve a node by id (undefined if unknown). */
export function geoNode(id: string | undefined | null): GeoNode | undefined {
  return id ? BY_ID.get(id) : undefined;
}

/** True if `id` is a known geographic node. */
export function isGeoNode(id: string | undefined | null): boolean {
  return !!id && BY_ID.has(id);
}

/** Direct children of a node, in declaration order (empty if leaf/unknown). */
export function childrenOf(id: string | undefined | null): GeoNode[] {
  return (id && CHILDREN.get(id)) || [];
}

/** Ancestor chain from the ROOT down to `id` (inclusive). Empty if unknown. */
export function pathOf(id: string | undefined | null): GeoNode[] {
  const out: GeoNode[] = [];
  let cur = geoNode(id);
  const guard = new Set<string>(); // defend against accidental cycles
  while (cur && !guard.has(cur.id)) {
    out.push(cur);
    guard.add(cur.id);
    cur = cur.parent ? geoNode(cur.parent) : undefined;
  }
  return out.reverse();
}

/** Display label for a node id (falls back to the id itself). */
export function geoLabel(id: string | undefined | null): string {
  return geoNode(id)?.label ?? (id ?? "");
}

/** All known nodes (declaration order). */
export function allGeoNodes(): GeoNode[] {
  return NODES.slice();
}

// --- Pool id <-> node id ----------------------------------------------------
// A geographic pool id is `geo-<nodeId>`. Encoding the node in the worldId lets
// ALL the existing per-world plumbing (store, build lock, view cache, status)
// work unchanged — exactly how `place-<cc>` was bolted on, but generalized to
// any level of the tree.

export const GEO_POOL_PREFIX = "geo-";

/** True if a pool/world id names a geographic pool (`geo-<nodeId>`). */
export function isGeoPoolId(id: string | undefined | null): boolean {
  if (!id || !id.startsWith(GEO_POOL_PREFIX)) return false;
  return isGeoNode(id.slice(GEO_POOL_PREFIX.length));
}

/** The node id of a geographic pool id ("geo-es-galicia" -> "es-galicia"), else null. */
export function geoNodeIdOf(poolId: string | undefined | null): string | null {
  if (!poolId || !poolId.startsWith(GEO_POOL_PREFIX)) return null;
  const nodeId = poolId.slice(GEO_POOL_PREFIX.length);
  return isGeoNode(nodeId) ? nodeId : null;
}

/** The pool id for a node id ("es-galicia" -> "geo-es-galicia"). */
export function poolIdForNode(nodeId: string): string {
  return `${GEO_POOL_PREFIX}${nodeId}`;
}
