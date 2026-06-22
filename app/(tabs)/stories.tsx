import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useApp } from "../../src/store/AppContext";
import { fetchStories } from "../../src/lib/api";
import { StoryCard } from "../../src/components/StoryCard";
import { lastMinuteStories } from "../../src/lib/storyUpdates";
import { GeoNavigator } from "../../src/components/GeoNavigator";
import { GEO_ROOT_ID, geoLabel, geoNodeIdOf, poolIdForNode } from "../../src/data/geo";
import { openStory } from "../../src/lib/nav";
import { AnalysisProgress } from "../../src/components/AnalysisProgress";
import { colors, font, radius, spacing } from "../../src/theme";
import type { Story } from "../../src/types";

const MAX_CONTENT_WIDTH = 1180;
const H_PAD = spacing.lg;

function columnsFor(contentWidth: number): number {
  if (contentWidth >= 1040) return 3;
  if (contentWidth >= 680) return 2;
  return 1;
}

export default function StoriesScreen() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { prefs, feedWorldId, updatePrefs, status, storyViews } = useApp();

  const [stories, setStories] = useState<Story[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // The world the reader is currently viewing. A fetch is only applied if this
  // STILL matches when it resolves — an in-flight request for the world we just
  // switched away from must not overwrite the current world's stories (which
  // would surface foreign stories in "Last minute").
  const currentWorldRef = useRef(feedWorldId);
  currentWorldRef.current = feedWorldId;
  const load = useCallback(
    async (force = false) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetchStories({ world: feedWorldId, force });
        if (currentWorldRef.current !== feedWorldId) return;
        setStories(res.stories);
        setBusy(res.busyWith ?? null);
        if (res.stories.length === 0 && !res.busyWith) {
          setError(
            "No multi-source stories yet. Once the backend has analyzed enough overlapping " +
              "coverage, synthesized stories will appear here.",
          );
        }
      } catch (e) {
        if (currentWorldRef.current === feedWorldId) {
          setError(e instanceof Error ? e.message : "Failed to load stories.");
        }
      } finally {
        if (currentWorldRef.current === feedWorldId) setLoading(false);
      }
    },
    [feedWorldId],
  );

  // Load on mount and whenever the world changes.
  useEffect(() => {
    setStories([]);
    void load();
  }, [load]);

  const contentW = Math.min(width, MAX_CONTENT_WIDTH) - H_PAD * 2;
  const cols = columnsFor(contentW);
  const GAP = spacing.lg;
  const cardW = cols === 1 ? contentW : Math.floor((contentW - GAP * (cols - 1)) / cols);

  // Stories that gained new coverage since the reader last opened them.
  const lastMinute = useMemo(
    () => lastMinuteStories(stories, storyViews),
    [stories, storyViews],
  );

  return (
      <ScrollView
        style={{ flex: 1, backgroundColor: colors.bg }}
        contentContainerStyle={{
          paddingTop: insets.top + spacing.md,
          paddingBottom: spacing.xxl,
          paddingHorizontal: H_PAD,
          alignItems: "center",
        }}
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={() => load(true)} tintColor={colors.accent} />
        }
      >
        <View style={{ width: contentW, gap: spacing.md }}>
          <GeoNavigator
            activePoolId={prefs.geoPool}
            home={prefs.geoHome}
            onSelect={(poolId) => {
              const next = !poolId || poolId === poolIdForNode(GEO_ROOT_ID) ? undefined : poolId;
              if (next !== prefs.geoPool) void updatePrefs({ geoPool: next });
            }}
            onSetHome={(nodeId) => void updatePrefs({ geoHome: nodeId })}
          />

          <View style={styles.headerRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>Stories</Text>
              <Text style={styles.subtitle}>
                One neutral synthesis per event — deduped across outlets, with each side's framing.
              </Text>
            </View>
            <Pressable
              onPress={() => load(true)}
              style={styles.refreshBtn}
              accessibilityRole="button"
              disabled={loading}
            >
              <Ionicons name="refresh" size={16} color={loading ? colors.textFaint : colors.accent} />
              <Text style={[styles.refreshText, loading && { color: colors.textFaint }]}>Refresh</Text>
            </Pressable>
          </View>

          <AnalysisProgress status={status} />

          {busy && busy !== feedWorldId && stories.length === 0 && (
            <View style={styles.busyBanner}>
              <ActivityIndicator size="small" color={colors.warn} />
              <Text style={styles.busyText}>
                “{geoLabel(geoNodeIdOf(busy)) || "Another area"}” is still refreshing. Only one
                refreshes at a time — stories here will build once it’s free.
              </Text>
            </View>
          )}

          {error && stories.length === 0 && (
            <View style={styles.errorBanner}>
              <Ionicons name="information-circle-outline" size={16} color={colors.textDim} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          {lastMinute.length > 0 && (
            <View style={{ gap: spacing.md }}>
              <View style={styles.lastMinHeader}>
                <View style={styles.lastMinIcon}>
                  <Ionicons name="flash" size={15} color={colors.accent} />
                </View>
                <Text style={styles.lastMinTitle}>Last minute</Text>
                <Text style={styles.lastMinCount}>{lastMinute.length}</Text>
              </View>
              <Text style={styles.lastMinSub}>
                Stories that moved on since you last opened them.
              </Text>
              <View style={[styles.grid, { gap: GAP }]}>
                {lastMinute.map((s) => (
                  <View key={`lm-${s.id}`} style={{ width: cardW }}>
                    <StoryCard story={s} onOpen={(st) => openStory(st.id)} />
                  </View>
                ))}
              </View>
            </View>
          )}

          {stories.length === 0 ? (
            loading ? (
              <View style={styles.empty}>
                <ActivityIndicator color={colors.accent} />
                <Text style={styles.emptySub}>
                  Clustering coverage and synthesizing stories… the first build can take a moment.
                </Text>
              </View>
            ) : null
          ) : (
            <View style={[styles.grid, { gap: GAP }]}>
              {stories.map((s) => (
                <View key={s.id} style={{ width: cardW }}>
                  <StoryCard story={s} onOpen={(st) => openStory(st.id)} />
                </View>
              ))}
            </View>
          )}
        </View>
      </ScrollView>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md },
  title: { color: colors.text, fontSize: font.h1, fontWeight: "800" },
  subtitle: { color: colors.textDim, fontSize: font.small, marginTop: 2, lineHeight: font.small * 1.4 },
  refreshBtn: {
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
  refreshText: { color: colors.accent, fontSize: font.small, fontWeight: "700" },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  lastMinHeader: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  lastMinIcon: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.accent + "22",
  },
  lastMinTitle: { color: colors.text, fontSize: font.h3, fontWeight: "800" },
  lastMinCount: { color: colors.accent, fontSize: font.small, fontWeight: "800" },
  lastMinSub: { color: colors.textDim, fontSize: font.small, marginTop: -spacing.xs },
  busyBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.warn + "55",
    backgroundColor: colors.warn + "14",
  },
  busyText: { color: colors.textDim, fontSize: font.small, flex: 1, lineHeight: 18 },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  errorText: { color: colors.textDim, fontSize: font.small, flex: 1, lineHeight: 18 },
  empty: { padding: spacing.xl, alignItems: "center", gap: spacing.sm, marginTop: spacing.xl },
  emptySub: { color: colors.textDim, fontSize: font.small, textAlign: "center", lineHeight: font.small * 1.5 },
});
