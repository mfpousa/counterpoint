// 3D WORLD navigator — a metallic, procedurally-laid-out globe the reader spins
// and drills through (world -> continent -> country -> region), the visual twin of
// the chip-based GeoNavigator. It shares the SAME contract (activePoolId / onSelect
// / onSelectWorld / worldActive / onSetHome) so it's a drop-in alternative.
//
// Cross-platform interaction without drei's web-only OrbitControls:
//   - a React Native PanResponder on the wrapping View handles DRAG-to-rotate and
//     PINCH-to-zoom (works on web via react-native-web AND on native). It only
//     claims the gesture once the finger MOVES, so stationary taps fall through to
//     the r3f canvas and hit an entity (select); hover works on web pointers.
//   - rotation/zoom are written to refs and consumed in the frame loop (GlobeScene)
//     so spinning never re-renders React.
//
// Gestures + zoom buttons cover PC and mobile. Per-frame work lives in GlobeScene.

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
  type PanResponderGestureState,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Canvas } from "@react-three/fiber";
import { fetchCoverage, type CoverageNode, type CoverageView } from "../../lib/api";
import { geoNodeIdOf, GEO_ROOT_ID } from "../../data/geo";
import { layoutLevel, tangentRing, type Vec3 } from "../../lib/globeLayout";
import {
  buildLandGeometry,
  computeCentroids,
  type GeoCentroids,
  type LandGeometry,
} from "../../lib/geoShapes";
import countries110m from "../../data/world/countries-110m.json";
import { useT } from "../../store/AppContext";
import { colors, font, radius, spacing } from "../../theme";
import { GlobeScene, type GlobeEntityData, type GlobeViewRefs } from "./GlobeScene";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const ZOOM_MIN = 0.6;
const ZOOM_MAX = 2.6;
const LAND_RADIUS = 1.0;

