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

import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Keyboard,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type GestureResponderEvent,
  type PanResponderGestureState,
  type ViewStyle,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Canvas } from "@react-three/fiber";
import {
  fetchAsk,
  fetchCoverage,
  fetchRegions,
  streamAsk,
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
  continentSlug,
  type CountryShape,
  type GeoCentroids,
} from "../../lib/geoShapes";
import {
  EVENT_CATEGORIES,
  buildAlerts,
  type EventCategory,
  type GeoAlert,
} from "../../lib/geoAlerts";
import { searchPlaces, type PlaceHit } from "../../lib/placeSearch";
import { appendAskStream, resetAskStream } from "../../lib/askStream";
import { buildAskNameIndex, resolveAskPlace, scanCountries } from "../../lib/askLocate";
import type { AnalysisStatus, AskResult, Story } from "../../types";
import worldLand from "../../data/world/countries-50m.json";
import { useApp, useT } from "../../store/AppContext";
import { colors, font, radius, spacing } from "../../theme";
import { AskPanel, renderCited } from "./AskPanel";
import {
  GlobeScene,
  type AskMarkerData,
  type GlobeCountry,
  type GlobeEntityData,
  type GlobeViewRefs,
  type ProjectedMarker,
} from "./GlobeScene";

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));
const ZOOM_MIN = 0.6;
const ZOOM_MAX = 2.6;
const WORLD_ZOOM = 0.9; // zoomed-OUT scale for the world landing (whole globe in view)
// Pixels→radians drag gain: 2·cameraZ·tan(fov/2) = the world height the viewport spans
// at the globe's distance. Dividing by (zoom·canvasHeightPx) makes a drag STICK to the
// surface — same arc under the finger regardless of how zoomed in we are.
const DRAG_K = 2 * 3.2 * Math.tan((45 * Math.PI) / 180 / 2);
// On web, stop the BROWSER from claiming pinch/drag (page zoom + scroll) over the canvas.
const WEB_TOUCH: ViewStyle | null =
  Platform.OS === "web"
    ? ({ touchAction: "none" } as unknown as ViewStyle)
    : null;
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

/** Normalise a community/region NAME so Natural Earth's `region` field (e.g. "Cataluña")
 *  matches a coverage node's label, despite accents + filler words ("Comunidad de…"). */
function normRegion(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(
      /\b(comunidad|comunitat|de|del|la|el|los|las|region|regio|foral|principado|principat|islas|illes|ciudad|autonoma)\b/g,
      " ",
    )
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** A floating "you are pointing here" pin that tracks the cursor. Its POSITION is updated
 *  imperatively (move) so dragging the mouse never re-renders the globe scene; only its
 *  visibility/label come from props. Hidden when no place is hovered (label null). */
const CursorPin = forwardRef<
  { move: (x: number, y: number) => void },
  { label: string | null }
>(function CursorPin({ label }, ref) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  useImperativeHandle(ref, () => ({ move: (x, y) => setPos({ x, y }) }), []);
  if (!label || !pos) return null;
  return (
    <View
      style={[styles.cursorPin, { left: pos.x, top: pos.y }]}
      pointerEvents="none"
    >
      <Ionicons
        name="location"
        size={30}
        color={colors.accent}
        style={styles.cursorPinIcon}
      />
      <View style={styles.cursorPinLabel}>
        <Text style={styles.cursorPinText} numberOfLines={1}>
          {label}
        </Text>
      </View>
    </View>
  );
});

/** 2D overlay that floats labels/detail bubbles ON the globe's markers. Positions are
 *  pushed imperatively from GlobeScene's frame loop (projected world→screen), so the
 *  globe never re-renders to move a label; a still globe pushes identical frames which
 *  this de-dupes (rounded), costing zero React updates. The root is `box-none`, so the
 *  read-only hover bubbles (pointerEvents none) never steal taps from the globe — but
 *  the FOCUSED pin's card is interactive (pointerEvents auto), on top, with a backdrop
 *  that dismisses it on an outside tap. */
const MarkerLayer = forwardRef<
  { set: (items: ProjectedMarker[]) => void },
  {
    /** The clicked pin: its card is interactive + on top. */
    focusedId: string | null;
    /** Tap outside the focused card → release focus. */
    onDismiss: () => void;
    /** Rich, interactive content for the focused card (links + selectable text). */
    renderFocused: (it: ProjectedMarker) => React.ReactNode;
  }
