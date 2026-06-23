// Pure GeoJSON → SPHERE geometry for the 3D globe's real landmasses. Turns Natural
// Earth country borders (lon/lat polygons) into triangulated meshes wrapped onto
// the unit sphere, plus per-country and per-continent CENTROIDS so the navigator
// can place its pins on the right piece of land.
//
// Pure (no three.js / RN): earcut triangulates each polygon in 2D lon/lat space,
// then every vertex is lifted onto the sphere with the tested latLonToVec3. The
// renderer (GlobeScene) only turns the returned typed arrays into a BufferGeometry.
//
// Known v1 limitation: polygons that cross the ±180° antimeridian (Russia, Fiji,
// Alaska) triangulate with a few stretched faces — acceptable for a stylized globe;
// splitting at the antimeridian is a later refinement.

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

/** Merged, sphere-projected triangle soup for ALL land (one BufferGeometry). */
export interface LandGeometry {
  positions: Float32Array;
  indices: Uint32Array;
}

/** Where to anchor a pin for each country (by ISO alpha-2) and continent (slug). */
export interface GeoCentroids {
  byIso2: Map<string, Vec3>;
  byContinent: Map<string, Vec3>;
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

/** Triangulate one polygon (outer ring + optional holes) onto the sphere, appending
 *  to the shared position/index arrays. */
function addPolygon(rings: Ring[], radius: number, outPos: number[], outIdx: number[]): void {
  if (rings.length === 0) return;
  const flat: number[] = [];
  const holes: number[] = [];
  rings.forEach((ring, ri) => {
    if (ri > 0) holes.push(flat.length / 2);
    for (const [lon, lat] of ring) flat.push(lon, lat);
  });
  if (flat.length < 6) return; // need at least a triangle
  const tris = earcut(flat, holes.length ? holes : undefined, 2);
  const base = outPos.length / 3;
  for (let i = 0; i < flat.length; i += 2) {
    const v = latLonToVec3(flat[i + 1], flat[i]); // (lat, lon)
    outPos.push(v.x * radius, v.y * radius, v.z * radius);
  }
  for (const t of tris) outIdx.push(base + t);
}

/** Build one merged, sphere-wrapped land geometry from a country FeatureCollection. */
export function buildLandGeometry(geo: GeoJson, radius = 1): LandGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  for (const f of geo.features) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === "Polygon") {
      addPolygon(g.coordinates as Ring[], radius, pos, idx);
    } else if (g.type === "MultiPolygon") {
      for (const poly of g.coordinates as Ring[][]) addPolygon(poly, radius, pos, idx);
    }
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

/** Average direction of every vertex in a feature (good enough to anchor a pin). */
function featureCentroidDir(f: GeoFeature): Vec3 | null {
  const g = f.geometry;
  if (!g) return null;
  let x = 0;
  let y = 0;
  let z = 0;
  let n = 0;
  const addRingset = (rings: Ring[]) => {
    for (const ring of rings) {
      for (const [lon, lat] of ring) {
        const v = latLonToVec3(lat, lon);
        x += v.x;
        y += v.y;
        z += v.z;
        n += 1;
      }
    }
  };
  if (g.type === "Polygon") addRingset(g.coordinates as Ring[]);
  else if (g.type === "MultiPolygon") for (const poly of g.coordinates as Ring[][]) addRingset(poly);
  if (n === 0) return null;
  return normalize({ x, y, z });
}

/** Per-country + per-continent pin anchors (unit directions on the sphere). */
export function computeCentroids(geo: GeoJson): GeoCentroids {
  const byIso2 = new Map<string, Vec3>();
  const contAcc = new Map<string, { x: number; y: number; z: number }>();
  for (const f of geo.features) {
    const dir = featureCentroidDir(f);
    if (!dir) continue;
    const iso = iso2Of(f.properties);
    if (iso) byIso2.set(iso, dir);
    const cont = continentSlug(String(f.properties.CONTINENT ?? ""));
    if (cont) {
      const a = contAcc.get(cont) ?? { x: 0, y: 0, z: 0 };
      a.x += dir.x;
      a.y += dir.y;
      a.z += dir.z;
      contAcc.set(cont, a);
    }
  }
  const byContinent = new Map<string, Vec3>();
  for (const [k, a] of contAcc) byContinent.set(k, normalize(a));
  return { byIso2, byContinent };
}
