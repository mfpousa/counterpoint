// The 3D CONTENT of the globe navigator (everything INSIDE the r3f <Canvas>).
// Kept separate from the React Native wrapper (Globe.tsx) so this file only ever
// deals with three.js / react-three-fiber primitives. Cross-platform: the same
// JSX renders on web (WebGL) and native (expo-gl) because @react-three/fiber
// resolves its native build automatically.
//
// Look: a faceted metallic planet with one simple icosahedron per geographic
// entity sitting on its surface, placed by the pure procedural layout. A focused
// or active entity glows and scales up (the "nice hover effect"). Rotation +
// zoom are driven by refs the wrapper mutates from gestures, applied here in the
// per-frame loop so the gesture layer never has to re-render React.

import React, { memo, useEffect, useMemo, useRef } from "react";
import type { MutableRefObject } from "react";
import { AppState } from "react-native";
import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import {
  AdditiveBlending,
  BackSide,
  DoubleSide,
  Quaternion,
  Vector3,
} from "three";
import type { Group, Mesh, MeshBasicMaterial, PerspectiveCamera } from "three";
import { colors } from "../../theme";
import { greatCircleArc, greatCirclePoint, hashId, type Vec3 } from "../../lib/globeLayout";
import { EVENT_CATEGORIES, type EventCategory, type GeoAlert } from "../../lib/geoAlerts";

/** One geographic entity to render on the globe (a continent/country/region). */
export interface GlobeEntityData {
  id: string;
  poolId: string;
  label: string;
  /** Unit direction on the sphere (from the procedural layout). */
  dir: Vec3;
  /** True when this node has its own feed (coverage "ready"). */
  selectable: boolean;
  /** True when this node is the committed pool. */
  active: boolean;
  /** True when the reader can drill further down from here. */
  hasChildren: boolean;
}

/** Shared, mutation-friendly view state the gesture layer writes and the frame
 *  loop reads — kept in refs so dragging never triggers a React re-render. */
export interface GlobeViewRefs {
  rot: MutableRefObject<{ yaw: number; pitch: number }>;
  zoom: MutableRefObject<number>;
  dragging: MutableRefObject<boolean>;
  /** When set, the globe eases to face + zoom this orientation (drill-in focus);
   *  cleared the moment the reader drags so manual control always wins. */
  target: MutableRefObject<{ yaw: number; pitch: number; zoom: number } | null>;
  /** Wake the on-demand render loop (gestures call this so a ref-only mutation —
   *  which never re-renders React — still kicks the throttled frame loop). Assigned
   *  by GlobeScene; a no-op until the scene mounts. */
  wake: MutableRefObject<() => void>;
}

const PLANET_RADIUS = 0.975; // ocean sphere — a small gap below the land (1.0) so the flat triangles don't clip through, while still hugging
const ENTITY_RADIUS = 1.05;
const ALERT_RADIUS = 1.06; // alert pings sit just above everything else
const ZOOM_MIN = 0.6; // matches the wrapper's gesture/button clamp
const ZOOM_MAX = 2.6;
// Drag/zoom sensitivity constant: maps a desired on-screen pixel move to a globe rotation
// (= 2·cameraZ·tan(fov/2), the world-units spanned at the globe's distance). Mirrors the
// wrapper's DRAG_K so the scroll-zoom cursor-lock rotates in the same scale as a drag.
const DRAG_K = 2 * 3.2 * Math.tan((45 * Math.PI) / 180 / 2);
const OFF = "#000000";
// On-demand render budget: cap the animation loop at ~30fps (instead of the display's
// 60). Halves the per-second GPU/CPU work for spin/pulse/flag-wave with no visible loss
// on a globe, and the loop sleeps entirely (0fps) when nothing is moving.
const FRAME_MS = 1000 / 30;
// Markers (pins + flags) ride on the globe group, which scales with zoom — so without
// this they'd balloon when zoomed in. Counter-scale a marker by min(1, CAP/zoom) so its
// on-screen size grows with zoom only until the group hits CAP, then plateaus.
const MARKER_SIZE_CAP = 1.35;

function entityColor(d: GlobeEntityData): string {
  if (d.active) return colors.accent;
  if (d.selectable) return colors.accent;
  return colors.textDim;
}

function GlobeEntity({
  data,
  focused,
  onFocus,
  onActivate,
  onHoverMove,
}: {
  data: GlobeEntityData;
  focused: boolean;
  onFocus: (id: string | null) => void;
  onActivate: (id: string) => void;
  onHoverMove?: (x: number, y: number) => void;
}) {
  const ref = useRef<Mesh>(null);
  const highlight = focused || data.active;
  const target = highlight ? 1.7 : 1;
  // Ease the scale toward its target each frame for a smooth hover/select pop.
  useFrame(() => {
    const m = ref.current;
    if (!m) return;
    const s = m.scale.x + (target - m.scale.x) * 0.2;
    m.scale.setScalar(s);
  });
  const color = entityColor(data);
  return (
    <mesh
      ref={ref}
      position={[
        data.dir.x * ENTITY_RADIUS,
        data.dir.y * ENTITY_RADIUS,
        data.dir.z * ENTITY_RADIUS,
      ]}
      onClick={(e: ThreeEvent<MouseEvent>) => {
        e.stopPropagation();
        onActivate(data.id);
      }}
      onPointerOver={(e: ThreeEvent<PointerEvent>) => {
        e.stopPropagation();
        onFocus(data.id);
      }}
      onPointerMove={(e: ThreeEvent<PointerEvent>) =>
        onHoverMove?.(e.pointer.x, e.pointer.y)
      }
      onPointerOut={() => onFocus(null)}
    >
      <icosahedronGeometry args={[0.045, 1]} />
      <meshStandardMaterial
        color={color}
        metalness={0.5}
        roughness={0.25}
        emissive={highlight ? color : OFF}
        emissiveIntensity={focused ? 0.95 : data.active ? 0.6 : 0}
      />
    </mesh>
  );
}

