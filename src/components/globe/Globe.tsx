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
  Animated,
  Easing,
  Image,
  Keyboard,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
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
  computeCountryBBoxes,
  continentSlug,
  type BBox,
  type CountryShape,
  type GeoCentroids,
} from "../../lib/geoShapes";
import {
  RECENCY_OPACITY,
  buildAlerts,
  gatheringVisual,
  linkVisual,
  recencyOf,
  withinWindow,
  type GeoAlert,
  type TimeWindow,
} from "../../lib/geoAlerts";
import { countryLabel } from "../../lib/countries";
import { searchPlaces, type PlaceHit } from "../../lib/placeSearch";
import { appendAskStream, resetAskStream } from "../../lib/askStream";
import { buildAskNameIndex, resolveAskPlace, scanCountries } from "../../lib/askLocate";
import { lookupCity } from "../../lib/cityCoords";
import { geocodeGathering } from "../../lib/placeGeocode";
import type { AnalysisStatus, AskResult, Story } from "../../types";
import worldLand from "../../data/world/countries-50m.json";
import { useApp, useT } from "../../store/AppContext";
import { colors, font, radius, spacing } from "../../theme";
import { AskPanel, renderCited } from "./AskPanel";
import {
  GlobeScene,
  type ArcData,
  type AskMarkerData,
  type GatheringData,
  type GlobeCountry,
  type GlobeEntityData,
  type GlobeViewRefs,
  type LinkHoverTip,
  type ProjectedMarker,
} from "./GlobeScene";

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));
// Severity → heat colour for the fan-out rows: muted when low, ramping amber → orange →
// red as a story gets hotter, so "which collapsed stories are hotter" reads at a glance.
const heatColor = (sev: number) =>
  sev >= 0.8 ? "#ef4444" : sev >= 0.6 ? "#f97316" : sev >= 0.45 ? "#f2b705" : colors.textDim;
// Valid Ionicons glyph name — registries/markers store icon names as plain strings, so we
// cast through this when handing them to <Ionicons> for the chips + legend lenses.
type IoniconName = React.ComponentProps<typeof Ionicons>["name"];
// A model-invented kind may carry an icon the bundled Ionicons set doesn't have; fall back to
// a generic glyph so a CUSTOM badge/legend chip never renders blank.
const IONICON_GLYPHS = (Ionicons as unknown as { glyphMap?: Record<string, number> }).glyphMap;
const safeIonicon = (name: string | undefined, fallback: IoniconName): IoniconName =>
  name && IONICON_GLYPHS && name in IONICON_GLYPHS ? (name as IoniconName) : fallback;
// One legend chip: a present link/gathering KIND with its resolved visual (known or custom).
type LegendKind = { kind: string; color: string; icon: string; label: string };
const LINK_KIND_ORDER = ["attack", "tension", "spread", "trade", "migration", "aid", "transport"];
const GATHERING_KIND_ORDER = [
  "summit", "talks", "agreement", "ceasefire", "visit", "forum", "vote",
  "trial", "exercise", "aid", "games", "mission", "ceremony", "other",
];
const EVENT_CATEGORY_ORDER = [
  "conflict", "diplomacy", "unrest", "health", "tech", "disaster", "economy", "other",
];
// Known kinds first (registry order), then model-invented kinds alphabetical by label.
function sortLegend(items: LegendKind[], order: string[]): LegendKind[] {
  return items.slice().sort((a, b) => {
    const ia = order.indexOf(a.kind);
    const ib = order.indexOf(b.kind);
    if (ia !== ib && (ia !== -1 || ib !== -1)) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    return a.label.localeCompare(b.label);
  });
}
const ZOOM_MIN = 0.6;
const ZOOM_MAX = 2.6;
// Worldview time scrubber, widest → narrowest. "all" is the default (the recency is still
// encoded passively on each chip: fresh ones pulse, stale ones fade); the rest NARROW the
// map to events seen within that span, answering "what's happening right now?".
const TIME_WINDOWS: TimeWindow[] = ["all", "week", "day", "now"];
// Stable empty arcs reference — passed while an AI search owns the globe (so the tension
// web hides), avoiding a fresh [] each render that would defeat React.memo(GlobeScene).
const EMPTY_ARCS: ArcData[] = [];
// Same, for the located GATHERINGS — hidden while an AI search owns the globe.
const EMPTY_GATHERINGS: GatheringData[] = [];
// Physical-LINK ties take their per-kind colour from LINK_KINDS (attack/spread/trade/… each
// distinct) so every connection on the globe is self-explanatory.
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

// LEGACY fallback only: side/source zones are now ISO-2 country codes (resolved directly).
// This maps the old curated-zone ids that may still linger in cached stories → ISO-2, so an
// older story's arcs/markers keep resolving until it's re-synthesized. New stories skip it.
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

/** A floating tooltip pinned where the cursor meets a LINK arc's LINE — names the connection
 *  (route + kind) and the STORY that drew it. Position is pushed imperatively (move) so sliding
 *  along the line never re-renders the globe; only its text comes from props. Hidden when no
 *  link is hovered (content null). */
const LinkTip = forwardRef<
  { move: (x: number, y: number) => void },
  { content: { title: string; route: string } | null }
>(function LinkTip({ content }, ref) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  useImperativeHandle(ref, () => ({ move: (x, y) => setPos({ x, y }) }), []);
  if (!content || !pos) return null;
  return (
    <View style={[styles.linkTip, { left: pos.x, top: pos.y }]} pointerEvents="none">
      <Text style={styles.linkBubbleRoute} numberOfLines={1}>
        {content.route}
      </Text>
      <Text style={styles.markerBubbleText} numberOfLines={2}>
        {content.title}
      </Text>
    </View>
  );
});

/** A breathing "live" halo behind a FRESH event chip (≤6h old) — a soft ring that scales out
 *  and fades on a loop, so the eye is pulled to what's breaking right now. Mounted only for
 *  fresh chips, so the animation cost is bounded to the handful of genuinely live events. */
function PulseRing({ color, r }: { color: string; r: number }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(v, {
        toValue: 1,
        duration: 1600,
        easing: Easing.out(Easing.ease),
        useNativeDriver: Platform.OS !== "web", // UI-thread on native; rAF on web
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [v]);
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: -r,
        top: -r,
        width: r * 2,
        height: r * 2,
        borderRadius: r,
        backgroundColor: color,
        opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] }),
        transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [1, 2.4] }) }],
      }}
    />
  );
}

/** 2D overlay that floats event chips / labels / cards ON the globe's markers. GlobeScene's
 *  frame loop drives `set` (projected world→screen) which writes each marker's transform
 *  STRAIGHT to its host node (setNativeProps) — so a moving globe updates chip positions
 *  imperatively WITHOUT a React render, keeping them glued to the surface with zero commit
 *  lag. A React render happens only when the SET of markers (or their static content) changes,
 *  not when
 *  they move. The root is `box-none` so read-only labels never steal globe taps; event
 *  chips ARE interactive (tap → focus); the focused card sits on top over a dismiss
 *  backdrop. Hovering a chip also reports up (onHoverMarker) so the auto-spin pauses. */
