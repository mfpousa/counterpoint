// Pure GeoJSON → SPHERE geometry for the 3D globe's real landmasses. Turns Natural
// Earth country borders (lon/lat polygons) into triangulated meshes wrapped onto
// the unit sphere, plus per-country and per-continent CENTROIDS so the navigator
// can place its pins on the right piece of land.
//
// Pure (no three.js / RN): earcut triangulates each polygon in 2D lon/lat space,
// then every vertex is lifted onto the sphere with the tested latLonToVec3. The
// renderer (GlobeScene) only turns the returned typed arrays into a BufferGeometry.
//
// Antimeridian: polygons that cross the ±180° line (Russia's far east, Fiji, Alaska's
// Aleutians) are UNWRAPPED (negative longitudes shifted +360) before earcut, so they
// triangulate as one contiguous ring instead of producing faces that slice through the
// globe's core. See the ANTIMERIDIAN FIX in addPolygon.

import earcut from "earcut";
import { latLonToVec3, normalize, type Vec3 } from "./globeLayout";

/** Minimal slice of a GeoJSON FeatureCollection we rely on. */
export interface GeoFeature {
  properties: Record<string, unknown>;
  geometry: { type: string; coordinates: unknown } | null;
}
export interface GeoJson {
  features: GeoFeature[];
}

/** Merged, sphere-projected triangle soup for ALL land (one BufferGeometry).
 *  NON-INDEXED (positions expanded per-vertex) so we never need a 32-bit index
 *  buffer, which expo-gl's WebGL1 context may not support. `normals` are the
 *  outward sphere normals so the land lights correctly without GL derivatives. */
export interface LandGeometry {
  positions: Float32Array;
  normals: Float32Array;
}

/** A country in the flat search/geolocation list. */
export interface CountryCentroid {
  iso2: string;
  name: string;
  continent: string;
  dir: Vec3;
}

/** A continent in the flat search list. */
export interface ContinentCentroid {
  slug: string;
  label: string;
  dir: Vec3;
}

/** Where to anchor a pin for each country (by ISO alpha-2) and continent (slug),
 *  plus flat lists used by place search and name-based alert geolocation. */
export interface GeoCentroids {
  byIso2: Map<string, Vec3>;
  byContinent: Map<string, Vec3>;
  countries: CountryCentroid[];
  continents: ContinentCentroid[];
}

/** A country's lon/lat extent, for sanity-checking a model-supplied point against the
 *  country it claims (a coarse, deliberately LENIENT point-in-country test). */
export interface BBox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

