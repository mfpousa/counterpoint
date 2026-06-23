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
  Keyboard,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type GestureResponderEvent,
  type PanResponderGestureState,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Canvas } from "@react-three/fiber";
import {
  fetchCoverage,
  fetchRegions,
  type CoverageNode,
  type CoverageView,
  type RegionFeature,
} from "../../lib/api";
import { geoNodeIdOf, GEO_ROOT_ID, poolIdForNode } from "../../data/geo";
import { layoutLevel, tangentRing, type Vec3 } from "../../lib/globeLayout";
import {
  buildCountryShapes,
  buildOutline,
  buildRegionShapes,
  computeCentroids,
  type CountryShape,
  type GeoCentroids,
} from "../../lib/geoShapes";
import { buildAlerts, type GeoAlert } from "../../lib/geoAlerts";
import { searchPlaces, type PlaceHit } from "../../lib/placeSearch";
import type { Story } from "../../types";
import countries110m from "../../data/world/countries-110m.json";
import { useT } from "../../store/AppContext";
import { colors, font, radius, spacing } from "../../theme";
import {
  GlobeScene,
  type GlobeCountry,
  type GlobeEntityData,
  type GlobeViewRefs,
} from "./GlobeScene";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const ZOOM_MIN = 0.6;
const ZOOM_MAX = 2.6;
const LAND_RADIUS = 1.0;
const REGION_RADIUS = 1.004; // province fills sit just above the country fill (1.0)
const OUTLINE_RADIUS = 1.006; // region borders just above the province fills
const COUNTRY_OUTLINE_RADIUS = 1.003; // faint country borders just above the country fill

// Affiliation zone (src/data/zones.ts) → ISO-2, so a zoned story drops a marker on the
// right country. Broad zones (latam/africa) are omitted — those fall back to name match.
const ZONE_ISO2: Record<string, string> = {
  ukraine: "ua",
  russia: "ru",
  china: "cn",
  israel: "il",
  palestine: "ps",
  iran: "ir",
  india: "in",
  pakistan: "pk",
  turkey: "tr",
  japan: "jp",
  korea: "kr",
};

