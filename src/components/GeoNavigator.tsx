// Coverage-map drill-down navigator: walk the geographic tree (world → continent
// → country → region → province → locality) and SELECT a node as the active feed
// pool. Each node's outlets feed the pool and everything they report is shown.
//
// This is the functional, list-based form of the coverage map. The visual
// choropleth (bundled GeoJSON, tap-a-region) is a drop-in successor that reuses
// the very same /api/coverage data and the same onSelect contract — see the
// implementation notes in the project plan. Nodes are colored by coverage state
// here via a small badge, exactly as the map will color regions.

import React, { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { fetchCoverage, type CoverageNode, type CoverageState, type CoverageView } from "../lib/api";
import { geoNodeIdOf, GEO_ROOT_ID } from "../data/geo";
import { useT } from "../store/AppContext";
import { colors, font, radius, spacing } from "../theme";

/** Badge color per coverage state — the same palette the map will use. */
function stateColor(state: CoverageState): string {
  if (state === "ready") return colors.accent;
  if (state === "none") return colors.warn;
  return colors.textFaint; // unknown / not yet covered
}

export function GeoNavigator({
  activePoolId,
  home,
  onSelect,
  onSetHome,
}: {
  /** The currently-selected geo pool id (prefs.geoPool), if any. */
  activePoolId?: string;
  /** The reader's saved HOME node id (prefs.geoHome) — where the navigator opens
   *  by default when no pool is actively selected. Purely positional. */
  home?: string;
  /** Select a pool (a node's `poolId`), or pass undefined to leave geo mode. */
  onSelect: (poolId?: string) => void;
  /** Pin the given node id as the reader's home (the lightweight "picker"). */
  onSetHome?: (nodeId: string) => void;
}) {
  const t = useT();
  // "Where you are": an explicitly-selected pool wins; otherwise open at the saved
  // home node, else the world root. The server validates the node (the coverage
  // endpoint falls back to the root for unknown ids), so no client-side membership
  // check is needed against the data-driven tree.
  const currentNode =
    (activePoolId && geoNodeIdOf(activePoolId)) || home || GEO_ROOT_ID;
  // We browse from (and show the children of) the current node.
  const browseNode = currentNode;
  const [view, setView] = useState<CoverageView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    fetchCoverage(browseNode)
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
  }, [browseNode]);

  const stateLabel = (s: CoverageState): string =>
    s === "ready" ? t("geo.covered") : s === "none" ? t("geo.none") : t("geo.unknown");

  // Hide options with no coverage: keep nodes that have their own outlets
  // ("ready") or that can be drilled into (continents / covered descendants).
  // This trims the long data-driven country list down to places we can serve.
  const visibleChildren: CoverageNode[] = (view?.children ?? []).filter(
    (n) => n.state === "ready" || n.hasChildren,
  );

  const chip = (node: CoverageNode, active: boolean, key: string) => (
    <Pressable
      key={key}
      onPress={() => onSelect(node.poolId)}
      style={[styles.chip, active && styles.chipActive]}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={`${node.label} — ${stateLabel(node.state)}`}
    >
      {active ? (
        <Ionicons name="location" size={12} color={colors.bg} />
      ) : (
        <View style={[styles.dot, { backgroundColor: stateColor(node.state) }]} />
      )}
      <Text style={[styles.label, active && styles.labelActive]} numberOfLines={1}>
        {node.label}
      </Text>
      {node.hasChildren && (
        <Ionicons
          name="chevron-forward"
          size={12}
          color={active ? colors.bg : colors.textFaint}
        />
      )}
    </Pressable>
  );

  return (
    <View style={styles.wrap}>
      <View style={styles.header}>
        <Ionicons name="map-outline" size={14} color={colors.textDim} />
        <Text style={styles.title}>{t("geo.title")}</Text>
        {/* Pin the current node as home (where the navigator opens by default). */}
        {onSetHome && currentNode !== GEO_ROOT_ID ? (
          <Pressable
            onPress={() => onSetHome(currentNode)}
            style={styles.exit}
            accessibilityRole="button"
            accessibilityLabel={t("geo.setHome")}
          >
            <Ionicons
              name={home === currentNode ? "home" : "home-outline"}
              size={12}
              color={home === currentNode ? colors.accent : colors.textDim}
            />
            <Text style={styles.exitText}>
              {home === currentNode ? t("geo.home") : t("geo.setHome")}
            </Text>
          </Pressable>
        ) : null}
        {activePoolId ? (
          <Pressable onPress={() => onSelect(undefined)} style={styles.exit} accessibilityRole="button">
            <Ionicons name="close" size={12} color={colors.textDim} />
            <Text style={styles.exitText}>{t("geo.exit")}</Text>
          </Pressable>
        ) : null}
      </View>

      {/* Breadcrumb: shows where you are (the deepest node is highlighted with a
          pin); tap any ancestor to jump back up (also selects it). */}
      {view && view.path.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
          {view.path.map((n) => chip(n, n.nodeId === currentNode, `p-${n.nodeId}`))}
        </ScrollView>
      )}

      {/* Children of the focused node — the drill-down options. */}
      {loading && (
        <View style={styles.statusRow}>
          <ActivityIndicator size="small" color={colors.accent} />
          <Text style={styles.statusText}>{t("geo.loading")}</Text>
        </View>
      )}
      {error && !loading && <Text style={styles.statusText}>{t("geo.error")}</Text>}
      {!loading && !error && view && visibleChildren.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
          {visibleChildren.map((n) => chip(n, n.nodeId === currentNode, `c-${n.nodeId}`))}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.xs },
  header: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  title: { color: colors.textDim, fontSize: font.small, fontWeight: "800", flex: 1 },
  exit: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
  },
  exitText: { color: colors.textDim, fontSize: font.tiny, fontWeight: "700" },
  row: { gap: spacing.sm, paddingVertical: spacing.xs, paddingRight: spacing.lg },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  dot: { width: 8, height: 8, borderRadius: 4 },
  label: { color: colors.textDim, fontSize: font.small, fontWeight: "700", maxWidth: 160 },
  labelActive: { color: colors.bg },
  statusRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs, paddingVertical: spacing.xs },
  statusText: { color: colors.textDim, fontSize: font.small },
});
