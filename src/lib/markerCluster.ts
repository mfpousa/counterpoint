// MAGNETIC CLUSTERING — pure, sphere-space, zoom-tiered aggregation of the globe's POINT
// markers (worldview event chips + co-located gathering badges). Nearby pins fold into one
// "+N" cluster that EXPLODES (splits into sub-clusters / individuals) as the reader zooms in
// or clicks it. Link ARCS are NOT clustered (they're lines between places, drawn separately).
//
// Why sphere space: the markers live on the unit sphere as direction vectors, so two pins are
// "close" by their ANGULAR distance (independent of the current view rotation). The merge
// threshold SHRINKS as zoom grows, so a tight cap of pins that overlaps when zoomed out cleanly
// separates when zoomed in — the recursive "magnetic" feel. Kept here, framework-free, so it's
// unit-testable away from three.js / react.

import type { Vec3 } from "./globeLayout";

/** A single point marker fed to the clusterer. `data` rides along untouched so the caller can
 *  rebuild the original chip/badge for a lone (un-clustered) point. */
export interface ClusterPoint<T> {
  id: string;
  /** Unit direction on the sphere (the marker's anchor). */
  dir: Vec3;
  /** 0..1 gravity — the strongest point in a cluster becomes its representative. */
  severity: number;
  data: T;
}

/** A resolved cluster node: either a lone point (`isCluster=false`, one member) or an aggregate
 *  of nearby points (`isCluster=true`). The caller draws a lone node as its normal marker and an
 *  aggregate as a single "+N" badge that flies-to + zooms to `breakZoom(radius)` on click. */
export interface Cluster<T> {
  /** Stable id: a lone node keeps its point's id (so it renders identically to an un-clustered
   *  marker); an aggregate gets a deterministic `c:<hash>` id derived from its sorted members. */
  id: string;
  /** Centroid unit direction (normalized mean of member dirs) — the badge's anchor + fly-to face. */
  dir: Vec3;
  /** Members folded into this node (length 1 for a lone point), representative first. */
  members: ClusterPoint<T>[];
  /** Highest-severity member — drives the collapsed badge's accent + the lone-marker render. */
  rep: ClusterPoint<T>;
  /** Max angular distance (rad) from the centroid to any member — the cluster's spread. Drives
   *  the zoom at which it splits (see `breakZoom`). 0 for a lone point. */
  radius: number;
  /** True when this node folds >1 point (draw a "+N" badge instead of the lone marker). */
  isCluster: boolean;
}

/** Angular merge radius (rad, ~9.2°) at zoom = 1. The per-tier threshold is this divided by the
 *  tier's zoom, so the cap shrinks the more you zoom in. Tuned so neighbouring countries fold at
 *  the world landing and cleanly separate a couple of zoom steps in. */
export const CLUSTER_MERGE_ANGLE = 0.16;
/** Re-cluster granularity, in zoom units: the clustering is recomputed only when the quantized
 *  zoom TIER changes (not every frame), so a steady zoom costs nothing. */
export const CLUSTER_ZOOM_STEP = 0.15;
/** How far PAST the split point a click zooms, so an exploded cluster visibly separates rather
 *  than landing exactly on the merge boundary (where it would still read as touching). <1 = zoom
 *  in further; the smaller it is the more aggressively a single click pulls the members apart. */
export const CLUSTER_SPLIT_MARGIN = 0.6;

/** Great-circle angle (rad) between two unit directions. Clamped so float drift never trips NaN. */
export function angularDistance(a: Vec3, b: Vec3): number {
  const d = a.x * b.x + a.y * b.y + a.z * b.z;
  return Math.acos(Math.max(-1, Math.min(1, d)));
}

/** Quantize a continuous zoom into a discrete clustering TIER. Equal zooms → equal tiers, so the
 *  caller can cheaply detect "did the tier change?" and only then recompute the clustering. */
export function clusterTier(zoom: number): number {
  return Math.round(zoom / CLUSTER_ZOOM_STEP);
}

/** The angular merge threshold for a given tier: `CLUSTER_MERGE_ANGLE / zoom_of_tier`, so it
 *  shrinks monotonically as you zoom in. The tier's zoom is floored at one step so the lowest
 *  tier still has a finite (large) threshold. */
export function clusterAngleForTier(tier: number): number {
  const zoom = Math.max(CLUSTER_ZOOM_STEP, tier * CLUSTER_ZOOM_STEP);
  return CLUSTER_MERGE_ANGLE / zoom;
}

/** The zoom at which a cluster of the given angular `radius` splits apart. Inverts the threshold
 *  (`CLUSTER_MERGE_ANGLE / zoom = radius`) and overshoots by CLUSTER_SPLIT_MARGIN so the explode
 *  is clearly visible. A (near-)coincident cluster (radius→0) returns Infinity — it can never be
 *  separated by zooming, so the caller falls back to a fan-out list. */
export function breakZoom(radius: number): number {
  if (radius <= 1e-4) return Infinity;
  return CLUSTER_MERGE_ANGLE / (radius * CLUSTER_SPLIT_MARGIN);
}

/** Tiny, allocation-free FNV-ish hash → an aggregate cluster's stable id from its member ids. */
function hashKey(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Build one cluster node from a member list (representative first = highest severity). */
function makeCluster<T>(members: ClusterPoint<T>[]): Cluster<T> {
  const rep = members[0];
  if (members.length === 1) {
    return { id: rep.id, dir: rep.dir, members, rep, radius: 0, isCluster: false };
  }
  // Centroid = normalized mean of member directions (a good cap centre for a small angular spread).
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const m of members) {
    cx += m.dir.x;
    cy += m.dir.y;
    cz += m.dir.z;
  }
  const len = Math.hypot(cx, cy, cz) || 1;
  const dir: Vec3 = { x: cx / len, y: cy / len, z: cz / len };
  let radius = 0;
  for (const m of members) radius = Math.max(radius, angularDistance(dir, m.dir));
  const id = `c:${hashKey(members.map((m) => m.id).sort().join("|"))}`;
  return { id, dir, members, rep, radius, isCluster: true };
}

/** Greedy sphere-space clustering: walk points strongest-first; each unclaimed point seeds a
 *  cluster and absorbs every still-unclaimed point within `mergeAngle` of the seed. Deterministic
 *  (severity-desc, id tiebreak) and O(n²) — fine for the few dozen markers the globe ever shows.
 *  The seed is always the cluster's strongest member, so `rep` = `members[0]`. */
export function clusterPoints<T>(
  points: ClusterPoint<T>[],
  mergeAngle: number,
): Cluster<T>[] {
  const order = points
    .map((p, i) => ({ p, i }))
    .sort((a, b) => b.p.severity - a.p.severity || (a.p.id < b.p.id ? -1 : a.p.id > b.p.id ? 1 : 0));
  const claimed = new Array<boolean>(points.length).fill(false);
  const cosThreshold = Math.cos(Math.max(0, mergeAngle));
  const out: Cluster<T>[] = [];
  for (let s = 0; s < order.length; s++) {
    const { p: seed, i: si } = order[s];
    if (claimed[si]) continue;
    claimed[si] = true;
    const members: ClusterPoint<T>[] = [seed];
    for (let q = s + 1; q < order.length; q++) {
      const { p: cand, i: qi } = order[q];
      if (claimed[qi]) continue;
      const dot = seed.dir.x * cand.dir.x + seed.dir.y * cand.dir.y + seed.dir.z * cand.dir.z;
      if (dot >= cosThreshold) {
        claimed[qi] = true;
        members.push(cand);
      }
    }
    out.push(makeCluster(members));
  }
  return out;
}