/** One drillable place rendered as its TRUE country shape on the sphere. `entityId`
 *  is the coverage node the shape acts on (null → inert background land). ALL land
 *  always renders so continents stay visible; the current level's shapes light up,
 *  glow + lift on hover, and are clickable. NON-INDEXED geometry + outward normals
 *  (built in geoShapes) so it draws on expo-gl's WebGL1 context without a 32-bit
 *  index buffer or GL derivatives. */
export interface GlobeCountry {
  key: string;
  positions: Float32Array;
  normals: Float32Array;
  entityId: string | null;
  selectable: boolean;
  active: boolean;
  current: boolean;
  /** True for a streamed REGION/province shape (vs a whole country). Region fills get a
   *  distinct base tone so a selected country reads as a cohesive highlighted area even
   *  where individual provinces have no coverage. */
  isRegion?: boolean;
}

const LAND_INERT = "#3b4a5e"; // the rest of the world (not selectable at this level)
const LAND_REGION = "#52688a"; // a selected country's province w/o coverage — lifted above the dim neighbours
const LAND_DRILL = "#5d7b9c"; // a child you can drill into
const LAND_READY = "#6f93c4"; // a child that has its own feed
const LAND_HERE = "#88a6cc"; // the place we're currently inside — clearly lighter
const LAND_ACTIVE = "#a7c8ff"; // the committed feed — brightest, glows

const CountryMesh = memo(function CountryMesh({
  c,
  focused,
  onFocus,
  onActivate,
  onHoverMove,
}: {
  c: GlobeCountry;
  focused: boolean;
  onFocus: (id: string | null) => void;
  onActivate: (id: string) => void;
  onHoverMove?: (x: number, y: number) => void;
}) {
  const meshRef = useRef<Mesh>(null);
  const interactive = c.entityId !== null;
  const hot = focused || c.active || c.current;
  // Hover/active LIFT, eased toward its target each frame for a smooth pop (the
  // `current` shape doesn't lift, so it never pokes up through its own region fills).
  const targetScale = focused || c.active ? 1.014 : 1;
  useFrame(() => {
    const m = meshRef.current;
    if (!m) return;
    m.scale.setScalar(m.scale.x + (targetScale - m.scale.x) * 0.18);
  });
  let color = c.isRegion ? LAND_REGION : LAND_INERT;
  if (interactive) color = c.selectable ? LAND_READY : LAND_DRILL;
  if (c.current) color = LAND_HERE; // the place we're inside — stands out from neighbours
  if (c.active) color = LAND_ACTIVE; // the committed feed — brightest
  return (
    <mesh
      ref={meshRef}
      frustumCulled={false}
      onPointerOver={
        interactive
          ? (e: ThreeEvent<PointerEvent>) => {
              e.stopPropagation();
              onFocus(c.entityId);
            }
          : undefined
      }
      onPointerMove={
        interactive
          ? (e: ThreeEvent<PointerEvent>) =>
              onHoverMove?.(e.pointer.x, e.pointer.y)
          : undefined
      }
      onPointerOut={interactive ? () => onFocus(null) : undefined}
      onClick={
        interactive
          ? (e: ThreeEvent<MouseEvent>) => {
              e.stopPropagation();
              onActivate(c.entityId as string);
            }
          : undefined
      }
    >
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[c.positions, 3]} />
        <bufferAttribute attach="attributes-normal" args={[c.normals, 3]} />
      </bufferGeometry>
      <meshStandardMaterial
        color={color}
        metalness={0.45}
        roughness={0.5}
        emissive={hot ? colors.accent : OFF}
        emissiveIntensity={
          c.active ? 0.9 : focused ? 0.95 : c.current ? 0.6 : 0
        }
        side={DoubleSide}
      />
    </mesh>
  );
});

/** Country/region boundaries as crisp line segments, so the map reads like a printed
 *  atlas. Used twice: faint always-on country borders + stronger region borders. */
