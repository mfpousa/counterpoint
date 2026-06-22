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
  onSelect,
}: {
  /** The currently-selected geo pool id (prefs.geoPool), if any. */
  activePoolId?: string;
  /** Select a pool (a node's `poolId`), or pass undefined to leave geo mode. */
  onSelect: (poolId?: string) => void;
}) {
  const t = useT();
  // We browse from the active node (or the world root when none is selected).
  const browseNode = (activePoolId && geoNodeIdOf(activePoolId)) || GEO_ROOT_ID;
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

  const chip = (node: CoverageNode, active: boolean, key: string) => (
    <Pressable
      key={key}
      onPress={() => onSelect(node.poolId)}
      style={[styles.chip, active && styles.chipActive]}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={`${node.label} — ${stateLabel(node.state)}`}
    >
      <View style={[styles.dot, { backgroundColor: stateColor(node.state) }]} />
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
        {activePoolId ? (
          <Pressable onPress={() => onSelect(undefined)} style={styles.exit} accessibilityRole="button">
            <Ionicons name="close" size={12} color={colors.textDim} />
            <Text style={styles.exitText}>{t("geo.exit")}</Text>
          </Pressable>
        ) : null}
      </View>

      {/* Breadcrumb: tap any ancestor to jump back up (also selects it). */}
      {view && view.path.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
          {view.path.map((n, i) =>
            chip(n, !!activePoolId && n.poolId === activePoolId && i === view.path.length - 1, `p-${n.nodeId}`),
          )}
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
      {!loading && !error && view && view.children.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
          {view.children.map((n) => chip(n, n.poolId === activePoolId, `c-${n.nodeId}`))}
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