const MarkerLayer = forwardRef<
  { set: (items: ProjectedMarker[]) => void },
  {
    /** The clicked pin: its card is interactive + on top. */
    focusedId: string | null;
    /** Tap outside the focused card → release focus. */
    onDismiss: () => void;
    /** Tap an event chip → open/focus it. */
    onPressMarker: (id: string) => void;
    /** Tap a LINK/GATHERING badge → open the story it came from. */
    onOpenStory: (storyId: string) => void;
    /** Tap a magnetic CLUSTER puck → fly-to + zoom to split it (or fan out if it can't split). */
    onExplodeCluster: (it: ProjectedMarker) => void;
    /** Pointer entered (id) / left (null) a chip — pauses/resumes the globe's auto-spin. */
    onHoverMarker: (id: string | null) => void;
    /** A wheel over the overlay (i.e. over a chip) — forwarded to the globe so scroll-zoom
     *  still works when the pointer sits on a chip (the chip would otherwise eat the event). */
    onWheel: (deltaY: number) => void;
    /** Rich, interactive content for the focused card (links + selectable text). */
    renderFocused: (it: ProjectedMarker) => React.ReactNode;
  }
>(function MarkerLayer(
  {
    focusedId,
    onDismiss,
    onPressMarker,
    onOpenStory,
    onExplodeCluster,
    onHoverMarker,
    onWheel,
    renderFocused,
  },
  ref,
) {
  const t = useT();
  const [items, setItems] = useState<ProjectedMarker[]>([]);
  // Which event chip the pointer is over (web) — shows its headline bubble.
  const [hoverId, setHoverId] = useState<string | null>(null);
  // Root overlay node — on web we attach a wheel listener so a scroll over a chip (which
  // sits on top of the canvas and would swallow the event) still zooms the globe.
  const rootRef = useRef<React.ElementRef<typeof View> | null>(null);
  // Each marker's host node + its last screen position. The frame loop writes the transform
  // STRAIGHT to the node (setNativeProps) — synchronously, in the SAME frame the globe
  // renders, with no React commit in between — which is what keeps a chip glued to the
  // surface while dragging (a state/Animated round-trip lands a frame late and trails).
  const nodes = useRef<Map<string, React.ElementRef<typeof View>>>(new Map());
  const pos = useRef<Map<string, { x: number; y: number }>>(new Map());
  const prevKey = useRef(""); // signature of the marker SET + static content (NOT position)
  const setNode = (id: string) => (node: React.ElementRef<typeof View> | null) => {
    if (node) nodes.current.set(id, node);
    else nodes.current.delete(id);
  };
  const transformOf = (p: { x: number; y: number }) => [
    { translateX: p.x },
    { translateY: p.y },
  ];
  // Move a marker's node imperatively (no React render, no commit lag). Cross-platform: on
  // native the ref exposes setNativeProps; on web (react-native-web) the ref IS the DOM node,
  // so we write style.transform straight to it (translate3d → its own GPU layer, smooth).
  const moveNode = (
    node: React.ElementRef<typeof View> | null | undefined,
    x: number,
    y: number,
  ) => {
    if (!node) return;
    const n = node as unknown as {
      setNativeProps?: (props: { style: object }) => void;
      style?: { transform: string };
    };
    if (typeof n.setNativeProps === "function") {
      n.setNativeProps({ style: { transform: transformOf({ x, y }) } });
    } else if (n.style) {
      n.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    }
  };
  const badges = useRef<Map<string, React.ElementRef<typeof View>>>(new Map());
  const setBadge = (id: string) => (node: React.ElementRef<typeof View> | null) => {
    if (node) badges.current.set(id, node);
    else badges.current.delete(id);
  };
  // THROB a TENSION badge in place (mutual strain, not a one-way flow): write a per-frame SCALE
  // to the BADGE node itself — not the anchor — so its sibling hover tooltip doesn't pulse too.
  // Imperative like moveNode (no React render): the scene loop feeds `pulse` every frame.
  const scaleNode = (node: React.ElementRef<typeof View> | null | undefined, s: number) => {
    if (!node) return;
    const n = node as unknown as {
      setNativeProps?: (props: { style: object }) => void;
      style?: { transform: string };
    };
    if (typeof n.setNativeProps === "function") {
      n.setNativeProps({ style: { transform: [{ scale: s }] } });
    } else if (n.style) {
      n.style.transform = `scale(${s})`;
    }
  };
  useImperativeHandle(
    ref,
    () => ({
      set: (next: ProjectedMarker[]) => {
        const seen = new Set<string>();
        for (const it of next) {
          seen.add(it.id);
          pos.current.set(it.id, { x: it.x, y: it.y });
          moveNode(nodes.current.get(it.id), it.x, it.y);
          if (it.pulse != null) scaleNode(badges.current.get(it.id), it.pulse);
        }
        for (const id of [...pos.current.keys()]) if (!seen.has(id)) pos.current.delete(id);
        // Re-render ONLY when the set, a chip's static content, its hovered flag, OR its
        // recency BAND changes (NOT its position — that's imperative; NOT per-frame, since the
        // band only flips at the 6h/24h/7d thresholds). The band drives the fade + the pulse.
        const now = Date.now();
        const key = next
          .map(
            (i) =>
              `${i.id}:${i.kind}:${i.category ?? ""}:${i.count ?? 1}:${Math.round(
                (i.severity ?? 0) * 20,
              )}:${i.hovered ? 1 : 0}:${recencyOf(
                i.updatedAt ?? 0,
                i.developing,
                now,
              )}:${i.linkKind ?? ""}:${i.fromCc ?? ""}:${i.toCc ?? ""}:${i.title ?? ""}:${i.gatheringKind ?? ""}:${(i.parties ?? []).join(",")}:${i.label}:${i.detail}`,
          )
          .join("|");
        if (key === prevKey.current) return;
        prevKey.current = key;
        setItems(next);
      },
    }),
    [],
  );
  // WEB: a wheel over a chip targets the chip (on top of the canvas), so r3f's canvas wheel
  // never fires and you can't zoom while hovering a marker. Listen on the overlay root —
  // wheels bubble up from the chips (pointer-events:auto) through this box-none root — and
  // forward the delta to the globe's zoom. Wheels over EMPTY overlay (no chip) target the
  // canvas directly and are handled by r3f as before, so this only covers the chip case.
  useEffect(() => {
    const root = rootRef.current as unknown as HTMLElement | null;
    if (!root || typeof root.addEventListener !== "function") return; // native: no-op
    const handler = (e: Event) => {
      const we = e as WheelEvent;
      // If the wheel lands inside a scrollable region (the fan-out card's list), let THAT
      // scroll — don't hijack it to zoom the globe.
      let el = we.target as HTMLElement | null;
      while (el && el !== root) {
        if (el.scrollHeight > el.clientHeight) {
          const oy = getComputedStyle(el).overflowY;
          if (oy === "auto" || oy === "scroll") return;
        }
        el = el.parentElement;
      }
      e.preventDefault(); // stop the page from scrolling under the globe
      onWheel(we.deltaY);
    };
    root.addEventListener("wheel", handler, { passive: false });
    return () => root.removeEventListener("wheel", handler);
  }, [onWheel]);
  // Only show the backdrop when the focused pin is actually on screen (front hemisphere),
  // so a stale/occluded focus never traps the globe behind an invisible catcher.
  const focusedShown = focusedId !== null && items.some((i) => i.id === focusedId);
  return (
    <View ref={rootRef} style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {focusedShown && (
        <Pressable
          style={[StyleSheet.absoluteFill, styles.markerBackdrop]}
          onPress={onDismiss}
          accessibilityLabel="Dismiss"
        />
      )}
      {items.map((it) => {
        // A zero-size anchor pinned to the marker's screen point (its transform is written
        // imperatively each frame); content positions relative to that point, so it tracks
        // the spinning globe. Initial transform = last known position (fresh on re-render).
        const transform = transformOf(pos.current.get(it.id) ?? { x: it.x, y: it.y });
        const isFocused = it.id === focusedId;
        // The focused anchor jumps to the TOP: every anchor's `transform` makes its own
        // stacking context, so an inner zIndex can't lift the card above sibling chips — the
        // anchor itself must out-rank them (and the dismiss backdrop).
        const anchorStyle = [
          styles.markerAnchor,
          { transform },
          isFocused && styles.markerAnchorTop,
        ];
        // MAGNETIC CLUSTER: several nearby point markers (events + gatherings) folded into one
        // "+N" puck — a count ringed in the strongest member's colour. TAP it to fly-to its
        // centroid and zoom to the tier where it splits apart (recursive explode); when it can't
        // split further (coincident at max zoom) the tap instead opens a fan-out card (handled by
        // the host) so the reader can pick a story. Hover names how many it hides + pauses spin.
        if (it.kind === "cluster") {
          const count = it.count ?? it.members?.length ?? 2;
          const showBubble = !isFocused && hoverId === it.id;
          return (
            <View key={it.id} ref={setNode(it.id)} style={anchorStyle} pointerEvents="box-none">
              {isFocused ? (
                <View style={[styles.markerStack, styles.markerFocusedWrap]} pointerEvents="box-none">
                  <View style={[styles.markerCard, { borderColor: it.color }]} pointerEvents="auto">
                    {renderFocused(it)}
                  </View>
                </View>
              ) : showBubble ? (
                <View style={[styles.markerStack, { bottom: 24 }]} pointerEvents="none">
                  <View style={[styles.markerBubble, { borderColor: it.color }]}>
                    <Text style={styles.markerBubbleText} numberOfLines={1}>
                      {t("globe.clusterHint", { count })}
                    </Text>
                  </View>
                </View>
              ) : null}
              <Pressable
                style={[styles.clusterChip, { borderColor: it.color }]}
                onPress={() => onExplodeCluster(it)}
                onHoverIn={() => {
                  setHoverId(it.id);
                  onHoverMarker(it.id);
                }}
                onHoverOut={() => {
                  setHoverId((h) => (h === it.id ? null : h));
                  onHoverMarker(null);
                }}
                accessibilityRole="button"
                accessibilityLabel={t("globe.clusterHint", { count })}
              >
                <Text style={[styles.clusterCount, { color: it.color }]}>{count}</Text>
              </Pressable>
            </View>
          );
        }
        // CO-LOCATED GATHERING: a localized badge AT the place — the event-nature ICON ringed
        // by a small FLAG per involved party (a "+N" chip when there are more), with the place
        // name tagged beneath. HOVERING reveals the kind, place, headline and full party list
        // and pauses the spin. NOT an arc: it happened AT one place, not between places.
        if (it.kind === "gathering") {
          const gLabel = it.kindLabel ?? "Gathering";
          const parties = it.parties ?? [];
          const shownParties = parties.slice(0, 4);
          const moreParties = parties.length - shownParties.length;
          const showBubble = hoverId === it.id && !!it.detail;
          const partyNames = parties.map((cc) => countryLabel(cc)).join(" · ");
          return (
            <View key={it.id} ref={setNode(it.id)} style={anchorStyle} pointerEvents="box-none">
              {showBubble && (
                <View style={[styles.markerStack, { bottom: 34 }]} pointerEvents="none">
                  <View style={[styles.markerBubble, { borderColor: it.color }]}>
                    <Text style={styles.linkBubbleRoute} numberOfLines={1}>
                      {gLabel} · {it.label}
                    </Text>
                    <Text style={styles.markerBubbleText} numberOfLines={2}>
                      {it.detail}
                    </Text>
                    {!!partyNames && (
                      <Text style={styles.gatheringParties} numberOfLines={1}>
                        {partyNames}
                      </Text>
                    )}
                  </View>
                </View>
              )}
              <Pressable
                style={styles.gatheringInner}
                onPress={() => it.storyId && onOpenStory(it.storyId)}
                onHoverIn={() => {
                  setHoverId(it.id);
                  onHoverMarker(it.id);
                }}
                onHoverOut={() => {
                  setHoverId((h) => (h === it.id ? null : h));
                  onHoverMarker(null);
                }}
                accessibilityRole="link"
                accessibilityLabel={it.detail}
              >
                <View style={[styles.gatheringBadge, { backgroundColor: it.color }]}>
                  <Ionicons name={safeIonicon(it.icon, "people-circle")} size={16} color="#0b0f14" />
                </View>
                <View style={styles.partyRow} pointerEvents="none">
                  {shownParties.map((cc) => (
                    <View key={cc} style={styles.partyFlag}>
                      {/* Country CODE shows through if the flag image can't load (offline). */}
                      <Text style={styles.partyCode}>{cc.toUpperCase()}</Text>
                      <Image
                        source={{ uri: `https://flagcdn.com/w40/${cc}.png` }}
                        style={styles.partyFlagImg}
                        resizeMode="cover"
                      />
                    </View>
                  ))}
                  {moreParties > 0 && (
                    <View style={styles.partyFlag}>
                      <Text style={styles.partyCode}>+{moreParties}</Text>
                    </View>
                  )}
                </View>
                {!!it.label && (
                  <Text style={styles.gatheringTag} numberOfLines={1}>
                    {it.label}
                  </Text>
                )}
              </Pressable>
            </View>
          );
        }
        // PHYSICAL LINK: a small badge riding the connection arc. An ATTACK flies the ORIGIN
        // country's FLAG; every other kind shows its category icon (medical, ship, people…),
        // tinted the arc's colour. The line carries colour + dash; this badge says WHAT it is.
        // HOVERING it reveals which STORY drew the link (route + kind + headline) and pauses
        // the spin so the moving badge is easy to inspect.
        if (it.kind === "link") {
          const isAttack = it.linkKind === "attack" && !!it.fromCc;
          const showBubble = hoverId === it.id && !!it.title;
          const route =
            `${it.fromCc ? countryLabel(it.fromCc) : "?"} → ` +
            `${it.toCc ? countryLabel(it.toCc) : "?"} · ${it.kindLabel ?? "Link"}`;
          return (
            <View key={it.id} ref={setNode(it.id)} style={anchorStyle} pointerEvents="box-none">
              {showBubble && (
                <View style={[styles.markerStack, { bottom: 20 }]} pointerEvents="none">
                  <View style={[styles.markerBubble, { borderColor: it.color }]}>
                    <Text style={styles.linkBubbleRoute} numberOfLines={1}>
                      {route}
                    </Text>
                    <Text style={styles.markerBubbleText} numberOfLines={2}>
                      {it.title}
                    </Text>
                  </View>
                </View>
              )}
              <Pressable
                ref={setBadge(it.id)}
                style={[styles.linkBadge, { backgroundColor: it.color }]}
                onPress={() => it.storyId && onOpenStory(it.storyId)}
                onHoverIn={() => {
                  setHoverId(it.id);
                  onHoverMarker(it.id); // pause the auto-spin while the reader inspects
                }}
                onHoverOut={() => {
                  setHoverId((h) => (h === it.id ? null : h));
                  onHoverMarker(null);
                }}
                accessibilityRole="link"
                accessibilityLabel={it.title}
              >
                {isAttack ? (
                  <>
                    {/* The country CODE shows through if the flag image can't load (offline). */}
                    <Text style={styles.linkCode}>{it.fromCc!.toUpperCase()}</Text>
                    <Image
                      source={{ uri: `https://flagcdn.com/w80/${it.fromCc}.png` }}
                      style={styles.linkFlagImg}
                      resizeMode="cover"
                    />
                  </>
                ) : (
                  <Ionicons
                    name={safeIonicon(it.icon, "git-network")}
                    size={15}
                    color="#0b0f14"
                  />
                )}
              </Pressable>
            </View>
          );
        }
        // WORLDVIEW EVENT: a legible, category-coloured ICON chip sitting on the point. The
        // chip STAYS visible when focused; its card (aggregated fan-out) floats just above it.
        // Size scales with severity; a "+N" badge marks stacked events; hover → headline
        // bubble AND pauses the spin. Constant on-screen size at any zoom.
        if (it.kind === "alert" && it.category) {
          const cr = Math.round(11 + (it.severity ?? 0.4) * 7); // chip RADIUS (px)
          const showBubble = !isFocused && hoverId === it.id && !!it.detail;
          const more = (it.count ?? 1) - 1;
          // RECENCY treatment: a fresh event (≤6h) wears a live pulse; older settled ones fade
          // so the map foregrounds what's happening now. Hovered/focused chips show at full
          // strength so inspecting one never makes it look stale.
          const recency = recencyOf(it.updatedAt ?? 0, it.developing);
          const fresh = recency === "fresh";
          const chipOpacity =
            isFocused || hoverId === it.id ? 1 : RECENCY_OPACITY[recency];
          return (
            <View key={it.id} ref={setNode(it.id)} style={anchorStyle} pointerEvents="box-none">
              {isFocused ? (
                <View style={[styles.markerStack, styles.markerFocusedWrap]} pointerEvents="box-none">
                  <View style={[styles.markerCard, { borderColor: it.color }]} pointerEvents="auto">
                    {renderFocused(it)}
                  </View>
                </View>
              ) : showBubble ? (
                <View style={[styles.markerStack, { bottom: cr + 6 }]} pointerEvents="none">
                  <View style={[styles.markerBubble, { borderColor: it.color }]}>
                    <Text style={styles.markerBubbleText} numberOfLines={3}>
                      {it.detail}
                    </Text>
                  </View>
                </View>
              ) : null}
              {fresh && <PulseRing color={it.color} r={cr} />}
              <Pressable
                style={[
                  styles.eventChip,
                  {
                    left: -cr,
                    top: -cr,
                    width: cr * 2,
                    height: cr * 2,
                    borderRadius: cr,
                    backgroundColor: it.color,
                    opacity: chipOpacity,
                  },
                ]}
                onPress={() => onPressMarker(it.id)}
                onHoverIn={() => {
                  setHoverId(it.id);
                  onHoverMarker(it.id); // pause the auto-spin while the reader inspects
                }}
                onHoverOut={() => {
                  setHoverId((h) => (h === it.id ? null : h));
                  onHoverMarker(null);
                }}
                accessibilityRole="button"
                accessibilityLabel={it.detail}
              >
                <Ionicons
                  name={safeIonicon(it.icon, "ellipse")}
                  size={Math.round(cr * 1.15)}
                  color="#0b0f14"
                />
                {more > 0 && (
                  <View style={styles.eventCount}>
                    <Text style={styles.eventCountText}>{more > 9 ? "9+" : `+${more}`}</Text>
                  </View>
                )}
              </Pressable>
            </View>
          );
        }
        // AI-SEARCH pin: an always-on place label (or its interactive card when focused).
        return (
          <View
            key={it.id}
            ref={setNode(it.id)}
            style={anchorStyle}
            pointerEvents={isFocused ? "box-none" : "none"}
          >
            {isFocused ? (
              <View style={[styles.markerStack, styles.markerFocusedWrap]} pointerEvents="box-none">
                <View style={[styles.markerCard, { borderColor: it.color }]} pointerEvents="auto">
                  {renderFocused(it)}
                </View>
              </View>
            ) : (
              <View style={styles.markerStack} pointerEvents="none">
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
            )}
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
  // The link-line tooltip's TEXT (route + story headline); its POSITION is pushed imperatively
  // to linkTipRef. `linkTipTitle` tracks the shown story so sliding along one line doesn't
  // re-render the globe on every pointer move (only entering a DIFFERENT link does).
  const [linkTip, setLinkTip] = useState<{ title: string; route: string } | null>(null);
  const linkTipRef = useRef<{ move: (x: number, y: number) => void } | null>(null);
  const linkTipTitle = useRef<string | null>(null);
  // The CLICKED marker, whose interactive card stays open (links + selectable text) until
  // the reader taps outside it.
  const [focusedMarkerId, setFocusedMarkerId] = useState<string | null>(null);
  // Worldview LENSES: categories the reader has toggled OFF in the legend (hidden from the
  // map), so the globe answers "where are the {conflicts|disasters|…}?" by filtering. Empty
  // = show everything. Toggling a legend chip flips its category in/out.
  const [hiddenCats, setHiddenCats] = useState<Set<string>>(() => new Set());
  // Worldview TIME scrubber: narrow the map to events seen within a recency window
  // ("all" = no time filter; recency is still encoded on every chip regardless).
  const [timeWindow, setTimeWindow] = useState<TimeWindow>("all");
  const toggleCat = useCallback((c: string) => {
    setHiddenCats((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  }, []);
  // CONNECTION + GATHERING legends are lenses too: link KINDS / gathering KINDS the reader has
  // toggled OFF (hidden from the globe). Empty = show everything; the legend still lists every
  // present kind so a hidden one can be toggled back on.
  const [hiddenLinks, setHiddenLinks] = useState<Set<string>>(() => new Set());
  const [hiddenGatherings, setHiddenGatherings] = useState<Set<string>>(() => new Set());
  const toggleLink = useCallback((k: string) => {
    setHiddenLinks((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }, []);
  const toggleGathering = useCallback((k: string) => {
    setHiddenGatherings((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }, []);
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
    bboxes: Map<string, BBox>;
  } | null>(() => {
    try {
      const geo = worldLand as unknown as Parameters<
        typeof buildCountryShapes
      >[0];
      return {
        shapes: buildCountryShapes(geo, LAND_RADIUS),
        centroids: computeCentroids(geo),
        countryOutline: buildOutline(geo.features, COUNTRY_OUTLINE_RADIUS),
        bboxes: computeCountryBBoxes(geo),
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
      if (ex) {
        ex.count = (ex.count ?? 1) + 1;
        // keep each collapsed story (with its own severity) for the fan-out heat cue
        ex.stacked!.push({ id: a.id, title: a.title, severity: a.severity });
        ex.updatedAt = Math.max(ex.updatedAt, a.updatedAt); // FRESHEST drives the pulse
        ex.developing = ex.developing || a.developing; // ongoing if ANY collapsed issue is
      } else {
        byLoc.set(key, {
          ...a,
          count: 1,
          stacked: [{ id: a.id, title: a.title, severity: a.severity }],
        });
      }
    }
    return [...byLoc.values()].slice(0, 40);
  }, [worldGeo, stories]);

  // RELATIONSHIPS web — flowing great-circle LINK ties, time-windowed + capped so the globe
  // reads as a clear instrument, not a hairball: one per story that physically connects two
  // places (model-emitted `links`, origin → destination) — a disease spread, shipment,
  // migration, route, attack, … Each takes its kind's colour/dash and rides a flag/icon badge
  // (NO bare comet); the badge always flows a → b.
  const relationshipArcs = useMemo<ArcData[]>(() => {
    if (!worldGeo) return [];
    const byIso2 = worldGeo.centroids.byIso2;
    const now = Date.now();
    const out: ArcData[] = [];
    // LINK ties: any story connecting two physical places (origin → destination).
    const linked = stories
      .filter((s) => (s.links?.length ?? 0) > 0 && withinWindow(s.updatedAt, timeWindow, now))
      .sort((a, b) => (b.severity ?? 0) - (a.severity ?? 0))
      .slice(0, 10);
    for (const s of linked) {
      const links = s.links ?? [];
      for (let i = 0; i < links.length; i++) {
        const lk = links[i];
        const a = byIso2.get(lk.from);
        const b = byIso2.get(lk.to);
        if (!a || !b) continue;
        if (a.x * b.x + a.y * b.y + a.z * b.z > 0.9999) continue; // same country → skip
        // Known kind → curated visual; a model-invented kind → hashed colour + its own icon.
        const v = linkVisual(lk.kind, lk.icon);
        out.push({
          id: `link:${s.id}:${i}`,
          a,
          b,
          severity: s.severity ?? 0.6,
          color: v.color,
          dash: v.dash,
          kind: lk.kind,
          icon: v.icon,
          label: v.label,
          fromCc: lk.from,
          toCc: lk.to,
          storyId: s.id,
          title: s.title,
        });
      }
    }
    return out.slice(0, 20); // hard cap so the flow animation stays bounded
  }, [worldGeo, stories, timeWindow]);

  // CO-LOCATED multi-party events ("gatherings") localized AT their place — a summit, talks,
  // a signing, a forum, … — NOT drawn as arcs. Each story.gatherings entry is geolocated
  // best-first (gazetteer name → validated model coords → country centroid), de-duped by
  // resolved point, and time-windowed + capped like the arcs so the globe stays readable.
  const gatheringMarkers = useMemo<GatheringData[]>(() => {
    if (!worldGeo) return [];
    const now = Date.now();
    const ctx = {
      lookupCity,
      bboxes: worldGeo.bboxes,
      byIso2: worldGeo.centroids.byIso2,
    };
    const out: GatheringData[] = [];
    const seen = new Set<string>();
    const withG = stories
      .filter((s) => (s.gatherings?.length ?? 0) > 0 && withinWindow(s.updatedAt, timeWindow, now))
      .sort((a, b) => (b.severity ?? 0) - (a.severity ?? 0))
      .slice(0, 12);
    for (const s of withG) {
      const gs = s.gatherings ?? [];
      for (let i = 0; i < gs.length; i++) {
        const g = gs[i];
        const dir = geocodeGathering(g, ctx);
        if (!dir) continue;
        // Collapse gatherings resolving to the same point (e.g. two summits in one capital).
        const key = `${dir.x.toFixed(2)}|${dir.y.toFixed(2)}|${dir.z.toFixed(2)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // Known kind → curated visual; a model-invented kind → hashed colour + its own icon.
        const v = gatheringVisual(g.kind, g.icon);
        out.push({
          id: `gathering:${s.id}:${i}`,
          storyId: s.id,
          dir,
          kind: g.kind,
          icon: v.icon,
          label: v.label,
          place: g.place,
          parties: g.parties,
          color: v.color,
          title: s.title,
        });
        if (out.length >= 14) break;
      }
      if (out.length >= 14) break;
    }
    return out;
  }, [worldGeo, stories, timeWindow]);

  // id → alert, so a focused chip's card can look up its full record (incl. the `stacked`
  // events it aggregates) without threading that whole list through the projected markers.
  const alertById = useMemo(
    () => new Map(alerts.map((a) => [a.id, a])),
    [alerts],
  );

  // The categories actually present, for the on-globe legend (in a stable order).
  const legendCats = useMemo<LegendKind[]>(() => {
    const m = new Map<string, LegendKind>();
    for (const a of alerts) {
      if (m.has(a.category)) continue;
      m.set(a.category, { kind: a.category, color: a.color, icon: a.icon, label: a.label });
    }
    return sortLegend([...m.values()], EVENT_CATEGORY_ORDER);
  }, [alerts]);

  // The link KINDS currently on the globe, for the CONNECTIONS legend (stable order). Drawn
  // from the time-windowed, capped relationshipArcs so it names only what's actually shown.
  const legendLinkKinds = useMemo<LegendKind[]>(() => {
    const m = new Map<string, LegendKind>();
    for (const arc of relationshipArcs) {
      if (!arc.kind || m.has(arc.kind)) continue;
      m.set(arc.kind, {
        kind: arc.kind,
        color: arc.color ?? "#9aa4b2",
        icon: arc.icon ?? "git-network",
        label: arc.label ?? arc.kind,
      });
    }
    return sortLegend([...m.values()], LINK_KIND_ORDER);
  }, [relationshipArcs]);

  // The gathering KINDS currently on the globe, for the GATHERINGS legend (stable order).
  const legendGatheringKinds = useMemo<LegendKind[]>(() => {
    const m = new Map<string, LegendKind>();
    for (const g of gatheringMarkers) {
      if (m.has(g.kind)) continue;
      m.set(g.kind, { kind: g.kind, color: g.color, icon: g.icon, label: g.label });
    }
    return sortLegend([...m.values()], GATHERING_KIND_ORDER);
  }, [gatheringMarkers]);

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

  // What the globe actually paints as event chips: the located events MINUS any category
  // the reader toggled off (the legend lenses). While an AI search is showing its own pins,
  // we drop the worldview events entirely so the answer's places stand alone.
  const visibleAlerts = useMemo<GeoAlert[]>(() => {
    if (askMarkers.length > 0) return [];
    const now = Date.now();
    return alerts.filter(
      (a) => !hiddenCats.has(a.category) && withinWindow(a.updatedAt, timeWindow, now),
    );
  }, [alerts, hiddenCats, timeWindow, askMarkers.length]);

  // Connection arcs the globe actually draws: all of them MINUS any link KIND toggled off in the
  // legend. Hidden behind an AI search (the answer's pins stand alone). Returns the original
  // array verbatim when nothing's hidden, to keep the prop referentially stable for memo(Scene).
  const visibleArcs = useMemo<ArcData[]>(() => {
    if (askMarkers.length > 0) return EMPTY_ARCS;
    if (hiddenLinks.size === 0) return relationshipArcs;
    return relationshipArcs.filter((a) => !a.kind || !hiddenLinks.has(a.kind));
  }, [relationshipArcs, hiddenLinks, askMarkers.length]);

  // Gathering badges the globe actually draws: all of them MINUS any gathering KIND toggled off.
  const visibleGatherings = useMemo<GatheringData[]>(() => {
    if (askMarkers.length > 0) return EMPTY_GATHERINGS;
    if (hiddenGatherings.size === 0) return gatheringMarkers;
    return gatheringMarkers.filter((g) => !hiddenGatherings.has(g.kind));
  }, [gatheringMarkers, hiddenGatherings, askMarkers.length]);

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
  // Tapping a 2D event CHIP. A lone event opens its STORY PANEL straight away (no detour
  // through a summary card); an aggregated chip (many stories on one spot) opens the fan-out
  // card so the reader can pick which one. (No `didDrag` guard: a chip tap doesn't go through
  // the globe's PanResponder, so the flag is never reset for it; the Pressable handles taps.)
  const onChipPress = useCallback(
    (id: string) => {
      const a = alertById.get(id);
      if (a && (a.stacked?.length ?? 1) > 1) setFocusedMarkerId(id);
      else onAlertPress?.(id);
    },
    [alertById, onAlertPress],
  );
  // onAlertPress comes in as a fresh arrow each host render; read it through a ref so the
  // handlers below stay REFERENTIALLY STABLE (they're passed to memo(GlobeScene), which would
  // otherwise re-reconcile the whole scene on every 3s status poll).
  const onAlertPressRef = useRef(onAlertPress);
  onAlertPressRef.current = onAlertPress;
  // Tapping a LINK or GATHERING badge opens the story it came from. These badges are 2D
  // overlay Pressables (not through the globe's PanResponder), so — like the event chips —
  // they need no `didDrag` guard. This also stops a badge sitting ON TOP of an event chip
  // from swallowing the click: the badge now resolves it to its OWN story.
  const onOpenStory = useCallback((storyId: string) => {
    setFocusedMarkerId(null);
    onAlertPressRef.current?.(storyId);
  }, []);
  // Clicking a LINK arc's LINE opens its story too. This DOES go through the canvas, so guard
  // against a drag-to-rotate that happens to release over a tie (mirrors `activate`).
  const onLinkPress = useCallback((storyId: string) => {
    if (didDrag.current) return;
    onAlertPressRef.current?.(storyId);
  }, []);
  const clearFocus = useCallback(() => setFocusedMarkerId(null), []);
  // Tapping a magnetic CLUSTER puck EXPLODES it: fly to its centroid and zoom to the tier where
  // it splits apart (recursive — the sub-clusters can then be tapped in turn). When it can't be
  // split by zooming (members near-coincident, so the break zoom is already at/over the cap),
  // open its fan-out card instead so the reader can still pick a story. Overlay Pressable (not
  // through the globe PanResponder), so no didDrag guard — same as the event chips.
  const onExplodeCluster = useCallback(
    (it: ProjectedMarker) => {
      const d = it.clusterDir;
      const z = it.clusterZoom ?? ZOOM_MAX;
      if (d && z > refs.zoom.current + 0.08) {
        setFocusedMarkerId(null);
        refs.target.current = {
          yaw: Math.atan2(-d.x, d.z),
          pitch: clamp(Math.atan2(d.y, Math.hypot(d.x, d.z)), -1.2, 1.2),
          zoom: Math.min(ZOOM_MAX, z),
        };
        refs.wake.current?.();
      } else {
        // No room to separate by zooming → fan out the folded markers for the reader to pick.
        setFocusedMarkerId(it.id);
      }
    },
    [refs],
  );
  // Scroll-zoom forwarded from the overlay when the pointer is over a chip (the chip would
  // otherwise eat the wheel). Centred zoom mirroring r3f's wheel step; cancels any fly-to.
  const onOverlayWheel = useCallback(
    (deltaY: number) => {
      refs.zoom.current = clamp(
        refs.zoom.current * (deltaY < 0 ? 1.12 : 1 / 1.12),
        ZOOM_MIN,
        ZOOM_MAX,
      );
      refs.target.current = null;
      refs.wake.current?.();
    },
    [refs],
  );

  // The interactive content of a focused pin's card: selectable text + clickable links.
  // Ask pins show the place + its blurb with inline citation links (and a locate action);
  // event pins show the headline + an "open story" link.
  const renderFocused = useCallback(
    (it: ProjectedMarker) => {
      // MAGNETIC CLUSTER that can't be split by zooming (coincident at max zoom) → a fan-out
      // list of every folded marker (events + gatherings mixed), hottest first, each a row that
      // opens its story. Mirrors the stacked-alert fan-out so the two read as one affordance.
      if (it.isCluster) {
        const rows = [...(it.members ?? [])].sort((a, b) => b.severity - a.severity);
        return (
          <>
            <Text style={styles.markerCardCount}>
              {t("globe.storiesHere", { count: rows.length })}
            </Text>
            <ScrollView
              style={styles.markerCardScroll}
              contentContainerStyle={styles.markerCardScrollBody}
              nestedScrollEnabled
              showsVerticalScrollIndicator
            >
              {rows.map((m) => (
                <Pressable
                  key={m.id}
                  style={styles.markerCardRow}
                  onPress={() => {
                    if (m.storyId) onAlertPress?.(m.storyId);
                    setFocusedMarkerId(null);
                  }}
                  accessibilityRole="link"
                >
                  <View style={[styles.markerCardHeat, { backgroundColor: heatColor(m.severity) }]} />
                  <Text style={styles.markerCardRowText}>{m.title}</Text>
                  <Ionicons
                    name="open-outline"
                    size={13}
                    color={colors.accent}
                    style={styles.markerCardRowOpen}
                  />
                </Pressable>
              ))}
            </ScrollView>
          </>
        );
      }
      if (it.kind === "alert") {
        // An aggregated chip (many stories on one country) FANS OUT: list every collapsed
        // headline, each its own tap-to-open row. A lone event keeps the simple card.
        const stacked = alertById.get(it.id)?.stacked ?? [
          { id: it.id, title: it.detail, severity: it.severity ?? 0.5 },
        ];
        if (stacked.length > 1) {
          // Hottest (highest severity) first, so the eye lands on the biggest story; each
          // row's heat DOT colour encodes its severity so "which are hotter" is at a glance.
          const rows = [...stacked].sort((a, b) => b.severity - a.severity);
          return (
            <>
              <Text style={styles.markerCardCount}>
                {t("globe.storiesHere", { count: rows.length })}
              </Text>
              {/* Cap the height and scroll when many stories collapse here, so a busy
                  country (e.g. 12+ events) doesn't grow a card taller than the screen. */}
              <ScrollView
                style={styles.markerCardScroll}
                contentContainerStyle={styles.markerCardScrollBody}
                nestedScrollEnabled
                showsVerticalScrollIndicator
              >
                {rows.map((s) => (
                  <Pressable
                    key={s.id}
                    style={styles.markerCardRow}
                    onPress={() => {
                      onAlertPress?.(s.id);
                      setFocusedMarkerId(null);
                    }}
                    accessibilityRole="link"
                  >
                    <View
                      style={[styles.markerCardHeat, { backgroundColor: heatColor(s.severity) }]}
                    />
                    {/* FULL headline (no truncation) so the reader can actually read each one. */}
                    <Text style={styles.markerCardRowText}>{s.title}</Text>
                    <Ionicons
                      name="open-outline"
                      size={13}
                      color={colors.accent}
                      style={styles.markerCardRowOpen}
                    />
                  </Pressable>
                ))}
              </ScrollView>
            </>
          );
        }
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
    [onAlertPress, t, flyToAskMarker, askResult, alertById],
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
  // Pointer over a LINK arc's LINE → float a tooltip (route + kind + story headline) at the
  // hit point and pause the auto-spin so the now-still line keeps it put; leaving clears it.
  // Position updates imperatively every move; the TEXT re-renders ONLY when the link changes.
  const onLinkHover = useCallback((tip: LinkHoverTip | null) => {
    if (!tip || !tip.title) {
      if (linkTipTitle.current !== null) {
        linkTipTitle.current = null;
        setLinkTip(null);
        setHoveredMarkerId(null); // resume the auto-spin
      }
      return;
    }
    linkTipRef.current?.move(tip.x, tip.y);
    if (linkTipTitle.current !== tip.title) {
      linkTipTitle.current = tip.title;
      const route =
        `${tip.fromCc ? countryLabel(tip.fromCc) : "?"} → ` +
        `${tip.toCc ? countryLabel(tip.toCc) : "?"} · ${linkVisual(tip.kind ?? "").label}`;
      setLinkTip({ title: tip.title, route });
      setHoveredMarkerId("__link__"); // pause the auto-spin while inspecting
    }
  }, []);
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
          // A few-px hover tolerance so the thin LINK arc lines are easy to hover (the arcs are
          // the only interactive lines, so this affects nothing else).
          onCreated={({ raycaster }) => {
            raycaster.params.Line = { threshold: 0.03 };
          }}
          onPointerMissed={() => setFocusedId(null)}
        >
          <GlobeScene
            countries={countries}
            regions={regions}
            countryOutline={worldGeo?.countryOutline ?? null}
            outline={regionOutline}
            gizmos={gizmos}
            alerts={visibleAlerts}
            arcs={visibleArcs}
            askMarkers={askMarkers}
            gatherings={visibleGatherings}
            onAskMarkerPress={onMarkerSelect}
            hoveredMarkerId={hoveredMarkerId}
            focusedMarkerId={focusedMarkerId}
            onMarkerHover={onMarkerHover}
            onLinkHover={onLinkHover}
            onLinkPress={onLinkPress}
            onMarkersProject={onMarkersProject}
            rightInset={rightInset}
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

        {/* Worldview LENS DOCK (bottom-right): a TIME scrubber over the category legend.
            Together they answer "what kind of events, happening when?" — narrow by recency
            window and isolate a category, while the chips themselves encode freshness. */}
        {hero && (legendCats.length > 0 || legendLinkKinds.length > 0 || legendGatheringKinds.length > 0) && (
          <View
            style={[
              styles.lensDock,
              { bottom: 98 + bottomInset, right: rightInset + spacing.lg },
            ]}
            pointerEvents="box-none"
          >
            {legendCats.length > 0 && (
              <>
                {/* TIME scrubber — narrow the worldview to a recency window. Fresh events
                    still pulse and stale ones fade on the map regardless; this hides what's
                    outside. */}
                <View style={styles.scrubber}>
                  {TIME_WINDOWS.map((w) => {
                    const on = timeWindow === w;
                    return (
                      <Pressable
                        key={w}
                        style={[styles.scrubItem, on && styles.scrubItemOn]}
                        onPress={() => setTimeWindow(w)}
                        accessibilityRole="button"
                        accessibilityState={{ selected: on }}
                        accessibilityLabel={t(`globe.time.${w}`)}
                      >
                        <Text style={[styles.scrubText, on && styles.scrubTextOn]}>
                          {t(`globe.time.${w}`)}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
                {/* Category legend = LENSES: tap one to isolate "just conflicts" / "just
                    disasters"; hidden ones dim. Icon + colour match the on-globe chips. */}
                <View style={styles.legend} pointerEvents="box-none">
                  {legendCats.map((cat) => {
                    const off = hiddenCats.has(cat.kind);
                    return (
                      <Pressable
                        key={cat.kind}
                        style={[styles.legendItem, off && styles.legendItemOff]}
                        onPress={() => toggleCat(cat.kind)}
                        accessibilityRole="button"
                        accessibilityState={{ selected: !off }}
                        accessibilityLabel={cat.label}
                      >
                        <View style={[styles.legendDot, { backgroundColor: cat.color }]}>
                          <Ionicons
                            name={safeIonicon(cat.icon, "ellipse")}
                            size={9}
                            color="#0b0f14"
                          />
                        </View>
                        <Text style={[styles.legendText, off && styles.legendTextOff]}>
                          {cat.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </>
            )}
            {/* CONNECTIONS legend = LENSES: tap a link KIND to hide/show its arcs on the globe;
                hidden ones dim. Icon + colour match the travelling badges. */}
            {legendLinkKinds.length > 0 && (
              <View style={styles.linkLegendWrap} pointerEvents="box-none">
                <View style={styles.legend}>
                  {legendLinkKinds.map((k) => {
                    const off = hiddenLinks.has(k.kind);
                    return (
                      <Pressable
                        key={k.kind}
                        style={[styles.legendItem, off && styles.legendItemOff]}
                        onPress={() => toggleLink(k.kind)}
                        accessibilityRole="button"
                        accessibilityState={{ selected: !off }}
                        accessibilityLabel={k.label}
                      >
                        <View style={[styles.legendDot, { backgroundColor: k.color }]}>
                          <Ionicons
                            name={safeIonicon(k.icon, "git-network")}
                            size={9}
                            color="#0b0f14"
                          />
                        </View>
                        <Text style={[styles.legendText, off && styles.legendTextOff]}>
                          {k.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            )}
            {/* GATHERINGS legend = LENSES: tap a co-located event KIND to hide/show its badges;
                hidden ones dim. */}
            {legendGatheringKinds.length > 0 && (
              <View style={styles.linkLegendWrap} pointerEvents="box-none">
                <View style={styles.legend}>
                  {legendGatheringKinds.map((k) => {
                    const off = hiddenGatherings.has(k.kind);
                    return (
                      <Pressable
                        key={k.kind}
                        style={[styles.legendItem, off && styles.legendItemOff]}
                        onPress={() => toggleGathering(k.kind)}
                        accessibilityRole="button"
                        accessibilityState={{ selected: !off }}
                        accessibilityLabel={k.label}
                      >
                        <View style={[styles.legendDot, { backgroundColor: k.color }]}>
                          <Ionicons
                            name={safeIonicon(k.icon, "people-circle")}
                            size={9}
                            color="#0b0f14"
                          />
                        </View>
                        <Text style={[styles.legendText, off && styles.legendTextOff]}>
                          {k.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            )}
          </View>
        )}

        {/* Cursor-following place pin: a floating marker + label for the HOVERED place,
            replacing the old fixed bottom label. pointerEvents none so clicks fall through
            to the globe (which selects). Position is pushed imperatively (onHoverMove). */}
        <CursorPin ref={pinRef} label={focused?.label ?? null} />

        {/* Tooltip floating where the cursor meets a LINK arc's line — names the connection
            and the story behind it. Position pushed imperatively; text from state. */}
        <LinkTip ref={linkTipRef} content={linkTip} />

        {/* Labels/detail bubbles anchored ON the globe's markers (positions pushed
            imperatively from the scene's frame loop). The CLICKED pin's card is
            interactive (links + selectable text); tapping outside dismisses it. */}
        <MarkerLayer
          ref={markerLayerRef}
          focusedId={focusedMarkerId}
          onDismiss={clearFocus}
          onPressMarker={onChipPress}
          onOpenStory={onOpenStory}
          onExplodeCluster={onExplodeCluster}
          onHoverMarker={onMarkerHover}
          onWheel={onOverlayWheel}
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
  // Bottom-right dock stacking the TIME scrubber over the category legend. Anchored with
  // a fixed left edge (and inline right/bottom) so the legend has room to wrap, and centred.
  lensDock: {
    position: "absolute",
    left: spacing.lg,
    alignItems: "center",
    rowGap: spacing.xs,
  },
  // Segmented TIME scrubber pill row (All · Week · 24h · Now).
  scrubber: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    padding: 3,
    borderRadius: radius.pill,
    backgroundColor: colors.surface + "E6",
    borderWidth: 1,
    borderColor: colors.border,
  },
  scrubItem: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  scrubItemOn: { backgroundColor: colors.accent },
  scrubText: { color: colors.textDim, fontSize: font.tiny, fontWeight: "800" },
  scrubTextOn: { color: "#0b0f14" },
  legend: {
    alignSelf: "stretch",
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    rowGap: spacing.xs,
    columnGap: spacing.md,
  },
  // Each legend entry is a tappable LENS pill (icon swatch + label). Dimmed when toggled off.
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingLeft: 4,
    paddingRight: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: colors.surface + "E6",
    borderWidth: 1,
    borderColor: colors.border,
  },
  legendItemOff: { opacity: 0.4 },
  // Colour swatch holding the category's icon — matches the on-globe chip exactly.
  legendDot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
  },
  legendText: { color: colors.text, fontSize: font.tiny, fontWeight: "800" },
  legendTextOff: { color: colors.textDim },
  // A worldview EVENT, drawn as a constant-size icon chip pinned on its globe point.
  eventChip: {
    position: "absolute",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: "#0b0f14AA",
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
  },
  // "+N" badge for events stacked on one place.
  eventCount: {
    position: "absolute",
    top: -4,
    right: -6,
    minWidth: 15,
    height: 15,
    paddingHorizontal: 3,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  eventCountText: { color: colors.text, fontSize: 9, fontWeight: "800" },
  // MAGNETIC CLUSTER puck: a dark disc RINGED in the strongest member's colour with the folded
  // count centred — visually distinct from a solid event chip so "this is a group, tap to zoom"
  // reads at a glance. Centred on its globe point (negative offsets = half its size).
  clusterChip: {
    position: "absolute",
    left: -17,
    top: -17,
    width: 34,
    height: 34,
    borderRadius: 17,
    paddingHorizontal: 3,
    minWidth: 34,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2.5,
    backgroundColor: colors.surface,
    shadowColor: "#000",
    shadowOpacity: 0.4,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
  },
  clusterCount: { fontSize: 14, fontWeight: "900" },
  // Travelling badge on a physical-LINK arc (flag image for attacks, kind icon otherwise),
  // centred on the arc's flowing point. SOLID per-kind fill (set inline) + a dark icon keeps
  // it legible under motion, like the event chips.
  linkBadge: {
    position: "absolute",
    left: -13,
    top: -13,
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 1.5,
    borderColor: "rgba(255,255,255,0.55)", // light ring so the badge stays legible in motion
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden", // clip the flag image to the circle
  },
  // Flag image fills the badge (attack links); country code sits behind it as the fallback.
  linkFlagImg: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
  linkCode: { color: "#fff", fontSize: 10, fontWeight: "800" },
  // Hover tooltip on a link badge: the route + kind (bold) over the story headline (dim).
  linkBubbleRoute: {
    color: colors.text,
    fontSize: font.tiny,
    fontWeight: "800",
    marginBottom: 2,
  },
  // CO-LOCATED gathering badge: the event-nature ICON over a row of party flags + a place
  // tag, centred on the resolved point (the column is wider than its content so they centre).
  gatheringInner: { position: "absolute", left: -44, top: -18, width: 88, alignItems: "center" },
  gatheringBadge: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: "rgba(255,255,255,0.65)",
    alignItems: "center",
    justifyContent: "center",
  },
  partyRow: { flexDirection: "row", marginTop: 3, gap: 2 },
  partyFlag: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.55)",
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  partyFlagImg: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
  partyCode: { color: "#fff", fontSize: 7, fontWeight: "800" },
  gatheringTag: {
    color: colors.text,
    fontSize: font.tiny,
    fontWeight: "700",
    marginTop: 2,
    textShadowColor: "rgba(0,0,0,0.85)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  gatheringParties: { color: colors.textDim, fontSize: font.tiny, marginTop: 2 },
  // CONNECTIONS / GATHERINGS legend block (sits under the category lenses): the kind chips,
  // each a toggle lens that hides/shows that kind on the globe.
  linkLegendWrap: { marginTop: spacing.xs, alignItems: "flex-end", gap: 4 },
  // Floating tooltip where the cursor meets a link line (route + kind over the story headline),
  // offset down-right of the hit point so it doesn't sit under the cursor.
  linkTip: {
    position: "absolute",
    maxWidth: 220,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface + "F5",
    transform: [{ translateX: 12 }, { translateY: 12 }],
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
  // Zero-size anchor pinned to a marker's projected point (transform written imperatively).
  markerAnchor: { position: "absolute", left: 0, top: 0 },
  // The FOCUSED marker's anchor lifts above every sibling chip AND the dismiss backdrop —
  // each anchor's transform is its own stacking context, so the card needs the anchor (not
  // just an inner zIndex) to out-rank them. Keeps the card on top and its rows clickable.
  markerAnchorTop: { zIndex: 50 },
  // A centred column floating just ABOVE the anchor point (labels / bubbles / focused card).
  markerStack: {
    position: "absolute",
    bottom: 12,
    left: -110,
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
  // Aggregated-chip fan-out: a small heading + one tap-to-open row per collapsed story.
  markerCardCount: {
    color: colors.textDim,
    fontSize: font.tiny,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  // Scrollable list of collapsed stories — capped height so a busy country stays compact.
  markerCardScroll: { maxHeight: 240, alignSelf: "stretch" },
  markerCardScrollBody: { paddingRight: 2 },
  markerCardRow: {
    flexDirection: "row",
    alignItems: "flex-start", // headlines wrap to full text → keep dot/icon by the first line
    gap: spacing.sm,
    paddingVertical: 7,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  markerCardRowText: { flex: 1, color: colors.text, fontSize: font.small, lineHeight: 17 },
  // Per-row HEAT dot: colour ramps with the collapsed story's severity (heatColor).
  markerCardHeat: { width: 9, height: 9, borderRadius: 5, marginTop: 4 },
  markerCardRowOpen: { marginTop: 2 },
});