/** Accent/space-insensitive slug ("North America" → "north-america"). */
export function continentSlug(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Best 2-letter ISO code for a feature (ISO_A2_EH fixes many "-99" gaps), lowercased. */
export function iso2Of(props: Record<string, unknown>): string | null {
  for (const key of ["ISO_A2_EH", "ISO_A2"]) {
    const v = props[key];
    if (typeof v === "string" && /^[A-Za-z]{2}$/.test(v)) return v.toLowerCase();
  }
  return null;
}

type Ring = [number, number][];

// On the coarse 110m mesh a single earcut triangle can span tens of degrees of arc, so
// its FLAT face chords well below the spherical surface — denting big countries (Russia,
// the US, Canada) toward the core. We split every triangle 1→4 onto the sphere so the
// faces hug the curvature (high-res regional meshes never needed this).
//
// Subdivision is UNIFORM (fixed depth, every triangle), NOT adaptive: an edge's midpoint
// is shared by the two triangles that meet on it, so both split it identically and the
// surface stays watertight. Adaptive (split only wide triangles) left T-JUNCTIONS where a
// split triangle's sphere-projected midpoint bulged past an unsplit neighbour's straight
// chord — the thin dark seams. Depth 2 = each edge quartered (≤ ~¼ of the coarsest arc),
// which keeps the mid-edge dip above the ocean shell so no hole shows through.
const SUBDIV_DEPTH = 2;

/** Midpoint of two unit directions, re-projected onto the unit sphere. */
function midUnit(a: Vec3, b: Vec3): Vec3 {
  return normalize({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });
}

/** Emit one sphere triangle (unit dirs a,b,c), subdividing 1→4 UNIFORMLY to SUBDIV_DEPTH
 *  so the flat faces follow the curvature without leaving cracks between neighbours. */
function emitSphereTri(
  a: Vec3,
  b: Vec3,
  c: Vec3,
  radius: number,
  outPos: number[],
  outNorm: number[],
  depth: number,
): void {
  if (depth < SUBDIV_DEPTH) {
    const ab = midUnit(a, b);
    const bc = midUnit(b, c);
    const ca = midUnit(c, a);
    emitSphereTri(a, ab, ca, radius, outPos, outNorm, depth + 1);
    emitSphereTri(ab, b, bc, radius, outPos, outNorm, depth + 1);
    emitSphereTri(ca, bc, c, radius, outPos, outNorm, depth + 1);
    emitSphereTri(ab, bc, ca, radius, outPos, outNorm, depth + 1);
    return;
  }
  for (const v of [a, b, c]) {
    outPos.push(v.x * radius, v.y * radius, v.z * radius);
    outNorm.push(v.x, v.y, v.z); // outward normal == unit position for a sphere shell
  }
}

/** Triangulate one polygon (outer ring + optional holes) onto the sphere, appending
 *  EXPANDED (non-indexed) triangle vertices + outward normals to the shared arrays. */
function addPolygon(rings: Ring[], radius: number, outPos: number[], outNorm: number[]): void {
  if (rings.length === 0) return;
  // ANTIMERIDIAN FIX: a polygon whose outer ring spans > 180° of longitude must cross the
  // ±180° line (e.g. Russia's far east at ~-169° together with its body up to +180°). In
  // raw lon/lat that makes earcut connect the +180 side to the -180 side, producing huge
  // triangles that slice THROUGH the globe's core (the "gap" the reader sees). UNWRAP the
  // negative longitudes by +360 so the ring is contiguous before triangulating — the 3D
  // projection (sin/cos) is periodic, so a lon of 191° still maps to the correct point.
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const [lon] of rings[0]) {
    const v = Number(lon);
    if (Number.isFinite(v)) {
      if (v < minLon) minLon = v;
      if (v > maxLon) maxLon = v;
    }
  }
  const unwrap = maxLon - minLon > 180;
  const flat: number[] = [];
  const holes: number[] = [];
  rings.forEach((ring, ri) => {
    if (ri > 0) holes.push(flat.length / 2);
    for (const pt of ring) {
      let lon = Number(pt[0]);
      const lat = Number(pt[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      if (unwrap && lon < 0) lon += 360;
      flat.push(lon, lat);
    }
  });
  if (flat.length < 6) return; // need at least a triangle
  const tris = earcut(flat, holes.length ? holes : undefined, 2);
  // Project each triangle's corners onto the sphere, then emit it (subdividing wide ones so
  // the flat faces hug the surface). Vertices are EXPANDED per-triangle so the geometry
  // needs NO index buffer (dodges the unsupported 32-bit index path on expo-gl).
  for (let i = 0; i + 2 < tris.length; i += 3) {
    const a = latLonToVec3(flat[tris[i] * 2 + 1], flat[tris[i] * 2]);
    const b = latLonToVec3(flat[tris[i + 1] * 2 + 1], flat[tris[i + 1] * 2]);
    const c = latLonToVec3(flat[tris[i + 2] * 2 + 1], flat[tris[i + 2] * 2]);
    emitSphereTri(a, b, c, radius, outPos, outNorm, 0);
  }
}

/** Build one merged, sphere-wrapped land geometry from a country FeatureCollection. */
export function buildLandGeometry(geo: GeoJson, radius = 1): LandGeometry {
  const pos: number[] = [];
  const norm: number[] = [];
  for (const f of geo.features) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === "Polygon") {
      addPolygon(g.coordinates as Ring[], radius, pos, norm);
    } else if (g.type === "MultiPolygon") {
      for (const poly of g.coordinates as Ring[][]) addPolygon(poly, radius, pos, norm);
    }
  }
  return { positions: new Float32Array(pos), normals: new Float32Array(norm) };
}

/** One INTERACTIVE land shape per feature (country): its own non-indexed geometry
 *  plus the keys we bind hover/click to — ISO-2 code and continent slug. */
export interface CountryShape {
  iso2: string | null;
  continent: string;
  positions: Float32Array;
  normals: Float32Array;
}

/** Build a separate sphere-wrapped mesh per country so each can be hovered/clicked
 *  on its own (unlike the single merged buildLandGeometry). Features that triangulate
 *  to nothing are skipped. */
