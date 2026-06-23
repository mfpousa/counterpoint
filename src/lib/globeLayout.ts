// Pure, dependency-free PROCEDURAL LAYOUT for the 3D globe navigator. It places
// the geographic entities of ONE browse level (the children of the focused node)
// onto the unit sphere using nothing but their ids — so the layout is:
//   - DETERMINISTIC: the same ids always produce the same positions (stable
//     across renders, platforms, and app restarts);
//   - EVEN: a Fibonacci-sphere distribution spreads N points with no clumping;
//   - ORDER-INDEPENDENT: positions are assigned by SORTED id, so adding/removing
//     a sibling never reshuffles the others.
//
// No three.js / React Native imports live here, so the math is trivially unit
// testable. The rendering layer (src/components/globe) consumes these vectors.
// The lat/lon helper is kept here too so Stage 4 (real geography) reuses the same
// tested sphere math instead of duplicating it.

/** A point in 3D space (also used for unit direction vectors). */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** The golden angle — the irrational turn that makes the Fibonacci sphere even. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

const TWO_PI = Math.PI * 2;
const DEG2RAD = Math.PI / 180;

/**
 * Deterministic 32-bit FNV-1a hash of a string. Stable across runs and platforms
 * (only Math.imul + xor), used to derive a per-level seed so sibling sets at
 * different parents don't all share the same pole alignment.
 */
export function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Euclidean length of a vector. */
export function lengthOf(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

/** Unit vector in the direction of `v` (returns a zero vector unchanged). */
export function normalize(v: Vec3): Vec3 {
  const len = lengthOf(v);
  if (len === 0) return { x: 0, y: 0, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

/**
 * `n` points spread ~evenly over the unit sphere (Fibonacci/sunflower sphere).
 * `seed` (radians) rotates the spiral about the Y axis so different levels can be
 * offset from one another. Deterministic by index.
 */
export function fibonacciSphere(n: number, seed = 0): Vec3[] {
  if (n <= 0) return [];
  if (n === 1) return [{ x: 0, y: 0, z: 1 }];
  const out: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    // y walks linearly from +1 (north) to -1 (south); the ring radius follows.
    const y = 1 - (i / (n - 1)) * 2;
    const radius = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = GOLDEN_ANGLE * i + seed;
    out.push({ x: Math.cos(theta) * radius, y, z: Math.sin(theta) * radius });
  }
  return out;
}

/**
 * Lay out the children of a browse level on the unit sphere, keyed by id. The
 * spiral is seeded from `seedKey` (typically the parent node id) so each level
 * has its own orientation, and ids are assigned in SORTED order so the placement
 * is stable when the child set changes by one.
 */
export function layoutLevel(ids: string[], seedKey = ""): Map<string, Vec3> {
  const sorted = [...ids].sort();
  const seed = (hashId(seedKey) / 0xffffffff) * TWO_PI;
  const points = fibonacciSphere(sorted.length, seed);
  const out = new Map<string, Vec3>();
  sorted.forEach((id, i) => out.set(id, points[i]));
  return out;
}

/** Cross product of two vectors. */
export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

/**
 * `count` unit directions arranged in a small ring around `center` on the sphere's
 * tangent plane. Used to fan a country's REGION pins out around the country's
 * centroid (we have no real region coordinates) so they don't stack on one point.
 */
export function tangentRing(center: Vec3, count: number, spread = 0.18): Vec3[] {
  const c = normalize(center);
  if (count <= 1) return [c];
  // A reference axis not parallel to c, so the tangent basis is well-defined.
  const ref: Vec3 = Math.abs(c.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const u = normalize(cross(c, ref));
  const v = normalize(cross(c, u));
  const out: Vec3[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const cosA = Math.cos(a) * spread;
    const sinA = Math.sin(a) * spread;
    out.push(
      normalize({
        x: c.x + u.x * cosA + v.x * sinA,
        y: c.y + u.y * cosA + v.y * sinA,
        z: c.z + u.z * cosA + v.z * sinA,
      }),
    );
  }
  return out;
}

/**
 * Geographic latitude/longitude (degrees) → unit vector on the sphere, Y-up:
 * lat +90° → north pole (0,1,0); (0°,0°) → (1,0,0). Used by Stage 4 to place
 * entities at their TRUE positions; lives here so the sphere math is tested once.
 */
export function latLonToVec3(latDeg: number, lonDeg: number): Vec3 {
  const lat = latDeg * DEG2RAD;
  const lon = lonDeg * DEG2RAD;
  const cosLat = Math.cos(lat);
  return {
    x: cosLat * Math.cos(lon),
    y: Math.sin(lat),
    z: cosLat * Math.sin(lon),
  };
}