export function Globe({
  activePoolId,
  home,
  onSelect,
  onSelectWorld,
  worldActive,
  onSetHome,
  height = 320,
}: {
  activePoolId?: string;
  home?: string;
  onSelect: (poolId?: string) => void;
  onSelectWorld?: () => void;
  worldActive?: boolean;
  onSetHome?: (nodeId: string) => void;
  /** Canvas height in px (it sits inside a scroll view). */
  height?: number;
}) {
  const t = useT();
  const [browse, setBrowse] = useState<string>(
    (activePoolId && geoNodeIdOf(activePoolId)) || home || GEO_ROOT_ID,
  );
  const [view, setView] = useState<CoverageView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [focusedId, setFocusedId] = useState<string | null>(null);

  // View state the gesture layer mutates and the frame loop reads (no re-renders).
  const refs: GlobeViewRefs = {
    rot: useRef({ yaw: 0, pitch: 0 }),
    zoom: useRef(1),
    dragging: useRef(false),
  };
  const lastDrag = useRef({ x: 0, y: 0 });
  const pinchDist = useRef(0);

  // Follow an externally-committed pool so the globe opens where the feed is.
  useEffect(() => {
    const n = activePoolId && geoNodeIdOf(activePoolId);
    if (n) setBrowse(n);
  }, [activePoolId]);

  // Fetch the coverage for the focused node whenever the browse cursor moves.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    setFocusedId(null);
    fetchCoverage(browse)
      .then((v) => {
        if (!cancelled) setView(v);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [browse]);

  // Build the merged land mesh + per-country/continent pin anchors from the bundled
  // world borders. Done once (memoised) and only when the globe is actually mounted.
  const worldGeo = useMemo<{ land: LandGeometry; centroids: GeoCentroids } | null>(() => {
    try {
      const geo = countries110m as unknown as Parameters<typeof buildLandGeometry>[0];
      return { land: buildLandGeometry(geo, LAND_RADIUS), centroids: computeCentroids(geo) };
    } catch (e) {
      console.warn("[globe] world borders unavailable:", e);
      return null;
    }
  }, []);

  // The drill-down options (covered places + anything drillable), placed on the
  // sphere by the deterministic procedural layout (seeded by the parent id).
  const entities: GlobeEntityData[] = useMemo(() => {
    const children = (view?.children ?? []).filter((n) => n.state === "ready" || n.hasChildren);
    const proc = layoutLevel(
      children.map((c) => c.nodeId),
      browse,
    );
    const centroids = worldGeo?.centroids ?? null;
    // Region pins have no real coordinates, so fan them in a ring around their
    // country's centroid instead of stacking them on one point.
    let regionRing: Map<string, Vec3> | null = null;
    if (centroids && view?.node.level === "country") {
      const base = centroids.byIso2.get(view.node.nodeId);
      if (base) {
        const ids = children.map((c) => c.nodeId).sort();
        const ring = tangentRing(base, ids.length);
        regionRing = new Map(ids.map((id, i) => [id, ring[i]]));
      }
    }
    const realDir = (c: CoverageNode): Vec3 | undefined => {
      if (!centroids) return undefined;
      if (c.level === "country") return centroids.byIso2.get(c.nodeId);
      if (c.level === "continent") return centroids.byContinent.get(c.nodeId);
      if (c.level === "region") return centroids.byIso2.get(c.nodeId.split("-")[0]);
      return undefined;
    };
    return children.map((c) => ({
      id: c.nodeId,
      poolId: c.poolId,
      label: c.label,
      dir: regionRing?.get(c.nodeId) ?? realDir(c) ?? proc.get(c.nodeId) ?? { x: 0, y: 0, z: 1 },
      selectable: c.state === "ready",
      active: !!activePoolId && c.poolId === activePoolId,
      hasChildren: c.hasChildren,
    }));
  }, [view, browse, activePoolId, worldGeo]);

  const focused = entities.find((e) => e.id === focusedId) ?? null;
  const atRoot = browse === GEO_ROOT_ID;
  const nodeLabel = view?.node.label ?? t("geo.world");

  const childById = (id: string): CoverageNode | undefined =>
    (view?.children ?? []).find((c) => c.nodeId === id);

  // Tap an entity: commit it as the feed if it has its own outlets AND drill in if
  // it has children (mirrors the chip navigator's behaviour exactly).
  const activate = (id: string) => {
    const node = childById(id);
    if (!node) return;
    if (node.state === "ready") onSelect(node.poolId);
    if (node.hasChildren) setBrowse(node.nodeId);
  };

  const goUp = () => {
    const path = view?.path ?? [];
    const parent = path.length >= 2 ? path[path.length - 2] : null;
    setBrowse(parent ? parent.nodeId : GEO_ROOT_ID);
  };

  const zoomBy = (factor: number) => {
    refs.zoom.current = clamp(refs.zoom.current * factor, ZOOM_MIN, ZOOM_MAX);
  };

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        // Only claim the gesture once the finger actually moves (so taps reach the
        // canvas and select an entity), or immediately for a two-finger pinch.
        onMoveShouldSetPanResponder: (e: GestureResponderEvent, g: PanResponderGestureState) =>
          Math.abs(g.dx) + Math.abs(g.dy) > 4 || (e.nativeEvent.touches?.length ?? 0) >= 2,
        onPanResponderGrant: () => {
          refs.dragging.current = true;
          lastDrag.current = { x: 0, y: 0 };
          pinchDist.current = 0;
        },
        onPanResponderMove: (e: GestureResponderEvent, g: PanResponderGestureState) => {
          const touches = e.nativeEvent.touches;
          if (touches && touches.length >= 2) {
            const dx = touches[0].pageX - touches[1].pageX;
            const dy = touches[0].pageY - touches[1].pageY;
            const dist = Math.hypot(dx, dy);
            if (pinchDist.current > 0 && dist > 0) zoomBy(dist / pinchDist.current);
            pinchDist.current = dist;
            return;
          }
          // Incremental delta since the last move event → smooth rotation.
          const dX = g.dx - lastDrag.current.x;
          const dY = g.dy - lastDrag.current.y;
          lastDrag.current = { x: g.dx, y: g.dy };
          refs.rot.current.yaw += dX * 0.01;
          refs.rot.current.pitch += dY * 0.01;
        },
        onPanResponderRelease: () => {
          refs.dragging.current = false;
        },
        onPanResponderTerminate: () => {
          refs.dragging.current = false;
        },
      }),
    // refs are stable; create the responder once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return (
    <View style={styles.wrap}>
      <View style={[styles.canvasWrap, { height }]} {...panResponder.panHandlers}>
        <Canvas
          camera={{ position: [0, 0, 3.2], fov: 45 }}
          onPointerMissed={() => setFocusedId(null)}
        >
          <GlobeScene
            entities={entities}
            focusedId={focusedId}
            onFocus={setFocusedId}
            onActivate={activate}
            land={worldGeo?.land ?? null}
            refs={refs}
          />
        </Canvas>

        {/* Top bar: where we are + up-one-level + pin home. */}
        <View style={styles.topBar} pointerEvents="box-none">
          {!atRoot && (
            <Pressable onPress={goUp} style={styles.iconBtn} accessibilityRole="button" accessibilityLabel={t("geo.allRegions")}>
              <Ionicons name="arrow-up" size={14} color={colors.text} />
            </Pressable>
          )}
          <View style={styles.levelPill}>
            <Ionicons name="location-outline" size={12} color={colors.textDim} />
            <Text style={styles.levelText} numberOfLines={1}>
              {nodeLabel}
            </Text>
          </View>
          {onSetHome && !atRoot ? (
            <Pressable onPress={() => onSetHome(browse)} style={styles.iconBtn} accessibilityRole="button" accessibilityLabel={t("geo.setHome")}>
              <Ionicons name={home === browse ? "home" : "home-outline"} size={13} color={home === browse ? colors.accent : colors.textDim} />
            </Pressable>
          ) : null}
        </View>

        {/* Bottom bar: focused entity + enter, world/international, and zoom. */}
        <View style={styles.bottomBar} pointerEvents="box-none">
          {focused ? (
            <Pressable
              onPress={() => activate(focused.id)}
              style={[styles.enterBtn, focused.active && styles.enterBtnActive]}
              accessibilityRole="button"
            >
              <Ionicons
                name={focused.hasChildren ? "enter-outline" : "checkmark"}
                size={13}
                color={colors.bg}
              />
              <Text style={styles.enterText} numberOfLines={1}>
                {focused.label}
              </Text>
            </Pressable>
          ) : atRoot && onSelectWorld ? (
            <Pressable
              onPress={onSelectWorld}
              style={[styles.enterBtn, worldActive && styles.enterBtnActive]}
              accessibilityRole="button"
            >
              <Ionicons name="earth" size={13} color={colors.bg} />
              <Text style={styles.enterText}>{t("geo.world")}</Text>
            </Pressable>
          ) : (
            <View style={{ flex: 1 }} />
          )}
          <View style={styles.zoomGroup}>
            <Pressable onPress={() => zoomBy(1.2)} style={styles.iconBtn} accessibilityRole="button" accessibilityLabel="Zoom in">
              <Ionicons name="add" size={16} color={colors.text} />
            </Pressable>
            <Pressable onPress={() => zoomBy(1 / 1.2)} style={styles.iconBtn} accessibilityRole="button" accessibilityLabel="Zoom out">
              <Ionicons name="remove" size={16} color={colors.text} />
            </Pressable>
          </View>
        </View>

        {loading && (
          <View style={styles.center} pointerEvents="none">
            <ActivityIndicator size="small" color={colors.accent} />
          </View>
        )}
        {error && !loading && (
          <View style={styles.center} pointerEvents="none">
            <Text style={styles.errorText}>{t("geo.error")}</Text>
          </View>
        )}

        {/* TEMP diagnostic: how many land triangles got built (remove once shapes show). */}
        <Text style={styles.debug}>
          {worldGeo ? `land ${Math.floor(worldGeo.land.positions.length / 9)} tris` : "land: none"}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.xs },
  canvasWrap: {
    borderRadius: radius.lg,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  topBar: {
    position: "absolute",
    top: spacing.sm,
    left: spacing.sm,
    right: spacing.sm,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  bottomBar: {
    position: "absolute",
    bottom: spacing.sm,
    left: spacing.sm,
    right: spacing.sm,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  levelPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    maxWidth: 200,
  },
  levelText: { color: colors.text, fontSize: font.small, fontWeight: "800" },
  iconBtn: {
    width: 30,
    height: 30,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  enterBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  enterBtnActive: { backgroundColor: colors.accent },
  enterText: { color: colors.bg, fontSize: font.small, fontWeight: "800", flexShrink: 1 },
  zoomGroup: { flexDirection: "row", gap: spacing.xs },
  center: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  errorText: { color: colors.textDim, fontSize: font.small },
  debug: {
    position: "absolute",
    left: spacing.sm,
    top: 44,
    color: colors.textFaint,
    fontSize: font.tiny,
  },
});