export function buildCountryShapes(geo: GeoJson, radius = 1): CountryShape[] {
  const out: CountryShape[] = [];
  for (const f of geo.features) {
    const g = f.geometry;
    if (!g) continue;
    const pos: number[] = [];
    const norm: number[] = [];
    if (g.type === "Polygon") {
      addPolygon(g.coordinates as Ring[], radius, pos, norm);
    } else if (g.type === "MultiPolygon") {
      for (const poly of g.coordinates as Ring[][]) addPolygon(poly, radius, pos, norm);
    }
    if (pos.length === 0) continue;
    out.push({
      iso2: iso2Of(f.properties),
      continent: continentSlug(String(f.properties.CONTINENT ?? "")),
      positions: new Float32Array(pos),
      normals: new Float32Array(norm),
    });
  }
  return out;
}

/** One province/state shape: its own non-indexed mesh + the slug(ISO 3166-2) the
 *  coverage tree keys region nodes by ("ES-GA" → "es-ga"), so we can bind hover/click. */
export interface RegionShape {
  regionId: string;
  country: string;
  name: string;
  /** Coverage node id of the higher-level division (slug of the community CODE), if any. */
  communityCode: string;
  /** Higher-level division NAME (for the name-based binding fallback). */
  communityName: string;
  positions: Float32Array;
  normals: Float32Array;
}

/** Build a separate sphere-wrapped mesh per streamed Admin-1 feature (properties:
 *  { iso2, code, name }). Mirrors buildCountryShapes but keys by the ISO 3166-2 code. */
export function buildRegionShapes(features: GeoFeature[], radius = 1): RegionShape[] {
  const out: RegionShape[] = [];
  for (const f of features) {
    const g = f.geometry;
    if (!g) continue;
    const pos: number[] = [];
    const norm: number[] = [];
    if (g.type === "Polygon") {
      addPolygon(g.coordinates as Ring[], radius, pos, norm);
    } else if (g.type === "MultiPolygon") {
      for (const poly of g.coordinates as Ring[][]) addPolygon(poly, radius, pos, norm);
    }
    if (pos.length === 0) continue;
    const code = typeof f.properties.code === "string" ? f.properties.code : "";
    out.push({
      regionId: code ? continentSlug(code) : "",
      country: String(f.properties.iso2 ?? "").toLowerCase(),
      name: typeof f.properties.name === "string" ? f.properties.name : "",
      communityCode:
        typeof f.properties.groupCode === "string" ? continentSlug(f.properties.groupCode) : "",
      communityName: typeof f.properties.group === "string" ? f.properties.group : "",
      positions: new Float32Array(pos),
      normals: new Float32Array(norm),
    });
  }
  return out;
}

/** Boundary line segments for ALL the given features' rings, projected to the sphere
 *  (pairs of consecutive vertices) — drawn as <lineSegments> to delimit COUNTRIES or
 *  REGIONS like a printed map. Returns a flat [x,y,z, x,y,z, ...] array (2 verts/seg). */
export function buildOutline(features: GeoFeature[], radius = 1): Float32Array {
  const seg: number[] = [];
  const addRing = (ring: Ring) => {
    for (let i = 0; i + 1 < ring.length; i++) {
      const a = latLonToVec3(ring[i][1], ring[i][0]);
      const b = latLonToVec3(ring[i + 1][1], ring[i + 1][0]);
      seg.push(a.x * radius, a.y * radius, a.z * radius, b.x * radius, b.y * radius, b.z * radius);
    }
  };
  for (const f of features) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === "Polygon") {
      for (const ring of g.coordinates as Ring[]) addRing(ring);
    } else if (g.type === "MultiPolygon") {
      for (const poly of g.coordinates as Ring[][]) for (const ring of poly) addRing(ring);
    }
  }
  return new Float32Array(seg);
}

/** Planar |shoelace| area of a ring in lon/lat — only used to COMPARE polygon sizes
 *  (pick the biggest landmass), so projection distortion doesn't matter. */
function ringArea(ring: Ring): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return Math.abs(a) / 2;
}

/** Average sphere direction of a ring's vertices. Uses 3D unit vectors, so it's
 *  antimeridian-safe (no lon wrap discontinuity) — fine for anchoring a pin. */
