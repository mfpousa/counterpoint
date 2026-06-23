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

import React, { memo, useRef } from "react";
import type { MutableRefObject } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { AdditiveBlending, BackSide, DoubleSide } from "three";
import type { Group, Mesh } from "three";
import { colors } from "../../theme";
import type { Vec3 } from "../../lib/globeLayout";

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
}

const PLANET_RADIUS = 0.94; // ocean sphere — sits BELOW the land shell (radius 1.0)
const ENTITY_RADIUS = 1.05;
const OFF = "#000000";

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
}: {
  data: GlobeEntityData;
  focused: boolean;
  onFocus: (id: string | null) => void;
  onActivate: (id: string) => void;
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
      position={[data.dir.x * ENTITY_RADIUS, data.dir.y * ENTITY_RADIUS, data.dir.z * ENTITY_RADIUS]}
      onClick={(e: ThreeEvent<MouseEvent>) => {
        e.stopPropagation();
        onActivate(data.id);
      }}
      onPointerOver={(e: ThreeEvent<PointerEvent>) => {
        e.stopPropagation();
        onFocus(data.id);
      }}
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
}

const LAND_INERT = "#3b4a5e"; // the rest of the world (not selectable at this level)
const LAND_HERE = "#48637f"; // the place we're currently inside
const LAND_DRILL = "#5d7b9c"; // a child you can drill into
const LAND_READY = "#6f93c4"; // a child that has its own feed

const CountryMesh = memo(function CountryMesh({
  c,
  focused,
  onFocus,
  onActivate,
}: {
  c: GlobeCountry;
  focused: boolean;
  onFocus: (id: string | null) => void;
  onActivate: (id: string) => void;
}) {
  const interactive = c.entityId !== null;
  const hot = focused || c.active;
  let color = LAND_INERT;
  if (c.current) color = LAND_HERE;
  if (interactive) color = c.selectable ? LAND_READY : LAND_DRILL;
  return (
    <mesh
      scale={hot ? 1.012 : 1}
      frustumCulled={false}
      onPointerOver={
        interactive
          ? (e: ThreeEvent<PointerEvent>) => {
              e.stopPropagation();
              onFocus(c.entityId);
            }
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
        emissiveIntensity={c.active ? 0.5 : focused ? 0.9 : 0}
        side={DoubleSide}
      />
    </mesh>
  );
});

/** All country shapes; the current level's are interactive, the rest are dim land. */
function Countries({
  data,
  focusedId,
  onFocus,
  onActivate,
}: {
  data: GlobeCountry[];
  focusedId: string | null;
  onFocus: (id: string | null) => void;
  onActivate: (id: string) => void;
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
        />
      ))}
    </>
  );
}

export function GlobeScene({
  countries,
  gizmos,
  focusedId,
  onFocus,
  onActivate,
  refs,
}: {
  countries: GlobeCountry[];
  gizmos: GlobeEntityData[];
  focusedId: string | null;
  onFocus: (id: string | null) => void;
  onActivate: (id: string) => void;
  refs: GlobeViewRefs;
}) {
  const group = useRef<Group>(null);
  useFrame((_, delta) => {
    const g = group.current;
    if (!g) return;
    // Idle auto-spin; halted while the reader is dragging so control feels direct.
    if (!refs.dragging.current) refs.rot.current.yaw += delta * 0.05;
    g.rotation.y = refs.rot.current.yaw;
    g.rotation.x = Math.max(-1.2, Math.min(1.2, refs.rot.current.pitch));
    const z = refs.zoom.current;
    const s = g.scale.x + (z - g.scale.x) * 0.2;
    g.scale.setScalar(s);
  });

  return (
    <>
      {/* A hemisphere + key/rim lights so the metal reads as a lit, COLOURED sphere
          rather than a black ball: pure metalness with no environment map renders
          black, so we light it generously and lower metalness so its colour shows. */}
      <hemisphereLight args={["#7d9bd6", "#0a0d12", 0.7]} />
      <ambientLight intensity={0.25} />
      <directionalLight position={[5, 4, 6]} intensity={1.5} />
      <pointLight position={[-6, -3, -4]} intensity={0.8} color={colors.accent} />
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
        {/* The planet — a faceted icosahedron, deep ocean blue with a metallic sheen. */}
        <mesh>
          <icosahedronGeometry args={[PLANET_RADIUS, 5]} />
          <meshStandardMaterial color="#173049" metalness={0.55} roughness={0.32} />
        </mesh>
        {/* Real country shapes on top of the ocean (radius 1.0 > ocean 0.94): the
            current level's are interactive, the rest are dim background land. */}
        <Countries
          data={countries}
          focusedId={focusedId}
          onFocus={onFocus}
          onActivate={onActivate}
        />
        {/* Gizmos: small markers for places with no border shape (regions/localities). */}
        {gizmos.map((d) => (
          <GlobeEntity
            key={d.id}
            data={d}
            focused={focusedId === d.id}
            onFocus={onFocus}
            onActivate={onActivate}
          />
        ))}
      </group>
    </>
  );
}