>(function MarkerLayer({ focusedId, onDismiss, renderFocused }, ref) {
  const [items, setItems] = useState<ProjectedMarker[]>([]);
  const [height, setHeight] = useState(0); // layer height (px), for bottom-anchoring bubbles
  const prevKey = useRef("");
  useImperativeHandle(
    ref,
    () => ({
      set: (next: ProjectedMarker[]) => {
        const key = next
          .map((i) => `${i.id}:${Math.round(i.x)}:${Math.round(i.y)}:${i.hovered ? 1 : 0}`)
          .join("|");
        if (key === prevKey.current) return; // nothing moved/changed → skip re-render
        prevKey.current = key;
        setItems(next);
      },
    }),
    [],
  );
  // Only show the backdrop when the focused pin is actually on screen (front hemisphere),
  // so a stale/occluded focus never traps the globe behind an invisible catcher.
  const focusedShown = focusedId !== null && items.some((i) => i.id === focusedId);
  // Anchor each stack by its BOTTOM (just above the pin) using the layer's measured
  // height, so a bubble grows UPWARD with its content instead of being clipped.
  return (
    <View
      style={StyleSheet.absoluteFill}
      pointerEvents="box-none"
      onLayout={(e) => setHeight(e.nativeEvent.layout.height)}
    >
      {focusedShown && (
        <Pressable
          style={[StyleSheet.absoluteFill, styles.markerBackdrop]}
          onPress={onDismiss}
          accessibilityLabel="Dismiss"
        />
      )}
      {height > 0 &&
        items.map((it) => {
          const pos = { left: it.x - 110, bottom: height - it.y + 12 };
          if (it.id === focusedId) {
            return (
              <View key={it.id} style={[styles.markerTag, styles.markerFocusedWrap, pos]} pointerEvents="box-none">
                <View style={[styles.markerCard, { borderColor: it.color }]} pointerEvents="auto">
                  {renderFocused(it)}
                </View>
              </View>
            );
          }
          return (
            <View key={it.id} style={[styles.markerTag, pos]} pointerEvents="none">
              {it.hovered && it.detail ? (
                <View style={[styles.markerBubble, { borderColor: it.color }]}>
                  <Text style={styles.markerBubbleText}>{it.detail}</Text>
                </View>
              ) : null}
              {it.kind === "ask" && it.label ? (
                <View style={[styles.markerChip, { borderColor: it.color }]}>
                  <Text style={styles.markerChipText} numberOfLines={1}>
                    {it.label}
                  </Text>
                </View>
              ) : null}
            </View>
          );
        })}
    </View>
  );
});

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
  onPlace,
  browseNode,
  onNavigate,
  status,
  onAlertPress,
  rightInset = 0,
  topInset = 0,
  bottomInset = 0,
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
  /** Reports the selected place's label (null = world) so the host can title itself. */
  onPlace?: (label: string | null) => void;
  /** Controlled current node id, driven by the URL/history (so back/forward move the map). */
  browseNode?: string;
  /** Fired on every USER map navigation so the host can push a page-history entry. */
  onNavigate?: (nodeId: string) => void;
  /** Live backend analysis status — drives a compact "Updating <place>" pill. */
  status?: AnalysisStatus | null;
  /** Tap a worldview marker → open its story (the host routes to the reader). */
  onAlertPress?: (id: string) => void;
  /** Width (px) an overlaying panel covers on the RIGHT (desktop) — the globe recenters
   *  into the remaining visible area when it opens/closes. */
  rightInset?: number;
  /** Safe-area top inset (px) so the hero search clears the status bar/notch. */
  topInset?: number;
  /** Obstruction at the BOTTOM (px): home-indicator safe area + any bottom-sheet peek,
   *  so the zoom/World controls + status pill lift clear of it. */
  bottomInset?: number;
  /** Canvas height in px (it sits inside a scroll view). */
  height?: number;
}) {
  const t = useT();
  const { prefs } = useApp();
  const lang = prefs.language;
  const [browse, setBrowse] = useState<string>(
    browseNode ||
      (activePoolId && geoNodeIdOf(activePoolId)) ||
      home ||
      GEO_ROOT_ID,
  );
  // Every USER navigation goes through here so it's recorded in the page history.
  // useCallback so it's a STABLE identity — activate() (a GlobeScene prop) depends on it,
  // and a fresh function each render would defeat React.memo(GlobeScene).
  const navTo = useCallback(
    (nodeId: string) => {
      setBrowse(nodeId);
      onNavigate?.(nodeId);
    },
    [onNavigate],
  );
  const [view, setView] = useState<CoverageView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  // AI news search ("ask") over the whole database: the streamed answer card + the
  // located beacons it drops on the globe. The streamed synopsis lives in the isolated
  // askStream store (not state) so tokens never re-render the globe scene.
  const [askQuery, setAskQuery] = useState("");
  const [asking, setAsking] = useState(false);
  const [askResult, setAskResult] = useState<AskResult | null>(null);
  const [askError, setAskError] = useState<string | null>(null);
  const askHandleRef = useRef<{ cancel: () => void } | null>(null);
  // Which globe marker (event or ask result) is under the pointer — pops its 3D core
  // and shows its detail bubble. A separate overlay holds the projected label positions.
  const [hoveredMarkerId, setHoveredMarkerId] = useState<string | null>(null);
  // The CLICKED marker, whose interactive card stays open (links + selectable text) until
  // the reader taps outside it.
  const [focusedMarkerId, setFocusedMarkerId] = useState<string | null>(null);
  const markerLayerRef = useRef<{ set: (items: ProjectedMarker[]) => void }>(null);

  // View state the gesture layer mutates and the frame loop reads (no re-renders).
  const rotRef = useRef({ yaw: 0, pitch: 0 });
  const zoomRef = useRef(1);
  const draggingRef = useRef(false);
  const targetRef = useRef<{ yaw: number; pitch: number; zoom: number } | null>(null);
  // Assigned by GlobeScene once mounted; gestures call it to wake the on-demand loop.
  const wakeRef = useRef<() => void>(() => {});
  // Bundle the refs ONCE (stable identity). A fresh object literal each render would change
  // the `refs` prop every tick and defeat React.memo(GlobeScene) — re-reconciling the whole
  // scene graph on every status poll (the periodic stutter).
  const refs = useMemo<GlobeViewRefs>(
    () => ({
      rot: rotRef,
      zoom: zoomRef,
      dragging: draggingRef,
      target: targetRef,
      wake: wakeRef,
    }),
    [],
  );
  const lastDrag = useRef({ x: 0, y: 0 });
  const pinchDist = useRef(0);
  // True once a gesture has actually DRAGGED past the slop. Reset at the start of every
  // gesture and read by the click handlers below, because r3f still fires onClick on
  // pointer-up when the press began and ended over the same mesh — even mid-drag — so a
  // drag-to-rotate that releases over a country/marker would otherwise count as a tap.
  const didDrag = useRef(false);
  const canvasH = useRef(0); // measured canvas height (px) for surface-correct drag gain
  const canvasW = useRef(0); // measured canvas width (px) for the cursor-pin placement
  const pinRef = useRef<{ move: (x: number, y: number) => void }>(null);

  // Follow an externally-committed pool so the globe opens where the feed is.
  useEffect(() => {
    const n = activePoolId && geoNodeIdOf(activePoolId);
    if (n) setBrowse(n);
  }, [activePoolId]);

  // Back/forward (or any external URL change) drives the map: follow browseNode. This
  // does NOT re-report navigation, so restoring history never pushes a new entry.
  useEffect(() => {
    if (browseNode && browseNode !== browse) setBrowse(browseNode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browseNode]);

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
      const geo = worldLand as unknown as Parameters<
        typeof buildCountryShapes
      >[0];
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

  // Worldview: locate MAJOR events on the globe (by detected zone or a country name in
  // the headline), classified by category and sized by gravity. Only fairly newsworthy
  // events (severity >= 0.4) so the map reads as the day's big picture, not noise.
  const alerts = useMemo<GeoAlert[]>(() => {
    if (!worldGeo || stories.length === 0) return [];
    const centroidByName = new Map(
      worldGeo.centroids.countries.map(
        (c) => [c.name.toLowerCase(), c.dir] as const,
      ),
    );
    // name → ISO-2 so a name-located alert knows its nation (for the flag).
    const iso2ByName = new Map(
      worldGeo.centroids.countries.map((c) => [c.name.toLowerCase(), c.iso2] as const),
    );
    const raw = buildAlerts(
      stories,
      {
        centroidByIso2: worldGeo.centroids.byIso2,
        centroidByName,
        zoneToIso2: ZONE_ISO2,
        iso2ByName,
      },
      { minSeverity: 0.4, max: 80 },
    );
    // DECLUTTER: many stories about the same country resolve to the IDENTICAL centroid
    // and would stack into one blob. Collapse by location — keep the strongest as the
    // pin (raw is severity-desc) and count the rest for a "+N more" affordance.
    const byLoc = new Map<string, GeoAlert>();
    for (const a of raw) {
      const key = `${a.dir.x.toFixed(2)}|${a.dir.y.toFixed(2)}|${a.dir.z.toFixed(2)}`;
      const ex = byLoc.get(key);
      if (ex) ex.count = (ex.count ?? 1) + 1;
      else byLoc.set(key, { ...a, count: 1 });
    }
    return [...byLoc.values()].slice(0, 40);
  }, [worldGeo, stories]);

  // The categories actually present, for the on-globe legend (in a stable order).
  const legendCats = useMemo<EventCategory[]>(() => {
    const present = new Set(alerts.map((a) => a.category));
    return (Object.keys(EVENT_CATEGORIES) as EventCategory[]).filter((c) =>
      present.has(c),
    );
  }, [alerts]);

  // Unified place search (continents + countries) over the bundled centroids. Picking
  // a result flies the globe there, commits it as the feed pool, and opens articles.
  const placeIndex = useMemo<PlaceHit[]>(() => {
    if (!worldGeo) return [];
    const c = worldGeo.centroids;
    return [
      ...c.continents.map(
        (x): PlaceHit => ({
          nodeId: x.slug,
          label: x.label,
          level: "continent",
          dir: x.dir,
        }),
      ),
      ...c.countries.map(
        (x): PlaceHit => ({
          nodeId: x.iso2,
          label: x.name,
          level: "country",
          dir: x.dir,
        }),
      ),
    ];
  }, [worldGeo]);
  const [placeQuery, setPlaceQuery] = useState("");

  const selectPlace = (hit: PlaceHit) => {
    setPlaceQuery("");
    Keyboard.dismiss();
    const d = hit.dir;
    refs.target.current = {
      yaw: Math.atan2(-d.x, d.z),
      pitch: clamp(Math.atan2(d.y, Math.hypot(d.x, d.z)), -1.2, 1.2),
      zoom: hit.level === "continent" ? 1.4 : 1.9,
    };
    refs.wake.current?.(); // kick the fly-to animation
    navTo(hit.nodeId);
    onSelect(poolIdForNode(hit.nodeId));
    onPlace?.(hit.label);
    onOpenArticles?.();
  };

  // --- AI news search ("ask") ------------------------------------------------
  // Stream the AI's answer to a free-text query over ALL fetched news. The model
  // decides whether the matter has a geographic spread; if so its located places
  // become globe beacons (mode "map"), else it's just the streamed synopsis.
  const runAsk = useCallback(
    (raw: string) => {
      const q = raw.trim();
      if (!q) return;
      askHandleRef.current?.cancel();
      resetAskStream();
      setAskQuery(q);
      setAskError(null);
      setAskResult(null);
      setAsking(true);
      setPlaceQuery(""); // close the place dropdown; the query now lives in the panel
      Keyboard.dismiss();
      const settle = (r: AskResult) => {
        setAskResult(r);
        setAsking(false);
        resetAskStream();
      };
      const fail = () => {
        setAskError("failed");
        setAsking(false);
      };
      const fallback = () => {
        fetchAsk(q, lang)
          .then((r) => (r ? settle(r) : fail()))
          .catch(fail);
      };
      const handle = streamAsk(q, {
        lang,
        onDelta: (d) => appendAskStream(d),
        onDone: settle,
        onError: fallback, // SSE failed — try the non-streaming fetch before erroring
      });
      askHandleRef.current = handle;
      if (!handle) fallback(); // streaming unsupported in this runtime (native fetch)
    },
    [lang],
  );

  const clearAsk = useCallback(() => {
    askHandleRef.current?.cancel();
    askHandleRef.current = null;
    resetAskStream();
    setAsking(false);
    setAskResult(null);
    setAskError(null);
    setAskQuery("");
    setFocusedMarkerId(null);
  }, []);

  // Cancel any in-flight ask stream on unmount.
  useEffect(() => () => askHandleRef.current?.cancel(), []);

  // Navigating to another place clears any open pin card (its marker is now gone/stale).
  useEffect(() => setFocusedMarkerId(null), [browse]);

  // Name/alias index for locating the answer's places (built once per geo load).
  const askIndex = useMemo(
    () => (worldGeo ? buildAskNameIndex(worldGeo.centroids) : null),
    [worldGeo],
  );

  // Located beacons: resolve each structured place (ISO2 → name/alias), de-duped by
  // position. If NONE resolve, fall back to scanning the synopsis prose for countries
  // so even a free-text answer (e.g. "the major world conflicts") still anchors.
  const askMarkers = useMemo<AskMarkerData[]>(() => {
    if (!askResult || !askIndex) return [];
    const out: AskMarkerData[] = [];
    const seen = new Set<string>();
    const push = (id: string, dir: Vec3, label: string, detail = "", iso2 = "") => {
      const key = `${dir.x.toFixed(2)}|${dir.y.toFixed(2)}|${dir.z.toFixed(2)}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ id, dir, label, detail, iso2 });
    };
    askResult.places.forEach((p, i) => {
      const dir = resolveAskPlace(p.label, p.iso2, askIndex);
      if (dir) push(`ask-${i}-${p.iso2 || p.label}`, dir, p.label, p.blurb, p.iso2);
    });
    if (out.length === 0 && askResult.synopsis) {
      scanCountries(askResult.synopsis, askIndex).forEach((c, i) =>
        push(`ask-scan-${i}-${c.name}`, c.dir, c.name),
      );
    }
    return out;
  }, [askResult, askIndex]);

  // When an answer lands with locations, orient the globe to frame them (averaged
  // direction), zoomed out enough to take in the spread.
  useEffect(() => {
    if (askMarkers.length === 0) return;
    let x = 0;
    let y = 0;
    let z = 0;
    for (const m of askMarkers) {
      x += m.dir.x;
      y += m.dir.y;
      z += m.dir.z;
    }
    const len = Math.hypot(x, y, z) || 1;
    const avg = { x: x / len, y: y / len, z: z / len };
    refs.target.current = {
      yaw: Math.atan2(-avg.x, avg.z),
      pitch: clamp(Math.atan2(avg.y, Math.hypot(avg.x, avg.z)), -1.2, 1.2),
      zoom: askMarkers.length > 1 ? 1.05 : 1.5,
    };
    refs.wake.current?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askMarkers]);

  // Fly the globe to centre an ask beacon (the focused card's "locate" action).
  const flyToAskMarker = useCallback(
    (id: string) => {
      const m = askMarkers.find((x) => x.id === id);
      if (!m) return;
      refs.target.current = {
        yaw: Math.atan2(-m.dir.x, m.dir.z),
        pitch: clamp(Math.atan2(m.dir.y, Math.hypot(m.dir.x, m.dir.z)), -1.2, 1.2),
        zoom: 1.7,
      };
      refs.wake.current?.();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [askMarkers],
  );

  // Clicking a pin FOCUSES it (its interactive card opens). A drag-to-rotate that
  // releases over a pin must not count as a click.
  const onMarkerSelect = useCallback((id: string) => {
    if (didDrag.current) return;
    setFocusedMarkerId(id);
  }, []);
  const clearFocus = useCallback(() => setFocusedMarkerId(null), []);

  // The interactive content of a focused pin's card: selectable text + clickable links.
  // Ask pins show the place + its blurb with inline citation links (and a locate action);
  // event pins show the headline + an "open story" link.
  const renderFocused = useCallback(
    (it: ProjectedMarker) => {
      if (it.kind === "alert") {
        return (
          <>
            <Text style={styles.markerCardText} selectable>
              {it.detail}
            </Text>
            {onAlertPress && (
              <Pressable
                style={styles.markerCardLink}
                onPress={() => {
                  onAlertPress(it.id);
                  setFocusedMarkerId(null);
                }}
                accessibilityRole="link"
              >
                <Ionicons name="open-outline" size={13} color={colors.accent} />
                <Text style={styles.markerCardLinkText}>{t("globe.openStory")}</Text>
              </Pressable>
            )}
          </>
        );
      }
      return (
        <>
          <Pressable
            style={styles.markerCardHead}
            onPress={() => flyToAskMarker(it.id)}
            accessibilityRole="button"
          >
            <Text style={styles.markerCardLabel} selectable>
              {it.label}
            </Text>
            <Ionicons name="locate" size={13} color={colors.accent} />
          </Pressable>
          <Text style={styles.markerCardText} selectable>
            {renderCited(it.detail, askResult?.sources ?? [])}
          </Text>
        </>
      );
    },
    [onAlertPress, t, flyToAskMarker, askResult],
  );

  // The drill-down options (covered places + anything drillable), placed on the
  // sphere by the deterministic procedural layout (seeded by the parent id).
  const entities: GlobeEntityData[] = useMemo(() => {
    const children = (view?.children ?? []).filter(
      (n) => n.state === "ready" || n.hasChildren,
    );
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
      if (c.level === "region")
        return centroids.byIso2.get(c.nodeId.split("-")[0]);
      return undefined;
    };
    return children.map((c) => ({
      id: c.nodeId,
      poolId: c.poolId,
      label: c.label,
      dir: regionRing?.get(c.nodeId) ??
        realDir(c) ??
        proc.get(c.nodeId) ?? { x: 0, y: 0, z: 1 },
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
      const child =
        (s.iso2 ? byIso.get(s.iso2) : undefined) ?? byCont.get(s.continent);
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
    if (
      n.level === "region" ||
      n.level === "province" ||
      n.level === "locality"
    ) {
      return n.nodeId.split("-")[0];
    }
    return null;
  }, [view]);

  // The browsed country's regions (communities) are searchable too — centred on the
  // country (the camera settles by level) so you can find e.g. "Galicia" inside Spain.
  const regionPlaces = useMemo<PlaceHit[]>(() => {
    if (!worldGeo || !regionCc) return [];
    const dir = worldGeo.centroids.byIso2.get(regionCc);
    if (!dir) return [];
    const out: PlaceHit[] = [];
    for (const c of view?.children ?? []) {
      if (c.level === "region" || c.level === "province") {
        out.push({ nodeId: c.nodeId, label: c.label, level: "region", dir });
      }
    }
    return out;
  }, [worldGeo, regionCc, view]);

  const [regionData, setRegionData] = useState<{
    cc: string;
    features: RegionFeature[];
  } | null>(null);
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

  // Provinces are searchable too — each routes to the covered region (community) it
  // belongs to, labelled "Province · Region" so the rollup is clear (e.g. "Lugo · Galicia").
  const provincePlaces = useMemo<PlaceHit[]>(() => {
    if (!worldGeo || !regionCc || !regionData || regionData.cc !== regionCc)
      return [];
    const dir = worldGeo.centroids.byIso2.get(regionCc);
    if (!dir) return [];
    const byNodeId = new Map<string, CoverageNode>();
    const byName = new Map<string, CoverageNode>();
    for (const c of view?.children ?? []) {
      if (c.level === "region" || c.level === "province") {
        byNodeId.set(c.nodeId, c);
        byName.set(normRegion(c.label), c);
      }
    }
    const out: PlaceHit[] = [];
    for (const f of regionData.features) {
      const p = f.properties;
      if (!p.name) continue;
      const child =
        byNodeId.get(continentSlug(p.code)) ??
        (p.groupCode ? byNodeId.get(continentSlug(p.groupCode)) : undefined) ??
        byName.get(normRegion(p.group ?? ""));
      if (child) {
        out.push({
          nodeId: child.nodeId,
          label: `${p.name} · ${child.label}`,
          level: "region",
          dir,
        });
      }
    }
    return out;
  }, [worldGeo, regionCc, regionData, view]);
  const placeResults = useMemo(
    () =>
      searchPlaces(
        [...placeIndex, ...regionPlaces, ...provincePlaces],
        placeQuery,
        8,
      ),
    [placeIndex, regionPlaces, provincePlaces, placeQuery],
  );

  const { regions, regionOutline } = useMemo<{
    regions: GlobeCountry[];
    regionOutline: Float32Array | null;
  }>(() => {
    if (!regionData || regionData.cc !== regionCc)
      return { regions: [], regionOutline: null };
    // Coverage can be coarser than the rendered provinces (e.g. Spain's communities),
    // so bind by the province's own ISO code FIRST, then by its community group name —
    // clicking any province then selects the covered region it belongs to, and all the
    // provinces of that region highlight together.
    const byNodeId = new Map<string, CoverageNode>();
    const byName = new Map<string, CoverageNode>();
    for (const c of view?.children ?? []) {
      if (c.level === "region" || c.level === "province") {
        byNodeId.set(c.nodeId, c);
        byName.set(normRegion(c.label), c);
      }
    }
    const currentNode =
      view?.node.level === "region" || view?.node.level === "province"
        ? view.node.nodeId
        : null;
    const currentName =
      view?.node.level === "region" || view?.node.level === "province"
        ? normRegion(view.node.label)
        : null;
    const regions: GlobeCountry[] = buildRegionShapes(
      regionData.features,
      REGION_RADIUS,
    ).map((s, i) => {
      const nameKey = normRegion(s.communityName);
      // Bind by the province's OWN code, else its community code, else community name.
      const child =
        (s.regionId ? byNodeId.get(s.regionId) : undefined) ??
        (s.communityCode ? byNodeId.get(s.communityCode) : undefined) ??
        (nameKey ? byName.get(nameKey) : undefined);
      return {
        key: `r-${s.regionId || i}`,
        isRegion: true,
        positions: s.positions,
        normals: s.normals,
        entityId: child ? child.nodeId : null,
        selectable: child ? child.state === "ready" : false,
        active: !!child && !!activePoolId && child.poolId === activePoolId,
        current:
          (!!currentNode &&
            (s.regionId === currentNode || s.communityCode === currentNode)) ||
          (!!currentName && nameKey === currentName),
      };
    });
    return {
      regions,
      regionOutline: buildOutline(regionData.features, OUTLINE_RADIUS),
    };
  }, [regionData, regionCc, view, activePoolId]);

  // Children with no border shape (provinces/localities) fall back to small gizmos.
  // useMemo so the empty case returns a STABLE array (not a fresh [] each render) — keeps
  // the `gizmos` prop referentially stable for React.memo(GlobeScene).
  const childLevel = view?.children?.[0]?.level ?? null;
  const gizmos = useMemo<GlobeEntityData[]>(
    () =>
      childLevel === "province" || childLevel === "locality" ? entities : [],
    [childLevel, entities],
  );

  // Ease the globe to FACE + zoom into the focused node (continent/country/region).
  useEffect(() => {
    if (!view || !worldGeo) {
      refs.target.current = null;
      refs.wake.current?.();
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
    } else if (
      n.level === "region" ||
      n.level === "province" ||
      n.level === "locality"
    ) {
      dir = worldGeo.centroids.byIso2.get(n.nodeId.split("-")[0]);
      zoom = 2.2;
    }
    if (!dir || n.level === "world") {
      // World landing / no place selected: spin freely (no orientation target), pan is
      // unbounded, and ease OUT so the WHOLE world shows, undoing any prior zoom-in.
      refs.target.current = null;
      refs.zoom.current = WORLD_ZOOM;
      refs.wake.current?.();
      return;
    }
    const fy = Math.atan2(-dir.x, dir.z);
    const fp = Math.max(
      -1.2,
      Math.min(1.2, Math.atan2(dir.y, Math.hypot(dir.x, dir.z))),
    );
    refs.target.current = { yaw: fy, pitch: fp, zoom };
    refs.wake.current?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, worldGeo]);

  // Report the committed place's label so the articles panel can title itself with it
  // (covers the initial open, where the pool was set before any in-app selection).
  useEffect(() => {
    if (!view) return;
    const committed = activePoolId ? geoNodeIdOf(activePoolId) : null;
    if (committed && view.node.nodeId === committed) onPlace?.(view.node.label);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, activePoolId]);

  const focused = entities.find((e) => e.id === focusedId) ?? null;
  const atRoot = browse === GEO_ROOT_ID;
  const nodeLabel = view?.node.label ?? t("geo.world");

  // The globe's "Updating" pill must name the place the globe is FOCUSED on — not the
  // selected feed pool, which diverges whenever you browse to a place you haven't committed
  // to (e.g. drilling into a continent while the feed still serves a country). `status` only
  // describes the feed pool, so we surface the pill ONLY when the focused node IS that feed —
  // then it can never name a place other than the one in view. Front page (no geo override)
  // ⇒ the feed is the world, matched at the root; otherwise match the committed geo pool.
  const focusIsFeed = activePoolId
    ? poolIdForNode(browse) === activePoolId
    : atRoot;

  // Float the place pin AT the cursor. The position is pushed IMPERATIVELY to the pin
  // (NDC -1..1 → px in the measured canvas) so per-move updates re-render only the pin,
  // never the globe scene + its hundreds of country meshes.
  const onHoverMove = useCallback(
    (ndcX: number, ndcY: number) => {
      const x = ((ndcX + 1) / 2) * canvasW.current;
      const y = ((1 - ndcY) / 2) * canvasH.current;
      // Keep the pin inside the canvas, and (desktop) left of the side panel.
      const maxX = Math.max(0, canvasW.current - rightInset);
      pinRef.current?.move(clamp(x, 0, maxX), clamp(y, 0, canvasH.current));
    },
    [rightInset],
  );

  // A globe marker was hovered (id) or left (null). Stable identity so GlobeScene's
  // frame loop keeps the latest without churn.
  const onMarkerHover = useCallback((id: string | null) => setHoveredMarkerId(id), []);
  // Per-frame projected marker positions → pushed straight to the overlay (which
  // de-dupes), so labels track the spinning globe without re-rendering the scene.
  const onMarkersProject = useCallback(
    (items: ProjectedMarker[]) => markerLayerRef.current?.set(items),
    [],
  );

  // Tap an entity: commit it as the feed if it has its own outlets AND drill in if
  // it has children (mirrors the chip navigator's behaviour exactly). useCallback (stable
  // across the 3s status re-renders) so it doesn't defeat React.memo(GlobeScene); its
  // identity only changes when the coverage `view` actually changes (a real place switch).
  const activate = useCallback(
    (id: string) => {
      if (didDrag.current) return; // a drag-to-rotate that ended here is not a tap
      const node = (view?.children ?? []).find((c) => c.nodeId === id);
      if (!node) return;
      if (node.state === "ready") {
        onSelect(node.poolId);
        onPlace?.(node.label);
        onOpenArticles?.(); // selecting a covered place reveals the articles panel
      }
      if (node.hasChildren) navTo(node.nodeId);
    },
    [view, onSelect, onPlace, onOpenArticles, navTo],
  );

  const goUp = () => {
    const path = view?.path ?? [];
    const parent = path.length >= 2 ? path[path.length - 2] : null;
    const nodeId = parent ? parent.nodeId : GEO_ROOT_ID;
    navTo(nodeId);
    // Going up changes the SELECTION too, so the feed follows the new level (e.g.
    // Galicia → Spain shows Spain's feed) instead of staying on the child.
    if (nodeId === GEO_ROOT_ID) {
      onSelectWorld?.();
    } else if (parent) {
      onSelect(parent.poolId);
      onPlace?.(parent.label);
    }
  };

  // Jump straight back to the top of the world (the front page), from any depth.
  const goWorld = () => {
    navTo(GEO_ROOT_ID);
    onSelectWorld?.();
  };

  // Fly to the saved HOME node and make it the feed (the counterpart to “set home”).
  const goHome = () => {
    if (!home) return;
    navTo(home);
    onSelect(poolIdForNode(home));
    onOpenArticles?.();
  };

  const zoomBy = (factor: number) => {
    refs.zoom.current = clamp(refs.zoom.current * factor, ZOOM_MIN, ZOOM_MAX);
    refs.wake.current?.();
  };

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        // Reset the drag flag at the START of every gesture WITHOUT claiming it, so a
        // stationary tap still falls through to the canvas and selects an entity.
        onStartShouldSetPanResponder: () => {
          didDrag.current = false;
          return false;
        },
        // Only CLAIM the gesture once the finger actually moves (so taps reach the
        // canvas and select), or immediately for a two-finger pinch.
        onMoveShouldSetPanResponder: (
          e: GestureResponderEvent,
          g: PanResponderGestureState,
        ) =>
          Math.abs(g.dx) + Math.abs(g.dy) > 4 ||
          (e.nativeEvent.touches?.length ?? 0) >= 2,
        onPanResponderGrant: () => {
          refs.dragging.current = true;
          didDrag.current = true; // moved past the slop → this gesture is a drag, not a tap
          lastDrag.current = { x: 0, y: 0 };
          pinchDist.current = 0;
          refs.wake.current?.(); // start the render loop for the drag
        },
        onPanResponderMove: (
          e: GestureResponderEvent,
          g: PanResponderGestureState,
        ) => {
          refs.wake.current?.(); // ref-only mutation → keep the loop awake while moving
          const touches = e.nativeEvent.touches;
          if (touches && touches.length >= 2) {
            const dx = touches[0].pageX - touches[1].pageX;
            const dy = touches[0].pageY - touches[1].pageY;
            const dist = Math.hypot(dx, dy);
            if (pinchDist.current > 0 && dist > 0)
              zoomBy(dist / pinchDist.current);
            pinchDist.current = dist;
            return;
          }
          // Incremental delta since the last move event → smooth rotation. The gain
          // scales with the on-screen globe size (∝ zoom) so the drag STICKS to the
          // surface — the same world arc stays under the finger — instead of spinning
          // about the core at a fixed rate (which felt far too fast).
          const dX = g.dx - lastDrag.current.x;
          const dY = g.dy - lastDrag.current.y;
          lastDrag.current = { x: g.dx, y: g.dy };
          const gain = DRAG_K / (refs.zoom.current * (canvasH.current || 600));
          refs.rot.current.yaw += dX * gain;
          refs.rot.current.pitch += dY * gain;
        },
        onPanResponderRelease: () => {
          refs.dragging.current = false;
          refs.wake.current?.(); // render through the post-release settle
        },
        onPanResponderTerminate: () => {
          refs.dragging.current = false;
          refs.wake.current?.();
        },
      }),
    // refs are stable; create the responder once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const hero = variant === "hero";
  return (
    <View style={[styles.wrap, hero && styles.wrapHero]}>
      <View
        style={[
          styles.canvasWrap,
          hero ? styles.canvasHero : { height },
          WEB_TOUCH,
        ]}
        onLayout={(e) => {
          canvasH.current = e.nativeEvent.layout.height;
          canvasW.current = e.nativeEvent.layout.width;
        }}
        {...panResponder.panHandlers}
      >
        <Canvas
          camera={{ position: [0, 0, 3.2], fov: 45 }}
          // Render on demand (GlobeScene drives a throttled ~30fps loop while animating,
          // 0fps when idle) and cap the pixel ratio so high-DPI phones don't render 3x+
          // the pixels — both big cuts to the globe's sustained GPU/CPU load (heat).
          frameloop="demand"
          dpr={[1, 1.75]}
          onPointerMissed={() => setFocusedId(null)}
        >
          <GlobeScene
            countries={countries}
            regions={regions}
            countryOutline={worldGeo?.countryOutline ?? null}
            outline={regionOutline}
            gizmos={gizmos}
            alerts={alerts}
            onAlertPress={onMarkerSelect}
            askMarkers={askMarkers}
            onAskMarkerPress={onMarkerSelect}
            hoveredMarkerId={hoveredMarkerId}
            focusedMarkerId={focusedMarkerId}
            onMarkerHover={onMarkerHover}
            onMarkersProject={onMarkersProject}
            rightInset={rightInset}
            autoSpin={browse === GEO_ROOT_ID && !activePoolId}
            focusedId={focusedId}
            onFocus={setFocusedId}
            onActivate={activate}
            onHoverMove={onHoverMove}
            refs={refs}
          />
        </Canvas>

        {/* Centered place finder (hero only): one box for continent / country. */}
        {variant === "hero" && (
          <View
            style={[
              styles.searchWrap,
              { top: topInset + spacing.sm, right: rightInset },
            ]}
            pointerEvents="box-none"
          >
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
                onSubmitEditing={() => runAsk(placeQuery)}
              />
              {placeQuery.length > 0 && (
                <Pressable onPress={() => setPlaceQuery("")} hitSlop={8}>
                  <Ionicons
                    name="close-circle"
                    size={16}
                    color={colors.textFaint}
                  />
                </Pressable>
              )}
            </View>
            {placeQuery.trim().length > 0 && (
              <View style={styles.searchResults}>
                {/* Primary action: ask the AI about this query over ALL the news. */}
                <Pressable
                  style={styles.searchResult}
                  onPress={() => runAsk(placeQuery)}
                  accessibilityRole="button"
                >
                  <Ionicons name="sparkles" size={14} color={colors.accent} />
                  <Text style={styles.searchResultText} numberOfLines={1}>
                    {t("ask.action", { q: placeQuery.trim() })}
                  </Text>
                </Pressable>
                {placeResults.map((r) => (
                  <Pressable
                    key={`${r.level}-${r.nodeId}`}
                    style={styles.searchResult}
                    onPress={() => selectPlace(r)}
                    accessibilityRole="button"
                  >
                    <Ionicons
                      name={
                        r.level === "continent"
                          ? "earth"
                          : r.level === "region"
                            ? "location-outline"
                            : "flag-outline"
                      }
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

        {/* AI news-search answer card (hero): streamed synopsis + located reads. The
            globe drops the markers; this carries the prose. */}
        {hero && (asking || askResult || askError) && (
          <View
            style={[styles.askWrap, { right: rightInset + spacing.lg, bottom: bottomInset + 64 }]}
            pointerEvents="box-none"
          >
            <AskPanel
              query={askQuery}
              asking={asking}
              result={askResult}
              error={askError}
              pinCount={askMarkers.length}
              onClose={clearAsk}
              onPlaceTap={(iso2) => {
                const dir = worldGeo?.centroids.byIso2.get(iso2);
                if (!dir) return;
                refs.target.current = {
                  yaw: Math.atan2(-dir.x, dir.z),
                  pitch: clamp(Math.atan2(dir.y, Math.hypot(dir.x, dir.z)), -1.2, 1.2),
                  zoom: 1.8,
                };
                refs.wake.current?.();
              }}
            />
          </View>
        )}

        {/* Top bar: where we are + up-one-level + pin home. In hero it sits BELOW the
            search box so the two never overlap. */}
        <View
          style={[
            styles.topBar,
            // Hero: sit BELOW the centred search box AND centre on the same axis so the
            // two read as one stacked group (left-aligned only in the embedded card).
            hero && { top: topInset + 78, justifyContent: "center" as const },
            { paddingRight: rightInset },
          ]}
          pointerEvents="box-none"
        >
          {!atRoot && (
            <>
              <Pressable
                onPress={goUp}
                style={styles.iconBtn}
                accessibilityRole="button"
                accessibilityLabel={t("geo.allRegions")}
              >
                <Ionicons name="arrow-up" size={14} color={colors.text} />
              </Pressable>
              <Pressable
                onPress={goWorld}
                style={styles.iconBtn}
                accessibilityRole="button"
                accessibilityLabel={t("geo.world")}
              >
                <Ionicons name="earth" size={14} color={colors.text} />
              </Pressable>
            </>
          )}
          <View style={styles.levelPill}>
            <Ionicons
              name="location-outline"
              size={12}
              color={colors.textDim}
            />
            <Text style={styles.levelText} numberOfLines={1}>
              {nodeLabel}
            </Text>
          </View>
          {/* GO to the saved home (distinct from pinning it below). */}
          {home && browse !== home && (
            <Pressable
              onPress={goHome}
              style={styles.iconBtn}
              accessibilityRole="button"
              accessibilityLabel={t("geo.home")}
            >
              <Ionicons name="home" size={14} color={colors.accent} />
            </Pressable>
          )}
          {/* PIN the current place as home (a bookmark, so it never looks like 'go home'). */}
          {onSetHome && !atRoot ? (
            <Pressable
              onPress={() => onSetHome(browse)}
              style={styles.iconBtn}
              accessibilityRole="button"
              accessibilityLabel={t("geo.setHome")}
            >
              <Ionicons
                name={home === browse ? "bookmark" : "bookmark-outline"}
                size={13}
                color={home === browse ? colors.accent : colors.textDim}
              />
            </Pressable>
          ) : null}
        </View>

        {/* Bottom bar: world/international + zoom (the hovered place now shows on the
            cursor-following pin instead of a fixed label here). */}
        <View
          style={[
            styles.bottomBar,
            { bottom: spacing.sm + bottomInset, paddingRight: rightInset },
          ]}
          pointerEvents="box-none"
        >
          {atRoot && onSelectWorld ? (
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
            <Pressable
              onPress={() => zoomBy(1.2)}
              style={styles.iconBtn}
              accessibilityRole="button"
              accessibilityLabel="Zoom in"
            >
              <Ionicons name="add" size={16} color={colors.text} />
            </Pressable>
            <Pressable
              onPress={() => zoomBy(1 / 1.2)}
              style={styles.iconBtn}
              accessibilityRole="button"
              accessibilityLabel="Zoom out"
            >
              <Ionicons name="remove" size={16} color={colors.text} />
            </Pressable>
          </View>
        </View>

        {/* Compact "what's updating" pill so backend work is visible over the globe too.
            Labelled with the FOCUSED node and gated on focusIsFeed so it always agrees with
            the place in view (never the stale/other feed pool). */}
        {hero && status?.active && focusIsFeed && (
          <View
            style={[
              styles.statusWrap,
              { bottom: 56 + bottomInset, right: rightInset },
            ]}
            pointerEvents="none"
          >
            <View style={styles.statusPill}>
              <ActivityIndicator size="small" color={colors.accent} />
              <Text style={styles.statusText} numberOfLines={1}>
                {t("analysis.updating", { place: nodeLabel })}
              </Text>
            </View>
          </View>
        )}

        {/* Worldview legend: which event categories are coloured on the map right now. */}
        {hero && legendCats.length > 0 && (
          <View
            style={[
              styles.legend,
              { bottom: 98 + bottomInset, right: rightInset + spacing.lg },
            ]}
            pointerEvents="none"
          >
            {legendCats.map((cat) => (
              <View key={cat} style={styles.legendItem}>
                <View
                  style={[
                    styles.legendDot,
                    { backgroundColor: EVENT_CATEGORIES[cat].color },
                  ]}
                />
                <Text style={styles.legendText}>
                  {EVENT_CATEGORIES[cat].label}
                </Text>
              </View>
            ))}
          </View>
        )}

        {/* Cursor-following place pin: a floating marker + label for the HOVERED place,
            replacing the old fixed bottom label. pointerEvents none so clicks fall through
            to the globe (which selects). Position is pushed imperatively (onHoverMove). */}
        <CursorPin ref={pinRef} label={focused?.label ?? null} />

        {/* Labels/detail bubbles anchored ON the globe's markers (positions pushed
            imperatively from the scene's frame loop). The CLICKED pin's card is
            interactive (links + selectable text); tapping outside dismisses it. */}
        <MarkerLayer
          ref={markerLayerRef}
          focusedId={focusedMarkerId}
          onDismiss={clearFocus}
          renderFocused={renderFocused}
        />

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
  wrapHero: { flex: 1, gap: 0 },
  canvasWrap: {
    borderRadius: radius.lg,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  // Full-bleed landing: fill the screen, drop the card chrome.
  canvasHero: {
    flex: 1,
    borderRadius: 0,
    borderWidth: 0,
    overflow: "hidden",
    backgroundColor: colors.bg,
  },
  searchWrap: {
    position: "absolute",
    top: spacing.xl,
    left: 0,
    right: 0,
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    // Above the top bar so the results dropdown overlays it instead of being hidden
    // (and stealing its taps) while searching.
    zIndex: 20,
  },
  // AI news-search answer card, anchored bottom-left over the globe (clear of the
  // bottom bar). `right`/`bottom` are applied inline so it dodges the side panel.
  askWrap: {
    position: "absolute",
    left: spacing.lg,
    alignItems: "flex-start",
    zIndex: 20,
  },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    width: "100%",
    maxWidth: 460,
    minHeight: 52,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.surface + "F0",
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
  searchResultText: {
    flex: 1,
    color: colors.text,
    fontSize: font.small,
    fontWeight: "700",
  },
  statusWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 56,
    alignItems: "center",
    paddingHorizontal: spacing.lg,
  },
  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    maxWidth: "100%",
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.surface + "F0",
    borderWidth: 1,
    borderColor: colors.border,
  },
  statusText: {
    color: colors.text,
    fontSize: font.small,
    fontWeight: "700",
    flexShrink: 1,
  },
  legend: {
    position: "absolute",
    left: spacing.lg,
    right: spacing.lg,
    bottom: 98,
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    rowGap: spacing.xs,
    columnGap: spacing.md,
  },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 5 },
  legendDot: { width: 9, height: 9, borderRadius: 5 },
  legendText: { color: colors.textDim, fontSize: font.tiny, fontWeight: "700" },
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
    flexShrink: 1,
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    maxWidth: 200,
  },
  levelText: {
    color: colors.text,
    fontSize: font.small,
    fontWeight: "800",
    flexShrink: 1,
  },
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
  enterText: {
    color: colors.bg,
    fontSize: font.small,
    fontWeight: "800",
    flexShrink: 1,
  },
  zoomGroup: { flexDirection: "row", gap: spacing.xs },
  center: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  errorText: { color: colors.textDim, fontSize: font.small },
  cursorPin: {
    position: "absolute",
    flexDirection: "row",
    alignItems: "center",
    // Anchor the pin's bottom tip at the cursor (the location glyph is ~30px with its tip
    // at the bottom-centre), so the marker points exactly at the hovered place.
    transform: [{ translateX: -15 }, { translateY: -30 }],
  },
  cursorPinIcon: {
    textShadowColor: "rgba(0,0,0,0.55)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  cursorPinLabel: {
    marginLeft: -2,
    marginBottom: 14, // lift the tag toward the pin's round head
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.surface + "F2",
    borderWidth: 1,
    borderColor: colors.border,
    maxWidth: 220,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 6,
    elevation: 6,
  },
  cursorPinText: {
    color: colors.text,
    fontSize: font.small,
    fontWeight: "800",
  },
  // Marker overlay: a stack anchored by its BOTTOM just above each pin (left/bottom set
  // inline to the projected position), centred, auto-height so the full bubble text
  // shows. Detail bubble stacks above the always-on place chip.
  markerTag: {
    position: "absolute",
    width: 220,
    alignItems: "center",
  },
  markerChip: {
    maxWidth: 200,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    borderWidth: 1,
    backgroundColor: colors.surface + "F2",
  },
  markerChipText: {
    color: colors.text,
    fontSize: font.tiny,
    fontWeight: "800",
  },
  markerBubble: {
    maxWidth: 210,
    marginBottom: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.md,
    borderWidth: 1,
    backgroundColor: colors.surface + "F5",
  },
  markerBubbleText: {
    color: colors.textDim,
    fontSize: font.tiny,
    lineHeight: 16,
  },
  // Click-to-focus pin card: a transparent backdrop catches the outside tap to dismiss,
  // while the card itself sits on top and absorbs pointer events (links + text select).
  markerBackdrop: { zIndex: 5 },
  markerFocusedWrap: { zIndex: 10 },
  markerCard: {
    maxWidth: 220,
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    backgroundColor: colors.surface + "FA",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.45,
    shadowRadius: 8,
    elevation: 8,
  },
  markerCardHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  markerCardLabel: { flex: 1, color: colors.text, fontSize: font.small, fontWeight: "800" },
  markerCardText: { color: colors.textDim, fontSize: font.small, lineHeight: 18 },
  markerCardLink: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 2,
    alignSelf: "flex-start",
  },
  markerCardLinkText: { color: colors.accent, fontSize: font.tiny, fontWeight: "700" },
});