function ringCentroidDir(ring: Ring): Vec3 | null {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const [lon, lat] of ring) {
    const v = latLonToVec3(lat, lon);
    x += v.x;
    y += v.y;
    z += v.z;
  }
  return ring.length > 0 ? normalize({ x, y, z }) : null;
}

/** Anchor direction for a feature's pin: the centroid of its LARGEST polygon only.
 *  Averaging EVERY vertex dragged countries with far-flung overseas parts out to sea
 *  (e.g. France + French Guiana landed the France pin in the Atlantic west of Spain);
 *  using just the biggest landmass keeps the pin on the mainland (France, contiguous
 *  US over Alaska/Hawaii, mainland Norway over Svalbard, …). */
function featureCentroidDir(f: GeoFeature): Vec3 | null {
  const g = f.geometry;
  if (!g) return null;
  let best: Ring | null = null;
  let bestArea = -1;
  const consider = (outer: Ring | undefined) => {
    if (!outer) return;
    const area = ringArea(outer);
    if (area > bestArea) {
      bestArea = area;
      best = outer;
    }
  };
  if (g.type === "Polygon") {
    consider((g.coordinates as Ring[])[0]);
  } else if (g.type === "MultiPolygon") {
    for (const poly of g.coordinates as Ring[][]) consider(poly[0]);
  }
  return best ? ringCentroidDir(best) : null;
}

/** Per-country + per-continent pin anchors (unit directions on the sphere). */
export function computeCentroids(geo: GeoJson): GeoCentroids {
  const byIso2 = new Map<string, Vec3>();
  const contAcc = new Map<string, { x: number; y: number; z: number; label: string }>();
  const countries: CountryCentroid[] = [];
  for (const f of geo.features) {
    const dir = featureCentroidDir(f);
    if (!dir) continue;
    const iso = iso2Of(f.properties);
    const contLabel = String(f.properties.CONTINENT ?? "");
    const cont = continentSlug(contLabel);
    if (iso) {
      byIso2.set(iso, dir);
      const name = String(
        f.properties.NAME ?? f.properties.NAME_LONG ?? f.properties.ADMIN ?? iso.toUpperCase(),
      );
      countries.push({ iso2: iso, name, continent: cont, dir });
    }
    if (cont) {
      const a = contAcc.get(cont) ?? { x: 0, y: 0, z: 0, label: contLabel };
      a.x += dir.x;
      a.y += dir.y;
      a.z += dir.z;
      contAcc.set(cont, a);
    }
  }
  const byContinent = new Map<string, Vec3>();
  const continents: ContinentCentroid[] = [];
  for (const [slug, a] of contAcc) {
    const dir = normalize({ x: a.x, y: a.y, z: a.z });
    byContinent.set(slug, dir);
    continents.push({ slug, label: a.label || slug, dir });
  }
  return { byIso2, byContinent, countries, continents };
}

/** Per-country lon/lat bounding boxes (ISO-2 → BBox), accumulated over ALL of a country's
 *  polygons. Used to REJECT a model's geolocation when its point lands far outside the
 *  country it named. Intentionally lenient (whole-extent, no antimeridian unwrap): the goal
 *  is to catch gross hallucinations, not to be a precise borders test — a too-wide box for a
 *  trans-antimeridian country (Russia/Fiji) just makes validation more permissive, never
 *  wrongly strict. */
export function computeCountryBBoxes(geo: GeoJson): Map<string, BBox> {
  const out = new Map<string, BBox>();
  for (const f of geo.features) {
    const iso = iso2Of(f.properties);
    const g = f.geometry;
    if (!iso || !g) continue;
    const polys: Ring[] =
      g.type === "Polygon"
        ? (g.coordinates as Ring[])
        : g.type === "MultiPolygon"
          ? (g.coordinates as Ring[][]).flat()
          : [];
    let bb = out.get(iso);
    for (const ring of polys) {
      for (const [lon, lat] of ring) {
        if (!bb) {
          bb = { minLon: lon, minLat: lat, maxLon: lon, maxLat: lat };
          out.set(iso, bb);
        } else {
          if (lon < bb.minLon) bb.minLon = lon;
          if (lon > bb.maxLon) bb.maxLon = lon;
          if (lat < bb.minLat) bb.minLat = lat;
          if (lat > bb.maxLat) bb.maxLat = lat;
        }
      }
    }
  }
  return out;
}