export function Globe({
  activePoolId,
  home,
  onSelect,
  onSelectWorld,
  worldActive,
  onSetHome,
  stories = [],
  variant = "card",
  onOpenArticles,
  height = 320,
}: {
  activePoolId?: string;
  home?: string;
  onSelect: (poolId?: string) => void;
  onSelectWorld?: () => void;
  worldActive?: boolean;
  onSetHome?: (nodeId: string) => void;
  /** Ongoing synthesized stories — drives the pulsing severity alert markers. */
  stories?: Story[];
  /** "hero" = full-bleed landing with the centered place search; "card" = embedded. */
  variant?: "card" | "hero";
  /** Called when a place is chosen, so the host can reveal the articles panel. */
  onOpenArticles?: () => void;
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
    target: useRef<{ yaw: number; pitch: number; zoom: number } | null>(null),
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
  const worldGeo = useMemo<{
    shapes: CountryShape[];
    centroids: GeoCentroids;
    countryOutline: Float32Array;
  } | null>(() => {
    try {
      const geo = countries110m as unknown as Parameters<typeof buildCountryShapes>[0];
      return {
        shapes: buildCountryShapes(geo, LAND_RADIUS),
        centroids: computeCentroids(geo),
        countryOutline: buildOutline(geo.features, COUNTRY_OUTLINE_RADIUS),
      };
    } catch (e) {
      console.warn("[globe] world borders unavailable:", e);
      return null;
    }
  }, []);

  // Ongoing-story alerts: locate developing stories on the globe by detected zone or
  // a country name in the headline, sized/coloured by gravity (Story.severity).
  const alerts = useMemo<GeoAlert[]>(() => {
    if (!worldGeo || stories.length === 0) return [];
    const centroidByName = new Map(
      worldGeo.centroids.countries.map((c) => [c.name.toLowerCase(), c.dir] as const),
    );
    return buildAlerts(
      stories,
      { centroidByIso2: worldGeo.centroids.byIso2, centroidByName, zoneToIso2: ZONE_ISO2 },
      { max: 40 },
    );
  }, [worldGeo, stories]);

  // Unified place search (continents + countries) over the bundled centroids. Picking
  // a result flies the globe there, commits it as the feed pool, and opens articles.
  const placeIndex = useMemo<PlaceHit[]>(() => {
    if (!worldGeo) return [];
    const c = worldGeo.centroids;
    return [
      ...c.continents.map(
        (x): PlaceHit => ({ nodeId: x.slug, label: x.label, level: "continent", dir: x.dir }),
      ),
      ...c.countries.map(
        (x): PlaceHit => ({ nodeId: x.iso2, label: x.name, level: "country", dir: x.dir }),
      ),
    ];
  }, [worldGeo]);
  const [placeQuery, setPlaceQuery] = useState("");
  const placeResults = useMemo(() => searchPlaces(placeIndex, placeQuery, 7), [placeIndex, placeQuery]);

  const selectPlace = (hit: PlaceHit) => {
    setPlaceQuery("");
    Keyboard.dismiss();
    const d = hit.dir;
    refs.target.current = {
      yaw: Math.atan2(-d.x, d.z),
      pitch: clamp(Math.atan2(d.y, Math.hypot(d.x, d.z)), -1.2, 1.2),
      zoom: hit.level === "country" ? 1.9 : 1.4,
    };
    setBrowse(hit.nodeId);
    onSelect(poolIdForNode(hit.nodeId));
    onOpenArticles?.();
  };

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
    const subCountryIso =
      view?.node.level === "country"
        ? view.node.nodeId
        : view?.node.level === "region"
          ? view.node.nodeId.split("-")[0]
          : null;
    if (centroids && subCountryIso) {
      const base = centroids.byIso2.get(subCountryIso);
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

  // Bind each country's border shape to the current level's coverage child it stands
  // for (a continent groups many countries; a country is one) so the SHAPE becomes
  // the hover/click target. All other land renders inert so the continents show.
  const countries: GlobeCountry[] = useMemo(() => {
    const shapes = worldGeo?.shapes ?? [];
    const children = view?.children ?? [];
    const byIso = new Map<string, CoverageNode>();
    const byCont = new Map<string, CoverageNode>();
    for (const c of children) {
      if (c.level === "country") byIso.set(c.nodeId, c);
      else if (c.level === "continent") byCont.set(c.nodeId, c);
    }
    const currentIso =
      view?.node.level === "country"
        ? view.node.nodeId
        : view?.node.level === "region"
          ? view.node.nodeId.split("-")[0]
          : null;
    return shapes.map((s, i) => {
      const child = (s.iso2 ? byIso.get(s.iso2) : undefined) ?? byCont.get(s.continent);
      return {
        key: `${s.iso2 ?? "x"}-${i}`,
        positions: s.positions,
        normals: s.normals,
        entityId: child ? child.nodeId : null,
        selectable: child ? child.state === "ready" : false,
        active: !!child && !!activePoolId && child.poolId === activePoolId,
        current: !!currentIso && s.iso2 === currentIso,
      };
    });
  }, [worldGeo, view, activePoolId]);

  // Stream the province/state borders for the country in focus (ONLY that country),
  // build their shapes + boundary outline, and bind each to its coverage region node.
  const regionCc = useMemo(() => {
    const n = view?.node;
    if (!n) return null;
    if (n.level === "country") return n.nodeId;
    if (n.level === "region" || n.level === "province" || n.level === "locality") {
      return n.nodeId.split("-")[0];
    }
    return null;
  }, [view]);

  const [regionData, setRegionData] = useState<{ cc: string; features: RegionFeature[] } | null>(
    null,
  );
  useEffect(() => {
    if (!regionCc) {
      setRegionData(null);
      return;
    }
    let cancelled = false;
    fetchRegions(regionCc).then((features) => {
      if (!cancelled) setRegionData({ cc: regionCc, features });
    });
    return () => {
      cancelled = true;
    };
  }, [regionCc]);

  const { regions, regionOutline } = useMemo<{
    regions: GlobeCountry[];
    regionOutline: Float32Array | null;
  }>(() => {
    if (!regionData || regionData.cc !== regionCc) return { regions: [], regionOutline: null };
    const byRegionId = new Map<string, CoverageNode>();
    for (const c of view?.children ?? []) {
      if (c.level === "region" || c.level === "province") byRegionId.set(c.nodeId, c);
    }
    const currentRegion =
      view?.node.level === "region" || view?.node.level === "province" ? view.node.nodeId : null;
    const regions: GlobeCountry[] = buildRegionShapes(regionData.features, REGION_RADIUS).map(
      (s, i) => {
        const child = s.regionId ? byRegionId.get(s.regionId) : undefined;
        return {
          key: `r-${s.regionId || i}`,
          positions: s.positions,
          normals: s.normals,
          entityId: child ? child.nodeId : null,
          selectable: child ? child.state === "ready" : false,
          active: !!child && !!activePoolId && child.poolId === activePoolId,
          current: !!currentRegion && s.regionId === currentRegion,
        };
      },
    );
    return { regions, regionOutline: buildOutline(regionData.features, OUTLINE_RADIUS) };
  }, [regionData, regionCc, view, activePoolId]);

  // Children with no border shape (provinces/localities) fall back to small gizmos.
  const childLevel = view?.children?.[0]?.level ?? null;
  const gizmos: GlobeEntityData[] =
    childLevel === "province" || childLevel === "locality" ? entities : [];

  // Ease the globe to FACE + zoom into the focused node (continent/country/region).
  useEffect(() => {
    if (!view || !worldGeo) {
      refs.target.current = null;
      return;
    }
    const n = view.node;
    let dir: Vec3 | undefined;
    let zoom = 1;
    if (n.level === "continent") {
      dir = worldGeo.centroids.byContinent.get(n.nodeId);
      zoom = 1.4;
    } else if (n.level === "country") {
      dir = worldGeo.centroids.byIso2.get(n.nodeId);
      zoom = 1.9;
    } else if (n.level === "region" || n.level === "province" || n.level === "locality") {
      dir = worldGeo.centroids.byIso2.get(n.nodeId.split("-")[0]);
      zoom = 2.2;
    }
    if (!dir || n.level === "world") {
      refs.target.current = null;
      return;
    }
    refs.target.current = {
      yaw: Math.atan2(-dir.x, dir.z),
      pitch: Math.max(-1.2, Math.min(1.2, Math.atan2(dir.y, Math.hypot(dir.x, dir.z)))),
      zoom,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, worldGeo]);

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
            countries={countries}
            regions={regions}
            countryOutline={worldGeo?.countryOutline ?? null}
            outline={regionOutline}
            gizmos={gizmos}
            alerts={alerts}
            focusedId={focusedId}
            onFocus={setFocusedId}
            onActivate={activate}
            refs={refs}
          />
        </Canvas>

        {/* Centered place finder (hero only): one box for continent / country. */}
        {variant === "hero" && (
          <View style={styles.searchWrap} pointerEvents="box-none">
            <View style={styles.searchBox}>
              <Ionicons name="search" size={16} color={colors.textDim} />
              <TextInput
                style={styles.searchInput}
                value={placeQuery}
                onChangeText={setPlaceQuery}
                placeholder={t("globe.searchPlaceholder")}
                placeholderTextColor={colors.textFaint}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="search"
                onSubmitEditing={() => placeResults[0] && selectPlace(placeResults[0])}
              />
              {placeQuery.length > 0 && (
                <Pressable onPress={() => setPlaceQuery("")} hitSlop={8}>
                  <Ionicons name="close-circle" size={16} color={colors.textFaint} />
                </Pressable>
              )}
            </View>
            {placeResults.length > 0 && (
              <View style={styles.searchResults}>
                {placeResults.map((r) => (
                  <Pressable
                    key={`${r.level}-${r.nodeId}`}
                    style={styles.searchResult}
                    onPress={() => selectPlace(r)}
                    accessibilityRole="button"
                  >
                    <Ionicons
                      name={r.level === "continent" ? "earth" : "flag-outline"}
                      size={14}
                      color={colors.accent}
                    />
                    <Text style={styles.searchResultText} numberOfLines={1}>
                      {r.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}
          </View>
        )}

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
  searchWrap: {
    position: "absolute",
    top: spacing.xl,
    left: 0,
    right: 0,
    alignItems: "center",
    paddingHorizontal: spacing.lg,
  },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    width: "100%",
    maxWidth: 460,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.surface + "E6",
    borderWidth: 1,
    borderColor: colors.border,
  },
  searchInput: { flex: 1, color: colors.text, fontSize: font.body },
  searchResults: {
    width: "100%",
    maxWidth: 460,
    marginTop: spacing.xs,
    borderRadius: radius.md,
    backgroundColor: colors.surface + "F2",
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden",
  },
  searchResult: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  searchResultText: { flex: 1, color: colors.text, fontSize: font.small, fontWeight: "700" },
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
});