function Outline({
  positions,
  color,
  opacity,
}: {
  positions: Float32Array;
  color: string;
  opacity: number;
}) {
  return (
    <lineSegments frustumCulled={false}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <lineBasicMaterial color={color} transparent opacity={opacity} />
    </lineSegments>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// RELATIONSHIP ARCS — the third pillar: who is pulling against whom. A multi-side
// conflict (Story.sides) becomes great-circle arcs between the sides' home zones,
// each with a comet flowing along it so the tie reads as a live, directional link.
// ─────────────────────────────────────────────────────────────────────────────

/** One tie to draw on the globe: a great circle from `a` to `b` (unit dirs). */
export interface ArcData {
  id: string;
  a: Vec3;
  b: Vec3;
  /** 0..1 — drives the arc's brightness, thickness-feel and comet size. */
  severity: number;
  /** Hex colour for this tie (warm = conflict tension, per-kind for a physical link).
   *  Falls back to ARC_COLOR when omitted. */
  color?: string;
  /** Line style: tension ties are solid; physical links use their kind's dash. */
  dash?: "solid" | "dashed" | "dotted";
  /** Physical-link KIND (attack/spread/…). When set, the moving marker is a 2D BADGE
   *  (flag for attack, kind icon otherwise) projected by the scene loop — NOT a 3D comet;
   *  tension ties (no kind) keep the 3D comet. */
  kind?: string;
  /** Origin country ISO-2 (links only) — flies its flag when kind === "attack". */
  fromCc?: string;
}

const ARC_SEGMENTS = 56; // polyline resolution along the great circle
const ARC_BASE_RADIUS = 1.012; // hugs just above the land at the endpoints
const ARC_LIFT = 0.22; // how high the arc bows out at its midpoint (scaled by span)
const ARC_COLOR = "#ff7a5c"; // default (conflict tension) hue; per-arc `color` overrides it
const ARC_FLOW_SPEED = 0.32; // comet loops per second along each arc

/** Build the bowed great-circle geometry between two unit directions: the continuous
 *  point list (for sampling the comet) plus the segment-pair buffer (for <lineSegments>).
 *  The sphere math lives in the pure, unit-tested `greatCircleArc`. */
function arcGeometry(
  a: Vec3,
  b: Vec3,
  dash: "solid" | "dashed" | "dotted" = "solid",
): { path: Float32Array; line: Float32Array } {
  const path = greatCircleArc(a, b, ARC_SEGMENTS, ARC_BASE_RADIUS, ARC_LIFT);
  // Keep the segments this dash style draws (solid = all; dashed/dotted skip gaps), then
  // expand each kept segment into a PAIR for <lineSegments> — a static dashed/dotted line.
  const keep: number[] = [];
  for (let i = 0; i < ARC_SEGMENTS; i++) {
    if (dash === "solid" || (dash === "dashed" ? i % 4 < 2 : i % 3 === 0)) keep.push(i);
  }
  const line = new Float32Array(keep.length * 2 * 3);
  keep.forEach((i, j) => {
    line.set(path.subarray(i * 3, i * 3 + 3), j * 6);
    line.set(path.subarray((i + 1) * 3, (i + 1) * 3 + 3), j * 6 + 3);
  });
  return { path, line };
}

/** The tension web: a glowing arc per tie with a comet flowing A→B along it. Rendered
 *  inside the rotating group so the ties spin with the globe. The comets advance in a
 *  single useFrame (the governor keeps the loop alive while any arc is present). */
function Arcs({ arcs }: { arcs: ArcData[] }) {
  const geoms = useMemo(
    () => arcs.map((arc) => ({ ...arc, ...arcGeometry(arc.a, arc.b, arc.dash ?? "solid") })),
    [arcs],
  );
  const comets = useRef<(Mesh | null)[]>([]);
  useFrame((state) => {
    const base = state.clock.elapsedTime * ARC_FLOW_SPEED;
    for (let i = 0; i < geoms.length; i++) {
      const m = comets.current[i];
      if (!m) continue;
      const { path } = geoms[i];
      const segs = path.length / 3 - 1;
      // stagger each comet's phase so a hub of ties doesn't pulse in lockstep.
      const t = (base + i * 0.13) % 1;
      const f = t * segs;
      const k = Math.min(segs - 1, Math.floor(f));
      const r = f - k;
      const o = k * 3;
      m.position.set(
        path[o] + (path[o + 3] - path[o]) * r,
        path[o + 1] + (path[o + 4] - path[o + 1]) * r,
        path[o + 2] + (path[o + 5] - path[o + 2]) * r,
      );
    }
  });
  return (
    <group>
      {geoms.map((g, i) => (
        <group key={g.id}>
          <lineSegments frustumCulled={false}>
            <bufferGeometry>
              <bufferAttribute attach="attributes-position" args={[g.line, 3]} />
            </bufferGeometry>
            <lineBasicMaterial
              color={g.color ?? ARC_COLOR}
              transparent
              opacity={0.22 + 0.4 * g.severity}
              blending={AdditiveBlending}
              depthWrite={false}
            />
          </lineSegments>
          {/* Tension ties (no kind) flow a 3D comet; physical links ride a 2D flag/icon
              badge instead (projected by the scene loop), so no comet for them. */}
          {!g.kind && (
            <mesh
              ref={(el) => {
                comets.current[i] = el;
              }}
            >
              <sphereGeometry args={[0.011 + 0.012 * g.severity, 12, 12]} />
              <meshBasicMaterial
                color={g.color ?? ARC_COLOR}
                transparent
                opacity={0.95}
                blending={AdditiveBlending}
                depthWrite={false}
              />
            </mesh>
          )}
        </group>
      ))}
    </group>
  );
}

/** All country shapes; the current level's are interactive, the rest are dim land.
 *  memo'd so an unrelated parent re-render (e.g. the 3s status poll) doesn't re-map the
 *  hundreds of country meshes — only a real data/focus/handler change does. */
const Countries = memo(function Countries({
  data,
  focusedId,
  onFocus,
  onActivate,
  onHoverMove,
}: {
  data: GlobeCountry[];
  focusedId: string | null;
  onFocus: (id: string | null) => void;
  onActivate: (id: string) => void;
  onHoverMove?: (x: number, y: number) => void;
}) {
  return (
    <>
      {data.map((c) => (
        <CountryMesh
          key={c.key}
          c={c}
          focused={focusedId !== null && focusedId === c.entityId}
          onFocus={onFocus}
          onActivate={onActivate}
          onHoverMove={onHoverMove}
        />
      ))}
    </>
  );
});

// ---------------------------------------------------------------------------
// Markers (world events + AI-search results). Both stand UP from the surface so
// they read as objects ON the planet, are SHAPED by what they are (so a conflict
// vs a disaster vs a search-hit is identifiable at a glance), pulse a "sonar"
// ring, and carry an invisible hit sphere that BLOCKS hover/clicks on the country
// behind them and reports hover so the wrapper can float a detail bubble.
// ---------------------------------------------------------------------------

const UP = new Vector3(0, 1, 0);
const _proj = new Vector3(); // reused scratch for per-frame marker screen projection
const _anchor = new Vector3(); // reused scratch for the scroll-zoom cursor-lock projection

/** Quaternion (as [x,y,z,w]) orienting a marker's local +Y OUTWARD along `dir`, so
 *  shapes sit upright on the globe like pins/spikes rather than lying flat. */
function outwardQuat(dir: Vec3): [number, number, number, number] {
  const q = new Quaternion().setFromUnitVectors(
    UP,
    new Vector3(dir.x, dir.y, dir.z).normalize(),
  );
  return [q.x, q.y, q.z, q.w];
}

/** A flat, expanding "sonar" ring laid on the surface (local XZ plane), driving the
 *  alive feel. Refs let the frame loop animate scale/opacity without re-rendering. */
function PingRing({
  inner,
  outer,
  color,
  ringRef,
  matRef,
}: {
  inner: number;
  outer: number;
  color: string;
  ringRef: React.RefObject<Mesh>;
  matRef: React.RefObject<MeshBasicMaterial>;
}) {
  return (
    <mesh ref={ringRef} rotation={[Math.PI / 2, 0, 0]}>
      <ringGeometry args={[inner, outer, 24]} />
      <meshBasicMaterial
        ref={matRef}
        color={color}
        transparent
        opacity={0.45}
        side={DoubleSide}
        depthWrite={false}
      />
    </mesh>
  );
}

/** Shared invisible hit sphere: makes a small marker tappable AND stops pointer
 *  propagation so the country mesh behind it never hovers/selects through it. */
function MarkerHit({
  id,
  radius,
  y = 0,
  onPress,
  onHover,
}: {
  id: string;
  radius: number;
  y?: number;
  onPress?: (id: string) => void;
  onHover?: (id: string | null) => void;
}) {
  return (
    <mesh
      position={[0, y, 0]}
      onPointerOver={(e: ThreeEvent<PointerEvent>) => {
        e.stopPropagation();
        onHover?.(id);
      }}
      onPointerMove={(e: ThreeEvent<PointerEvent>) => e.stopPropagation()}
      onPointerOut={() => onHover?.(null)}
      onClick={(e: ThreeEvent<MouseEvent>) => {
        e.stopPropagation();
        onPress?.(id);
      }}
    >
      <sphereGeometry args={[radius, 8, 8]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
  );
}

/** One located result of an AI news search ("ask"): an accent "pin" — a thin stem +
 *  glowing head standing off the surface, with a pulsing base ring — deliberately
 *  unlike the flat category event shapes. `detail` (the one-line read) is shown in
 *  the hover bubble; `label` (place) floats as an always-on tag (both via the
 *  wrapper's projected overlay). */
export interface AskMarkerData {
  id: string;
  dir: Vec3;
  label: string;
  /** One-line read on what's happening there (shown on hover). */
  detail?: string;
  /** ISO 3166-1 alpha-2 (lowercase) of the place's nation, for its flag. */
  iso2?: string;
}

function AskMarker({
  data,
  onPress,
  onHover,
  hovered,
}: {
  data: AskMarkerData;
  onPress?: (id: string) => void;
  onHover?: (id: string | null) => void;
  hovered: boolean;
}) {
  const root = useRef<Group>(null);
  const head = useRef<Mesh>(null);
  const ring = useRef<Mesh>(null);
  const ringMat = useRef<MeshBasicMaterial>(null);
  const phase = (hashId(data.id) % 1000) / 1000;
  const c = colors.accent;
  const quat = useMemo(
    () => outwardQuat(data.dir),
    [data.dir.x, data.dir.y, data.dir.z],
  );
  useFrame((state) => {
    const tt = (state.clock.elapsedTime * 0.9 + phase) % 1;
    if (ring.current) ring.current.scale.setScalar(1 + tt * 3.5);
    if (ringMat.current) ringMat.current.opacity = (1 - tt) * 0.5;
    if (head.current) {
      const target = hovered ? 1.45 : 1;
      head.current.scale.setScalar(head.current.scale.x + (target - head.current.scale.x) * 0.2);
    }
    if (root.current) {
      const z = root.current.parent?.scale.x ?? 1;
      root.current.scale.setScalar(Math.min(1, MARKER_SIZE_CAP / z)); // cap screen size
    }
  });
  return (
    <group
      ref={root}
      position={[data.dir.x * ALERT_RADIUS, data.dir.y * ALERT_RADIUS, data.dir.z * ALERT_RADIUS]}
      quaternion={quat}
    >
      <mesh position={[0, 0.02, 0]}>
        <cylinderGeometry args={[0.0025, 0.0025, 0.04, 6]} />
        <meshBasicMaterial color={c} />
      </mesh>
      <mesh ref={head} position={[0, 0.05, 0]}>
        <sphereGeometry args={[0.014, 16, 16]} />
        <meshStandardMaterial
          color={c}
          emissive={c}
          emissiveIntensity={hovered ? 1.4 : 0.85}
          metalness={0.2}
          roughness={0.3}
        />
      </mesh>
      <PingRing inner={0.013} outer={0.02} color={c} ringRef={ring} matRef={ringMat} />
      <MarkerHit id={data.id} radius={0.05} y={0.04} onPress={onPress} onHover={onHover} />
    </group>
  );
}

function AskMarkers({
  markers,
  onPress,
  onHover,
  hoveredId,
}: {
  markers: AskMarkerData[];
  onPress?: (id: string) => void;
  onHover?: (id: string | null) => void;
  hoveredId: string | null;
}) {
  return (
    <>
      {markers.map((m) => (
        <AskMarker
          key={m.id}
          data={m}
          onPress={onPress}
          onHover={onHover}
          hovered={hoveredId === m.id}
        />
      ))}
    </>
  );
}

/** A marker projected to 2D screen space, for the wrapper's overlay chips/bubbles. */
export interface ProjectedMarker {
  id: string;
  kind: "ask" | "alert" | "link";
  /** Screen position (px) of the marker's anchor on the globe. */
  x: number;
  y: number;
  /** Always-on tag text (ask place name; "" for alerts). */
  label: string;
  /** Detail shown while hovered (ask blurb / alert headline). */
  detail: string;
  /** Tag/bubble accent colour. */
  color: string;
  hovered: boolean;
  /** Event category (alerts only) — drives the overlay chip's ICON. */
  category?: EventCategory;
  /** 0..1 gravity (alerts only) — drives the chip size. */
  severity?: number;
  /** How many events collapsed onto this spot (alerts only) — drives a "+N" badge. */
  count?: number;
  /** Ongoing issue vs single event (alerts only) — for the time treatment. */
  developing?: boolean;
  /** Most recent contributing article time (epoch ms, alerts only) — drives the chip's
   *  recency treatment: a live pulse when fresh, a fade when stale. */
  updatedAt?: number;
  /** Physical-link KIND (links only) — drives the travelling badge's icon/colour. */
  linkKind?: string;
  /** Origin country ISO-2 (links only) — flies its flag when linkKind === "attack". */
  fromCc?: string;
}

// memo'd so the scene only re-renders when its OWN inputs change. Without this, every
// AppContext update — notably the 3s background status poll and each live reloadPool —
// re-rendered the parent Globe and forced r3f to re-reconcile the whole scene graph
// (hundreds of country meshes + markers) on the JS thread, which is the periodic stutter.
// The wrapper keeps every prop referentially stable (refs/handlers memoized) so this holds.
export const GlobeScene = memo(function GlobeScene({
  countries,
  regions,
  countryOutline,
  outline,
  gizmos,
  alerts,
  arcs = [],
  askMarkers = [],
  onAskMarkerPress,
  hoveredMarkerId = null,
  focusedMarkerId = null,
  onMarkerHover,
  onMarkersProject,
  autoSpin,
  focusedId,
  onFocus,
  onActivate,
  onHoverMove,
  refs,
  rightInset = 0,
}: {
  countries: GlobeCountry[];
  regions: GlobeCountry[];
  countryOutline: Float32Array | null;
  outline: Float32Array | null;
  gizmos: GlobeEntityData[];
  alerts: GeoAlert[];
  /** Relationship/tension ties between conflict zones (empty = none). Drawn as flowing
   *  great-circle arcs; their presence keeps the on-demand loop alive for the flow. */
  arcs?: ArcData[];
  /** Located results from an AI news search to mark on the globe (empty = none). */
  askMarkers?: AskMarkerData[];
  /** Tap an ask marker → recenter the globe on it. */
  onAskMarkerPress?: (id: string) => void;
  /** The marker currently under the pointer (its core pops + detail bubble shows). */
  hoveredMarkerId?: string | null;
  /** The marker the reader CLICKED (its interactive card stays open; spin pauses). */
  focusedMarkerId?: string | null;
  /** A marker was hovered (id) or left (null) — drives `hoveredMarkerId`. */
  onMarkerHover?: (id: string | null) => void;
  /** Per-frame: marker anchors projected to SCREEN px, for the wrapper's overlay
   *  label/detail bubbles. Only the front-hemisphere markers worth labelling are sent. */
  onMarkersProject?: (items: ProjectedMarker[]) => void;
  /** Idle auto-rotate ONLY on the pristine world landing; stops once a place is chosen. */
  autoSpin: boolean;
  focusedId: string | null;
  onFocus: (id: string | null) => void;
  onActivate: (id: string) => void;
  /** Cursor position (NDC, -1..1) while a place is hovered — drives the floating pin. */
  onHoverMove?: (x: number, y: number) => void;
  refs: GlobeViewRefs;
  /** Width (px) the side panel covers on the RIGHT (desktop). The globe eases LEFT by
   *  half this so the focused content stays centred in the visible area. 0 = no shift. */
  rightInset?: number;
}) {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const group = useRef<Group>(null);
  // Scroll-zoom CURSOR LOCK: the surface point under the cursor at the wheel tick, kept in
  // the globe's LOCAL frame (so it rides the rotation) plus the cursor's screen NDC. While
  // set, the frame loop steers the rotation each tick so this point stays pinned under the
  // cursor as the scale eases — a true, jitter-free zoom-to-pointer. Cleared once settled.
  const zoomAnchor = useRef<{ dir: Vector3; ndcX: number; ndcY: number } | null>(null);
  // Eased horizontal CAMERA view-offset (px) so the globe slides smoothly when the side
  // panel opens/closes. A projection offset (not a world translation) shifts EVERY depth
  // by the same pixels, so the focused country on the near surface lands exactly on the
  // visible centre instead of overshooting.
  const offsetPx = useRef(0);
  // Pointer-over-the-GLOBE flag (web hover): true while the cursor is over the ocean sphere.
  // Combined with land-hover (focusedId) and marker-hover (hoveredMarkerId) it is the SOLE
  // signal that freezes the idle auto-spin — spin while off the globe, stop while on it.
  const overOcean = useRef(false);

  // --- Render governor (on-demand rendering) ---------------------------------
  // The <Canvas> runs frameloop="demand": it only paints when invalidate() is called.
  // We self-drive a ~30fps loop from the frame below WHILE something is animating, and
  // stop scheduling once everything settles so the GPU idles at 0fps. Gestures and prop
  // changes call wake() to resume; the app backgrounding pauses it entirely.
  const invalidate = useThree((s) => s.invalidate);
  const nextFrame = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pausedRef = useRef(false);
  const settleUntil = useRef(0);

  useEffect(() => {
    refs.wake.current = () => {
      settleUntil.current = Date.now() + 500; // render through short eases after a kick
      if (!pausedRef.current) invalidate();
    };
    return () => {
      refs.wake.current = () => {};
    };
  }, [invalidate, refs]);

  // The tension arcs flow continuously, so when the set of ties CHANGES (incl. first
  // appearing) kick the loop — otherwise a sleeping globe wouldn't start animating them.
  useEffect(() => {
    refs.wake.current?.();
  }, [arcs, refs]);

  // Pause rendering while the app is backgrounded — no GPU/CPU burn off-screen.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (st) => {
      if (st === "active") {
        pausedRef.current = false;
        invalidate();
      } else {
        pausedRef.current = true;
        if (nextFrame.current) {
          clearTimeout(nextFrame.current);
          nextFrame.current = null;
        }
      }
    });
    return () => sub.remove();
  }, [invalidate]);

  useEffect(
    () => () => {
      if (nextFrame.current) clearTimeout(nextFrame.current);
    },
    [],
  );

  // Re-arm the loop (and render through the ease) when focus / layout / data changes —
  // demand mode otherwise paints a single frame per commit, cutting eases short.
  useEffect(() => {
    refs.wake.current?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    focusedId,
    hoveredMarkerId,
    focusedMarkerId,
    rightInset,
    alerts,
    askMarkers,
    gizmos,
    countries,
    regions,
  ]);

  useFrame((frame, delta) => {
    const g = group.current;
    if (!g) return;
    // SOLE rule for the idle spin: spin while the pointer is OFF the globe, freeze while it
    // hovers the globe — ocean (overOcean), land (focusedId), or a marker (hoveredMarkerId) —
    // OR while a pin's card is open (focusedMarkerId), so the open card never drifts.
    const pointerOverGlobe =
      overOcean.current ||
      focusedId !== null ||
      hoveredMarkerId !== null ||
      focusedMarkerId !== null;
    if (refs.dragging.current) refs.target.current = null; // manual control cancels focus
    // A drag or a fly-to overrides the scroll-zoom cursor lock (the user took the wheel).
    if (refs.dragging.current || refs.target.current) zoomAnchor.current = null;
    const tgt = refs.target.current;
    if (tgt) {
      // Ease to the focus orientation along the SHORTEST yaw path (the globe may have
      // spun many turns), and zoom in — gives the "fly to the country" feel.
      const dy = Math.atan2(
        Math.sin(tgt.yaw - refs.rot.current.yaw),
        Math.cos(tgt.yaw - refs.rot.current.yaw),
      );
      const dpitch = tgt.pitch - refs.rot.current.pitch;
      const dzoom = tgt.zoom - refs.zoom.current;
      refs.rot.current.yaw += dy * 0.12;
      refs.rot.current.pitch += dpitch * 0.12;
      refs.zoom.current += dzoom * 0.12;
      // The ease is asymptotic, so the target was previously NEVER released — leaving the
      // loop scheduling frames forever. Once we're within a hair of the target (sub-pixel /
      // sub-0.1°), END the fly-to: clears `needsMore` below so the full-rate burst stops and
      // the loop can settle to 0fps. The tiny remaining error is imperceptible.
      if (Math.abs(dy) < 2e-3 && Math.abs(dpitch) < 2e-3 && Math.abs(dzoom) < 2e-3) {
        refs.target.current = null;
      }
    } else if (autoSpin && !pointerOverGlobe) {
      refs.rot.current.yaw += delta * 0.05; // idle auto-spin (landing only; off-globe only)
    }
    g.rotation.y = refs.rot.current.yaw;
    g.rotation.x = Math.max(-1.2, Math.min(1.2, refs.rot.current.pitch));
    const s = g.scale.x + (refs.zoom.current - g.scale.x) * 0.2;
    g.scale.setScalar(s);
    // Desktop: when the side panel covers the right, shift the RENDER left so the focused
    // content centres in the VISIBLE area. We use a camera view-offset (a projection
    // shift) rather than translating the globe in world space: a world shift moves the
    // near surface (where the focused country sits) MORE pixels than the globe centre and
    // overshoots, whereas a projection offset shifts all depths by the same pixels.
    const cam = camera as PerspectiveCamera;
    offsetPx.current += (rightInset / 2 - offsetPx.current) * 0.12;
    if (offsetPx.current > 0.5) {
      cam.setViewOffset(size.width, size.height, offsetPx.current, 0, size.width, size.height);
    } else if (cam.view?.enabled) {
      cam.clearViewOffset();
    }

    // Scroll-zoom CURSOR LOCK. Reproject the captured surface point through THIS tick's
    // rotation+scale and steer the rotation so it returns to the cursor's NDC — pinning the
    // exact point under the pointer as the scale eases (so you land on target, smoothly). The
    // gain mirrors the drag math (px-of-content-move → rotation) using the LIVE scale so the
    // correction tracks the easing zoom. Two guards keep it from going unstable: a per-tick
    // STEP cap so an ill-conditioned (near-limb) error can't lurch, and a release if the point
    // rotates onto the FAR hemisphere (it can't sit under a front cursor). Ends once settled.
    const anchor = zoomAnchor.current;
    if (anchor) {
      g.updateMatrix(); // local matrix == world matrix (group is a direct scene child)
      _anchor.copy(anchor.dir).multiplyScalar(PLANET_RADIUS).applyMatrix4(g.matrix); // world
      if (_anchor.z < 0) {
        // Far hemisphere → unreachable under a front-facing cursor. Drop the lock instead of
        // chasing it (that unbounded chase is what spun the camera when zoomed low/out).
        zoomAnchor.current = null;
      } else {
        _anchor.project(cam);
        // Perspective correction (the fix for the zoom-in flicker): the linear drag gain
        // assumes the surface sits at the globe-CENTRE distance, but zoomed in the FRONT
        // surface is much closer to the camera and magnifies far more on screen — so the
        // closed loop over-corrects harder the deeper you zoom, oscillating into a flicker.
        // Scaling by (front-surface distance / centre distance) keeps the loop gain ~1 at
        // every zoom; the extra 0.85 leaves a stability margin so it eases in without ringing.
        const CAM_Z = 3.2; // camera sits at z = 3.2 (see <Canvas camera> in Globe)
        const persp = Math.max(0.12, (CAM_Z - g.scale.x * PLANET_RADIUS) / CAM_Z);
        const gain = (DRAG_K / (g.scale.x * (size.height || 600))) * persp * 0.85;
        const STEP = 0.1; // max rad/tick — a hard cap against any single-frame lurch
        const dyaw = (anchor.ndcX - _anchor.x) * (size.width / 2) * gain;
        const dpitch = -(anchor.ndcY - _anchor.y) * (size.height / 2) * gain;
        refs.rot.current.yaw += Math.max(-STEP, Math.min(STEP, dyaw));
        refs.rot.current.pitch = Math.max(
          -1.2,
          Math.min(1.2, refs.rot.current.pitch + Math.max(-STEP, Math.min(STEP, dpitch))),
        );
        g.rotation.y = refs.rot.current.yaw;
        g.rotation.x = refs.rot.current.pitch;
        g.updateMatrix();
        if (Math.abs(refs.zoom.current - g.scale.x) < 1e-3) zoomAnchor.current = null;
      }
    }

    // Project the markers worth labelling to SCREEN px for the wrapper's overlay
    // bubbles: every ask result (always-on place tag) + the hovered marker (detail).
    // Front-hemisphere only, so labels never bleed through from the far side. The
    // overlay de-dupes identical frames, so a still globe costs zero React updates.
    if (onMarkersProject) {
      // Refresh ONLY this group's own matrix (cheap) — never updateMatrixWorld(), which
      // would recurse into the hundreds of country meshes every frame. The group is a
      // direct scene child (identity parent), so its local matrix IS its world matrix.
      g.updateMatrix();
      const out: ProjectedMarker[] = [];
      const add = (
        id: string,
        kind: "ask" | "alert",
        dir: Vec3,
        label: string,
        detail: string,
        color: string,
        extra?: Partial<
          Pick<
            ProjectedMarker,
            "category" | "severity" | "count" | "developing" | "updatedAt"
          >
        >,
      ) => {
        _proj.set(dir.x * ALERT_RADIUS, dir.y * ALERT_RADIUS, dir.z * ALERT_RADIUS);
        _proj.applyMatrix4(g.matrix); // group local matrix == world matrix
        if (_proj.z <= 0.02) return; // far hemisphere → occluded by the globe
        _proj.project(cam);
        if (_proj.z > 1) return; // behind the camera/far plane
        out.push({
          id,
          kind,
          x: ((_proj.x + 1) / 2) * size.width,
          y: ((1 - _proj.y) / 2) * size.height,
          label,
          detail,
          color,
          hovered: id === hoveredMarkerId,
          ...extra,
        });
      };
      for (const m of askMarkers) {
        add(m.id, "ask", m.dir, m.label, m.detail ?? "", colors.accent);
      }
      // Every worldview EVENT is drawn as a legible icon chip in the 2D overlay (not an
      // abstract 3D shape) — so project ALL of them (front hemisphere only). The chip's
      // icon/colour/size come from the category + severity; the headline rides `detail`.
      for (const a of alerts) {
        add(a.id, "alert", a.dir, "", a.title, EVENT_CATEGORIES[a.category].color, {
          category: a.category,
          severity: a.severity,
          count: a.count,
          developing: a.developing,
          updatedAt: a.updatedAt,
        });
      }
      // LINK ties: a flag/icon BADGE rides each PHYSICAL-link arc (origin → destination).
      // Sample the travelling point on the SAME bowed great circle as the line and project
      // it, so the badge sits on the arc and flows with it (tension ties keep their 3D comet).
      const tBase = frame.clock.elapsedTime * ARC_FLOW_SPEED;
      arcs.forEach((arc, i) => {
        if (!arc.kind) return;
        const t = (tBase + i * 0.13) % 1;
        const p = greatCirclePoint(arc.a, arc.b, t, ARC_BASE_RADIUS, ARC_LIFT);
        _proj.set(p.x, p.y, p.z).applyMatrix4(g.matrix);
        if (_proj.z <= 0.02) return; // far hemisphere → occluded by the globe
        _proj.project(cam);
        if (_proj.z > 1) return;
        out.push({
          id: `link:${arc.id}`,
          kind: "link",
          x: ((_proj.x + 1) / 2) * size.width,
          y: ((1 - _proj.y) / 2) * size.height,
          label: "",
          detail: "",
          color: arc.color ?? ARC_COLOR,
          hovered: false,
          linkKind: arc.kind,
          fromCc: arc.fromCc,
        });
      });
      onMarkersProject(out);
    }

    // Keep the on-demand loop alive at ~30fps only while something is actually moving;
    // when the orientation/zoom/offset have settled AND no markers are pulsing, stop
    // scheduling so the GPU drops to 0fps. Gestures/prop-changes call wake() to resume.
    const easingZoom = Math.abs(refs.zoom.current - g.scale.x) > 1e-3;
    const easingOffset = Math.abs(rightInset / 2 - offsetPx.current) > 0.5;
    const spinning = autoSpin && !pointerOverGlobe;
    // ASK pins pulse AND the arcs flow (tension comets + link flag/icon badges) → both keep
    // the loop awake AND (via fullRate below) run it at FULL vsync rate: a small, fast badge
    // the eye TRACKS judders at the throttled, non-vsync 30fps, so these steady-state
    // animations get the smooth path too. Worldview EVENT chips are static 2D overlay icons,
    // so they alone never keep it awake — the globe sleeps (0fps) with events on screen and
    // only re-projects them on a gesture/data change.
    const markersLive = askMarkers.length > 0 || arcs.length > 0;
    const locking = zoomAnchor.current !== null; // cursor-lock needs full-rate steering
    // Transient camera EASES move the whole globe and are loop-driven (no per-event driver
    // once kicked): the fly-to (auto focus/zoom), the scroll/pinch ZOOM ease (a wheel notch
    // sets a target, then `scale` chases it over many frames), and the panel OFFSET shift.
    // At the throttled 30fps — not vsync-aligned, and it stalls under load (e.g. a new
    // place's geometry building) — these read as choppy/low-fps. So drive them at the
    // display's FULL rate; they're short, self-terminating bursts. The steady-state loops
    // (idle spin, marker pulse, post-kick settle) stay at 30fps to save power.
    const flyingTo = refs.target.current !== null;
    const easingCamera = flyingTo || easingZoom || easingOffset || locking;
    // DRAGGING also runs full-rate: the 2D event chips are re-projected each tick to track
    // the surface, and at the throttled 30fps they visibly trail the (faster-rendered) globe
    // under the finger. Full rate keeps chip and globe in lock-step. Ends on release.
    // `markersLive` joins it so the ARC flow + ask-pin PULSE animate at full vsync rate (the
    // small travelling badges judder at the throttled, non-vsync 30fps). Costs more GPU while
    // arcs/ask-pins are on screen — the globe still sleeps to 0fps once they're gone.
    const fullRate = easingCamera || refs.dragging.current || markersLive;
    const needsMore =
      refs.dragging.current ||
      easingCamera ||
      spinning ||
      markersLive ||
      Date.now() < settleUntil.current;
    if (nextFrame.current) {
      clearTimeout(nextFrame.current);
      nextFrame.current = null;
    }
    if (needsMore && !pausedRef.current) {
      if (fullRate) {
        // Full rate (vsync-aligned via r3f's demand loop) so the move is smooth and quick.
        // The eases above converge on their targets, so this burst self-terminates and the
        // loop falls back to the 30fps throttle (or sleeps) once everything settles.
        invalidate();
      } else {
        nextFrame.current = setTimeout(() => {
          nextFrame.current = null;
          invalidate();
        }, FRAME_MS);
      }
    }
  });

  // Scroll-wheel zoom-to-pointer. Capture the EXACT surface point under the cursor (in the
  // globe's local frame, so it rides the rotation) plus the cursor's screen NDC, then let
  // the frame loop steer the rotation each tick so that point stays pinned under the cursor
  // as the scale eases — landing precisely on target with no jitter. Cancels any fly-to.
  const onWheel = (e: ThreeEvent<WheelEvent>) => {
    e.stopPropagation();
    refs.target.current = null;
    const zoomIn = e.deltaY < 0;
    refs.zoom.current = Math.max(
      ZOOM_MIN,
      Math.min(ZOOM_MAX, refs.zoom.current * (zoomIn ? 1.12 : 1 / 1.12)),
    );
    const g = group.current;
    // Lock to the cursor on zoom-IN only. Zooming IN eases the locked point toward the view
    // centre (always reachable) so the controller stays stable; zooming OUT shrinks the globe
    // and holding a fixed off-centre cursor would force the point past the limb (unreachable),
    // which sent the camera spinning. Zoom-OUT just recedes toward the centre (no lock).
    if (zoomIn && g) {
      // worldToLocal strips the group's rotation+scale → a stable local direction; project
      // the same world hit to get the cursor's NDC (consistent with any active view offset).
      const dir = g.worldToLocal(e.point.clone()).normalize();
      _anchor.copy(e.point).project(camera);
      zoomAnchor.current = { dir, ndcX: _anchor.x, ndcY: _anchor.y };
    } else {
      zoomAnchor.current = null;
    }
    refs.wake.current?.(); // ref-only mutation → kick the on-demand loop
  };

  return (
    <>
      {/* A hemisphere + key/rim lights so the metal reads as a lit, COLOURED sphere
          rather than a black ball: pure metalness with no environment map renders
          black, so we light it generously and lower metalness so its colour shows. */}
      <hemisphereLight args={["#7d9bd6", "#0a0d12", 0.7]} />
      <ambientLight intensity={0.25} />
      <directionalLight position={[5, 4, 6]} intensity={1.5} />
      <pointLight
        position={[-6, -3, -4]}
        intensity={0.8}
        color={colors.accent}
      />
      <group ref={group}>
        {/* Atmosphere: a back-faced additive shell gives a soft rim glow / halo. */}
        <mesh scale={1.08}>
          <icosahedronGeometry args={[PLANET_RADIUS, 3]} />
          <meshBasicMaterial
            color={colors.accent}
            side={BackSide}
            transparent
            opacity={0.1}
            blending={AdditiveBlending}
            depthWrite={false}
          />
        </mesh>
        {/* The planet — a faceted icosahedron, deep ocean blue with a metallic sheen.
            Also the scroll-zoom target: it's always under the cursor (behind the land). */}
        <mesh
          onWheel={onWheel}
          // Hovering the globe (its ocean sphere) FREEZES the idle spin; leaving it resumes.
          // Land + markers are covered by focusedId / hoveredMarkerId (see pointerOverGlobe).
          onPointerOver={() => {
            overOcean.current = true;
            refs.wake.current?.();
          }}
          onPointerOut={() => {
            overOcean.current = false;
            refs.wake.current?.();
          }}
        >
          <icosahedronGeometry args={[PLANET_RADIUS, 5]} />
          <meshStandardMaterial
            color="#173049"
            metalness={0.55}
            roughness={0.32}
          />
        </mesh>
        {/* Real country shapes on top of the ocean (radius 1.0 > ocean 0.94): the
            current level's are interactive, the rest are dim background land. */}
        <Countries
          data={
            regions.length > 0 ? countries.filter((c) => !c.current) : countries
          }
          focusedId={focusedId}
          onFocus={onFocus}
          onActivate={onActivate}
          onHoverMove={onHoverMove}
        />
        {/* Subtle country separators, always on — faint borders/coastlines like an atlas. */}
        {countryOutline && (
          <Outline positions={countryOutline} color="#9fb4c9" opacity={0.18} />
        )}
        {/* Streamed province shapes for the country in focus, sitting just above the
            country fill, with crisp boundary lines so they read like a printed map. */}
        {regions.length > 0 && (
          <Countries
            data={regions}
            focusedId={focusedId}
            onFocus={onFocus}
            onActivate={onActivate}
            onHoverMove={onHoverMove}
          />
        )}
        {/* Stronger region separators, drawn once a country is in focus. */}
        {outline && (
          <Outline positions={outline} color="#0c1a27" opacity={0.85} />
        )}
        {/* Gizmos: small markers for places with no border shape (localities). */}
        {gizmos.map((d) => (
          <GlobeEntity
            key={d.id}
            data={d}
            focused={focusedId === d.id}
            onFocus={onFocus}
            onActivate={onActivate}
            onHoverMove={onHoverMove}
          />
        ))}
        {/* Worldview EVENTS are no longer drawn in 3D — they're projected (above) to legible
            2D icon CHIPS in the wrapper's overlay (crisp, constant on-screen size, tappable),
            which reads far better than abstract shapes and lets the globe sleep when idle. */}
        {/* RELATIONSHIPS: flowing great-circle ties between the zones of multi-side conflicts —
            the tension web. In the rotating group so the arcs ride the globe; drawn over the
            land but depth-tested, so ties on the far hemisphere are hidden behind the planet. */}
        {arcs.length > 0 && <Arcs arcs={arcs} />}
        {/* AI news-search results: accent pins on the places the answer is about. */}
        <AskMarkers
          markers={askMarkers}
          onPress={onAskMarkerPress}
          onHover={onMarkerHover}
          hoveredId={hoveredMarkerId}
        />
      </group>
    </>
  );
});
