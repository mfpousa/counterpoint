import {
  angularDistance,
  breakZoom,
  clusterAngleForTier,
  clusterPoints,
  clusterTier,
  CLUSTER_MERGE_ANGLE,
  CLUSTER_ZOOM_STEP,
  type ClusterPoint,
} from "../src/lib/markerCluster";
import type { Vec3 } from "../src/lib/globeLayout";

const DEG = Math.PI / 180;
// A unit direction `deg` degrees off the +Z axis, in the X–Z plane. Two such points at +d and
// −d are exactly 2·d degrees apart — handy for building clusters with a known angular spread.
const off = (deg: number): Vec3 => ({ x: Math.sin(deg * DEG), y: 0, z: Math.cos(deg * DEG) });

function pt(id: string, dir: Vec3, severity: number): ClusterPoint<string> {
  return { id, dir, severity, data: id };
}

describe("angularDistance", () => {
  it("is 0 for identical directions and π for antipodal", () => {
    expect(angularDistance({ x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 1 })).toBeCloseTo(0, 6);
    expect(angularDistance({ x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 })).toBeCloseTo(Math.PI, 6);
  });
  it("is π/2 for orthogonal directions, and clamps float drift (no NaN)", () => {
    expect(angularDistance({ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 })).toBeCloseTo(Math.PI / 2, 6);
    // Slightly over-unit dot from float error must not produce NaN.
    expect(Number.isNaN(angularDistance({ x: 1.0000001, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }))).toBe(
      false,
    );
  });
});

describe("clusterTier / clusterAngleForTier", () => {
  it("quantizes zoom into discrete tiers (equal & close zooms share a tier)", () => {
    expect(clusterTier(1.0)).toBe(clusterTier(1.0));
    expect(clusterTier(1.0)).toBe(clusterTier(1.0 + CLUSTER_ZOOM_STEP / 4));
    expect(clusterTier(1.0)).not.toBe(clusterTier(1.0 + CLUSTER_ZOOM_STEP));
  });
  it("shrinks the merge threshold monotonically as the tier (zoom) grows", () => {
    const a = clusterAngleForTier(clusterTier(0.6));
    const b = clusterAngleForTier(clusterTier(1.4));
    const c = clusterAngleForTier(clusterTier(2.6));
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
    expect(c).toBeGreaterThan(0);
  });
});

describe("clusterPoints (greedy sphere-space)", () => {
  it("merges two near points under a wide threshold; lone point stays lone", () => {
    const points = [
      pt("a", off(2), 0.4), // 4° apart from b
      pt("b", off(-2), 0.9),
      pt("far", { x: 1, y: 0, z: 0 }, 0.5), // 90° away
    ];
    const out = clusterPoints(points, 10 * DEG);
    expect(out).toHaveLength(2);
    const agg = out.find((c) => c.isCluster)!;
    const lone = out.find((c) => !c.isCluster)!;
    expect(agg.members).toHaveLength(2);
    expect(lone.id).toBe("far");
    // Representative is the STRONGEST member, and it leads `members`.
    expect(agg.rep.id).toBe("b");
    expect(agg.members[0].id).toBe("b");
    // Aggregate id is namespaced + derived from members (not a raw point id).
    expect(agg.id.startsWith("c:")).toBe(true);
  });

  it("splits the same pair under a tight threshold into two lone nodes", () => {
    const points = [pt("a", off(2), 0.4), pt("b", off(-2), 0.9)];
    const out = clusterPoints(points, 2 * DEG); // 4° apart > 2° threshold → no merge
    expect(out).toHaveLength(2);
    expect(out.every((c) => !c.isCluster)).toBe(true);
    // A lone node keeps its point's id so it renders as the original marker.
    expect(out.map((c) => c.id).sort()).toEqual(["a", "b"]);
  });

  it("puts the aggregate centroid between members and reports the spread radius", () => {
    const out = clusterPoints([pt("a", off(3), 0.4), pt("b", off(-3), 0.5)], 20 * DEG);
    const agg = out[0];
    expect(agg.isCluster).toBe(true);
    // Centroid sits on the +Z axis (midpoint of ±3°); radius ≈ 3°.
    expect(angularDistance(agg.dir, { x: 0, y: 0, z: 1 })).toBeCloseTo(0, 5);
    expect(agg.radius).toBeCloseTo(3 * DEG, 4);
  });

  it("is deterministic and order-independent for the aggregate id", () => {
    const a = pt("a", off(2), 0.4);
    const b = pt("b", off(-2), 0.9);
    const id1 = clusterPoints([a, b], 10 * DEG).find((c) => c.isCluster)!.id;
    const id2 = clusterPoints([b, a], 10 * DEG).find((c) => c.isCluster)!.id;
    expect(id1).toBe(id2);
  });
});

describe("breakZoom (the click-to-explode target)", () => {
  it("returns Infinity for a coincident cluster (cannot split by zooming)", () => {
    expect(breakZoom(0)).toBe(Infinity);
    expect(breakZoom(1e-5)).toBe(Infinity);
  });
  it("decreases monotonically as the cluster spreads wider", () => {
    expect(breakZoom(0.05)).toBeGreaterThan(breakZoom(0.1));
    expect(breakZoom(0.1)).toBeGreaterThan(breakZoom(0.2));
  });
  it("zooms IN past where the cluster formed, so a click visibly separates it", () => {
    // A cluster formed at zoom z holds members within CLUSTER_MERGE_ANGLE/z of the seed, so its
    // radius ≤ that threshold. breakZoom(radius) must exceed z so the explode actually zooms in.
    const z = 1.0;
    const formedThreshold = CLUSTER_MERGE_ANGLE / z;
    expect(breakZoom(formedThreshold)).toBeGreaterThan(z);
  });
  it("a cluster that exists at one tier actually splits at its breakZoom tier", () => {
    // Two points 6° apart cluster at a low zoom but must separate once we zoom to breakZoom.
    const points = [pt("a", off(3), 0.4), pt("b", off(-3), 0.9)];
    const low = clusterPoints(points, clusterAngleForTier(clusterTier(0.6)));
    expect(low).toHaveLength(1);
    expect(low[0].isCluster).toBe(true);
    const z = Math.min(2.6, breakZoom(low[0].radius));
    const exploded = clusterPoints(points, clusterAngleForTier(clusterTier(z)));
    expect(exploded.length).toBeGreaterThan(1);
  });
});
