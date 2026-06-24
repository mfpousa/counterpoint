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

import React, { memo, useEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { AppState } from "react-native";
import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import {
  AdditiveBlending,
  BackSide,
  DoubleSide,
  Quaternion,
  SRGBColorSpace,
  TextureLoader,
  Vector3,
} from "three";
import type { Group, Mesh, MeshBasicMaterial, PerspectiveCamera, Texture } from "three";
import { colors } from "../../theme";
import { hashId, type Vec3 } from "../../lib/globeLayout";
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
const WHEEL_PULL = 0.14; // how strongly scroll-zoom-in pulls the cursor's point to centre
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

/** Quaternion (as [x,y,z,w]) orienting a marker's local +Y OUTWARD along `dir`, so
 *  shapes sit upright on the globe like pins/spikes rather than lying flat. */
function outwardQuat(dir: Vec3): [number, number, number, number] {
  const q = new Quaternion().setFromUnitVectors(
    UP,
    new Vector3(dir.x, dir.y, dir.z).normalize(),
  );
  return [q.x, q.y, q.z, q.w];
}

/** Per-category CORE geometry — a distinct silhouette so the worldview is legible at
 *  a glance: a spike for conflict, a shard for disaster, a gem for health, a ring for
 *  diplomacy, a cube for unrest, a faceted ball for tech, a bar for economy, a dot
 *  otherwise. Sized by `r` (gravity). Heights are tuned to sit on the surface. */
function CategoryGeometry({ category, r }: { category: EventCategory; r: number }) {
  switch (category) {
    case "conflict":
      return <coneGeometry args={[r * 1.0, r * 2.3, 4]} />; // 4-sided spike
    case "disaster":
      return <tetrahedronGeometry args={[r * 1.35]} />; // jagged shard
    case "health":
      return <octahedronGeometry args={[r * 1.3]} />; // gem
    case "diplomacy":
      return <torusGeometry args={[r * 1.0, r * 0.38, 10, 18]} />; // ring
    case "unrest":
      return <boxGeometry args={[r * 1.4, r * 1.4, r * 1.4]} />; // cube
    case "tech":
      return <icosahedronGeometry args={[r * 1.25, 0]} />; // faceted ball
    case "economy":
      return <cylinderGeometry args={[r * 0.8, r * 0.8, r * 2.1, 12]} />; // bar
    default:
      return <sphereGeometry args={[r * 1.05, 14, 14]} />; // generic dot
  }
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

/** One world-event marker: a category-SHAPED, category-COLOURED core standing on the
 *  surface, a looping sonar ring, and a hit sphere (→ open the story / block country
 *  hover). Phase is desynced per id so they shimmer; hovering pops the core. */
function AlertMarker({
  alert,
  onPress,
  onHover,
  hovered,
}: {
  alert: GeoAlert;
  onPress?: (id: string) => void;
  onHover?: (id: string | null) => void;
  hovered: boolean;
}) {
  const root = useRef<Group>(null);
  const core = useRef<Mesh>(null);
  const ring = useRef<Mesh>(null);
  const ringMat = useRef<MeshBasicMaterial>(null);
  const r = 0.008 + alert.severity * 0.011; // smaller: a dense cluster of countries stays legible
  const color = EVENT_CATEGORIES[alert.category].color;
  const phase = (hashId(alert.id) % 1000) / 1000;
  const quat = useMemo(
    () => outwardQuat(alert.dir),
    [alert.dir.x, alert.dir.y, alert.dir.z],
  );
  useFrame((state) => {
    const tt = (state.clock.elapsedTime * 0.7 + phase) % 1;
    if (ring.current) ring.current.scale.setScalar(1 + tt * 2.8);
    if (ringMat.current) ringMat.current.opacity = (1 - tt) * 0.4;
    if (core.current) {
      const target = hovered ? 1.5 : 1;
      core.current.scale.setScalar(core.current.scale.x + (target - core.current.scale.x) * 0.2);
    }
    // Cap the marker's screen size: undo the globe-zoom scaling beyond MARKER_SIZE_CAP.
    if (root.current) {
      const z = root.current.parent?.scale.x ?? 1;
      root.current.scale.setScalar(Math.min(1, MARKER_SIZE_CAP / z));
    }
  });
  return (
    <group
      ref={root}
      position={[alert.dir.x * ALERT_RADIUS, alert.dir.y * ALERT_RADIUS, alert.dir.z * ALERT_RADIUS]}
      quaternion={quat}
    >
      <mesh ref={core} position={[0, r * 1.2, 0]}>
        <CategoryGeometry category={alert.category} r={r} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={hovered ? 1.2 : 0.55}
          metalness={0.3}
          roughness={0.4}
        />
      </mesh>
      <PingRing inner={r * 1.3} outer={r * 1.75} color={color} ringRef={ring} matRef={ringMat} />
      {/* Only when the story's PROTAGONIST is a nation: a flag gizmo anchored on the
          marker's CORE (same point as the visible shape) so it never drifts relative to
          the pin as the globe turns; the pole then rises within its billboard. */}
      {alert.iso2 && (
        <group position={[0, r * 1.2, 0]}>
          <FlagModel iso2={alert.iso2} />
        </group>
      )}
      <MarkerHit id={alert.id} radius={Math.max(r * 2.6, 0.04)} y={r} onPress={onPress} onHover={onHover} />
    </group>
  );
}

function Alerts({
  alerts,
  onPress,
  onHover,
  hoveredId,
}: {
  alerts: GeoAlert[];
  onPress?: (id: string) => void;
  onHover?: (id: string | null) => void;
  hoveredId: string | null;
}) {
  return (
    <>
      {alerts.map((a) => (
        <AlertMarker
          key={a.id}
          alert={a}
          onPress={onPress}
          onHover={onHover}
          hovered={hoveredId === a.id}
        />
      ))}
    </>
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

// Loaded flag textures, cached by ISO-2 so each country's PNG is fetched once.
const _flagTextures = new Map<string, Texture>();
const FLAG_W = 0.038;
const FLAG_H = 0.024;
// How far up the BILLBOARD's own (screen-up) axis the pole starts. The flag is anchored
// on the marker core, so this is just enough for the pole to emerge from the pin rather
// than a radial lift (which would offset it diagonally on screen, varying with angle).
const FLAG_BASE = 0.006;

/** A little 3D FLAG-on-a-pole gizmo, textured with the country's flag image
 *  (flagcdn.com). It BILLBOARDS to the camera so the cloth is always readable, and the
 *  cloth WAVES. Its ANCHOR sits AT the pin (so it never drifts off diagonally); the pole
 *  is raised along the billboard's screen-up axis (FLAG_BASE) to clear the marker.
 *  Rendered only for a pin whose story protagonist is a nation. Degrades to nothing if
 *  the texture can't load (offline / no remote loader). */
function FlagModel({ iso2 }: { iso2: string }) {
  const grp = useRef<Group>(null);
  const cloth = useRef<Mesh>(null);
  const base = useRef<Float32Array | null>(null); // the cloth's rest vertices, for the wave
  const camera = useThree((s) => s.camera);
  const [tex, setTex] = useState<Texture | null>(() => _flagTextures.get(iso2) ?? null);

  useEffect(() => {
    if (!iso2) return;
    const cached = _flagTextures.get(iso2);
    if (cached) {
      setTex(cached);
      return;
    }
    let cancelled = false;
    try {
      new TextureLoader().load(
        `https://flagcdn.com/w80/${iso2}.png`,
        (t) => {
          t.colorSpace = SRGBColorSpace;
          _flagTextures.set(iso2, t);
          if (!cancelled) setTex(t);
        },
        undefined,
        () => {}, // 404 / network / unsupported loader → just no flag
      );
    } catch {
      /* TextureLoader unavailable in this runtime — no flag */
    }
    return () => {
      cancelled = true;
    };
  }, [iso2]);

  useFrame((state) => {
    // Billboard the whole gizmo to the camera (independent of the globe's spin), then
    // flip so the texture's FRONT faces us. lookAt accounts for the parent transform.
    if (grp.current) {
      grp.current.lookAt(camera.position);
      grp.current.rotateY(Math.PI);
    }
    // Wave the cloth: vertices at the pole (rest x = -FLAG_W/2) stay put; the free edge
    // moves most. A depth RIPPLE plus an exaggerated UP/DOWN flap so the motion reads even
    // when the flag is small. Computed from the captured REST positions so it never drifts.
    const geo = cloth.current?.geometry;
    if (geo) {
      const pos = geo.attributes.position;
      if (!base.current) base.current = (pos.array as Float32Array).slice();
      const b = base.current;
      const t = state.clock.elapsedTime * 2.6;
      for (let i = 0; i < pos.count; i++) {
        const bx = b[i * 3];
        const by = b[i * 3 + 1];
        const f = (bx + FLAG_W / 2) / FLAG_W; // 0 at the pole edge → 1 at the free edge
        const phase = bx * 70 + t;
        pos.setZ(i, Math.sin(phase) * 0.0045 * f); // ripple toward/away (depth)
        pos.setY(i, by + Math.sin(phase + 1.3) * 0.0045 * f); // gentle up/down flap
      }
      pos.needsUpdate = true;
    }
  });

  if (!tex) return null;
  return (
    <group ref={grp}>
      {/* Pole: ON the group origin (x=0) so it lands exactly on the pin, rising up. */}
      <mesh position={[0, FLAG_BASE + FLAG_H, 0]}>
        <cylinderGeometry args={[0.001, 0.001, FLAG_H * 2, 6]} />
        <meshBasicMaterial color="#e2e8f0" />
      </mesh>
      {/* Cloth: flies OUT from the pole (its near edge at the pole/pin), and waves —
          so the pin aligns with the POLE, not the flag's centre. */}
      <mesh ref={cloth} position={[FLAG_W / 2, FLAG_BASE + FLAG_H * 1.55, 0]}>
        <planeGeometry args={[FLAG_W, FLAG_H, 14, 2]} />
        <meshBasicMaterial map={tex} side={DoubleSide} toneMapped={false} />
      </mesh>
    </group>
  );
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

/** A marker projected to 2D screen space, for the wrapper's overlay bubbles. */
export interface ProjectedMarker {
  id: string;
  kind: "ask" | "alert";
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
  onAlertPress,
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
  /** Tapping a worldview marker opens its story. */
  onAlertPress?: (id: string) => void;
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
  // Eased horizontal CAMERA view-offset (px) so the globe slides smoothly when the side
  // panel opens/closes. A projection offset (not a world translation) shifts EVERY depth
  // by the same pixels, so the focused country on the near surface lands exactly on the
  // visible centre instead of overshooting.
  const offsetPx = useRef(0);

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

  useFrame((_, delta) => {
    const g = group.current;
    if (!g) return;
    if (refs.dragging.current) refs.target.current = null; // manual control cancels focus
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
    } else if (
      autoSpin &&
      focusedId === null &&
      hoveredMarkerId === null && // freeze the spin while a pin is hovered so its bubble is readable
      focusedMarkerId === null && // …and while a pin's card is open (so it doesn't drift)
      !refs.dragging.current
    ) {
      refs.rot.current.yaw += delta * 0.05; // idle auto-spin (landing only)
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
        });
      };
      for (const m of askMarkers) {
        add(m.id, "ask", m.dir, m.label, m.detail ?? "", colors.accent);
      }
      // Project the hovered AND focused alerts (deduped) so their bubble / card can render.
      for (const aid of new Set([hoveredMarkerId, focusedMarkerId])) {
        if (!aid) continue;
        const ha = alerts.find((a) => a.id === aid);
        if (!ha) continue; // an ask marker id (already added) or stale
        const more = (ha.count ?? 1) - 1;
        const detail = more > 0 ? `${ha.title}  ·  +${more} more here` : ha.title;
        add(ha.id, "alert", ha.dir, "", detail, EVENT_CATEGORIES[ha.category].color);
      }
      onMarkersProject(out);
    }

    // Keep the on-demand loop alive at ~30fps only while something is actually moving;
    // when the orientation/zoom/offset have settled AND no markers are pulsing, stop
    // scheduling so the GPU drops to 0fps. Gestures/prop-changes call wake() to resume.
    const easingZoom = Math.abs(refs.zoom.current - g.scale.x) > 1e-3;
    const easingOffset = Math.abs(rightInset / 2 - offsetPx.current) > 0.5;
    const spinning =
      autoSpin &&
      focusedId === null &&
      hoveredMarkerId === null &&
      focusedMarkerId === null &&
      !refs.dragging.current;
    const markersLive = alerts.length > 0 || askMarkers.length > 0;
    // Transient camera EASES move the whole globe and are loop-driven (no per-event driver
    // once kicked): the fly-to (auto focus/zoom), the scroll/pinch ZOOM ease (a wheel notch
    // sets a target, then `scale` chases it over many frames), and the panel OFFSET shift.
    // At the throttled 30fps — not vsync-aligned, and it stalls under load (e.g. a new
    // place's geometry building) — these read as choppy/low-fps. So drive them at the
    // display's FULL rate; they're short, self-terminating bursts. The steady-state loops
    // (idle spin, marker pulse, post-kick settle) stay at 30fps to save power.
    const flyingTo = refs.target.current !== null;
    const easingCamera = flyingTo || easingZoom || easingOffset;
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
      if (easingCamera) {
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

  // Scroll-wheel zoom that pulls the point under the cursor toward the view centre as it
  // zooms in (the classic "zoom to pointer"). Manual zoom cancels any in-flight fly-to;
  // when a place is selected the frame loop still clamps the nudge to its bounds.
  const onWheel = (e: ThreeEvent<WheelEvent>) => {
    e.stopPropagation();
    refs.target.current = null;
    const zoomIn = e.deltaY < 0;
    refs.zoom.current = Math.max(
      ZOOM_MIN,
      Math.min(ZOOM_MAX, refs.zoom.current * (zoomIn ? 1.12 : 1 / 1.12)),
    );
    if (zoomIn) {
      // e.pointer is NDC (x right, y up, 0 = centre): rotate so the pointed point
      // shifts toward the centre (drag the content away from the cursor).
      refs.rot.current.yaw -= e.pointer.x * WHEEL_PULL;
      refs.rot.current.pitch += e.pointer.y * WHEEL_PULL;
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
        <mesh onWheel={onWheel}>
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
        {/* Worldview: category-SHAPED, gravity-sized event markers (tap to open,
            hover for the headline; hovering blocks the country behind). HIDDEN while an
            AI search is showing its own pins, so the answer's places stand alone. */}
        {askMarkers.length === 0 && (
          <Alerts
            alerts={alerts}
            onPress={onAlertPress}
            onHover={onMarkerHover}
            hoveredId={hoveredMarkerId}
          />
        )}
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
