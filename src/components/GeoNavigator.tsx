// Coverage drill-down navigator: BROWSE the geographic tree (continent → country
// → region) and SELECT a covered place as the active feed pool. Each selected
// node's outlets feed the pool and everything they report is shown.
//
// Two concerns are kept SEPARATE: the browse cursor (where you're looking) and
// the committed pool (`activePoolId`). Browsing never changes the feed; only
// tapping a covered place commits it, and the explicit "Leave" button is the one
// way back to the topical feed. The list form shares the /api/coverage data and
// the onSelect contract with the visual choropleth successor.

import React, { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { fetchCoverage, type CoverageNode, type CoverageView } from "../lib/api";
import { geoNodeIdOf, GEO_ROOT_ID } from "../data/geo";
import { useT } from "../store/AppContext";
import { colors, font, radius, spacing } from "../theme";

export function GeoNavigator({
  activePoolId,
  home,
  onSelect,
  onSelectWorld,
  worldActive,
  onSetHome,
}: {
  /** The currently-selected geo pool id (prefs.geoPool), if any. */
  activePoolId?: string;
  /** The reader's saved HOME node id (prefs.geoHome) — where the navigator opens
   *  by default when no pool is actively selected. Purely positional. */
  home?: string;
  /** Select a pool (a node's `poolId`), or pass undefined to leave geo mode. */
  onSelect: (poolId?: string) => void;
  /** Commit the international Front Page — the "World" level of the hierarchy. */
  onSelectWorld?: () => void;
  /** True when the international Front Page is the live feed (no geographic
   *  override), so the World chip can render as selected. */
  worldActive?: boolean;
  /** Pin the given node id as the reader's home (the lightweight "picker"). */
  onSetHome?: (nodeId: string) => void;
}) {
  const t = useT();
  // The geographic BROWSE cursor — the node whose children we're showing. It is
  // SEPARATE from the committed feed pool (`activePoolId`): browsing the tree
  // never changes the feed; only tapping a covered place (or pressing Leave) does.
  // Opens at the active pool's node, else the saved home, else the continent list.
  const [browse, setBrowse] = useState<string>(
    (activePoolId && geoNodeIdOf(activePoolId)) || home || GEO_ROOT_ID,
  );
  const [view, setView] = useState<CoverageView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  // Follow an externally-committed pool (e.g. one selected on the other tab) so
  // the cursor opens where the feed actually is.
  useEffect(() => {
    const n = activePoolId && geoNodeIdOf(activePoolId);
    if (n) setBrowse(n);
  }, [activePoolId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
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

  // Tap a place: always move the cursor there (so the UI reacts immediately);
  // commit it as the feed pool ONLY when it has its own outlets. Continents and
  // other uncovered nodes just drill in.
  const go = (node: CoverageNode) => {
    setBrowse(node.nodeId);
    if (node.state === "ready") onSelect(node.poolId);
  };

  // The breadcrumb is purely geographic — the World root is intentionally omitted
  // (leaving geo mode is the explicit "Leave" button only).
  const crumbs: CoverageNode[] = (view?.path ?? []).filter((n) => n.nodeId !== GEO_ROOT_ID);

  // Hide options with no coverage: keep covered places and anything drillable.
  const visibleChildren: CoverageNode[] = (view?.children ?? []).filter(
    (n) => n.state === "ready" || n.hasChildren,
  );

  // At the root, the "World" level is offered as the international Front Page (a
  // TOPICAL, not geographic, pool) — a leading chip ahead of the continent list.
  const worldChipVisible = browse === GEO_ROOT_ID && !!onSelectWorld;

  const chip = (node: CoverageNode, showChevron: boolean) => {
    const active = !!activePoolId && node.poolId === activePoolId;
    return (
      <Pressable
        key={node.nodeId}
        onPress={() => go(node)}
        style={[styles.chip, active && styles.chipActive]}
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
        accessibilityLabel={node.label}
      >
        {active && <Ionicons name="location" size={12} color={colors.bg} />}
        <Text style={[styles.label, active && styles.labelActive]} numberOfLines={1}>
          {node.label}
        </Text>
        {showChevron && node.hasChildren && (
          <Ionicons
            name="chevron-forward"
            size={12}
            color={active ? colors.bg : colors.textFaint}
          />
        )}
      </Pressable>
    );
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.header}>
        <Ionicons name="map-outline" size={14} color={colors.textDim} />
        <Text style={styles.title}>{t("geo.title")}</Text>
        {/* Pin the current place as home (where the navigator opens by default). */}
        {onSetHome && browse !== GEO_ROOT_ID ? (
          <Pressable
            onPress={() => onSetHome(browse)}
            style={styles.exit}
            accessibilityRole="button"
            accessibilityLabel={t("geo.setHome")}
          >
            <Ionicons
              name={home === browse ? "home" : "home-outline"}
              size={12}
              color={home === browse ? colors.accent : colors.textDim}
            />
            <Text style={styles.exitText}>
              {home === browse ? t("geo.home") : t("geo.setHome")}
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

      {/* Breadcrumb (no World root). A leading globe button pops back up to the
          full continent list — pure navigation that never changes the feed. */}
      {(browse !== GEO_ROOT_ID || crumbs.length > 0) && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
          {browse !== GEO_ROOT_ID && (
            <Pressable
              onPress={() => setBrowse(GEO_ROOT_ID)}
              style={styles.chip}
              accessibilityRole="button"
              accessibilityLabel={t("geo.allRegions")}
            >
              <Ionicons name="earth" size={13} color={colors.textDim} />
            </Pressable>
          )}
          {crumbs.map((n) => chip(n, false))}
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
      {!loading && !error && view && (worldChipVisible || visibleChildren.length > 0) && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
          {worldChipVisible && (
            <Pressable
              key="__world__"
              onPress={() => {
                setBrowse(GEO_ROOT_ID);
                onSelectWorld?.();
              }}
              style={[styles.chip, worldActive && styles.chipActive]}
              accessibilityRole="button"
              accessibilityState={{ selected: !!worldActive }}
              accessibilityLabel={t("geo.world")}
            >
              <Ionicons name="earth" size={12} color={worldActive ? colors.bg : colors.textDim} />
              <Text style={[styles.label, worldActive && styles.labelActive]} numberOfLines={1}>
                {t("geo.world")}
              </Text>
            </Pressable>
          )}
          {visibleChildren.map((n) => chip(n, true))}
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
  label: { color: colors.textDim, fontSize: font.small, fontWeight: "700", maxWidth: 160 },
  labelActive: { color: colors.bg },
  statusRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs, paddingVertical: spacing.xs },
  statusText: { color: colors.textDim, fontSize: font.small },
});
