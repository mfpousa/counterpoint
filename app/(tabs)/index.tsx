import React, { useMemo } from "react";
import { FlatList, RefreshControl, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useApp } from "../../src/store/AppContext";
import { assessDrift } from "../../src/lib/lean";
import { FeedCard } from "../../src/components/FeedCard";
import { LeanDial, QuotaMeter } from "../../src/components/meters";
import { colors, font, spacing } from "../../src/theme";

export default function FeedScreen() {
  const insets = useSafeAreaInsets();
  const { feed, progress, prefs, loadingFeed, feedError, completeItem, refreshFeed } = useApp();

  // Today's live drift, computed from the consumed tally.
  const todayDrift = useMemo(
    () =>
      assessDrift(
        progress.leanWeightSum,
        progress.leanMinutesSum,
        progress.leftMinutesSum,
        progress.rightMinutesSum,
        prefs.driftThreshold,
      ),
    [progress, prefs.driftThreshold],
  );

  const completedSet = new Set(progress.completedItemIds);

  return (
    <FlatList
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{
        padding: spacing.lg,
        paddingTop: insets.top + spacing.md,
        gap: spacing.md,
        paddingBottom: spacing.xxl,
      }}
      data={feed}
      keyExtractor={(it) => it.id}
      refreshControl={
        <RefreshControl refreshing={loadingFeed} onRefresh={refreshFeed} tintColor={colors.accent} />
      }
      ListHeaderComponent={
        <View style={{ gap: spacing.md, marginBottom: spacing.xs }}>
          <Text style={styles.title}>Today</Text>
          <QuotaMeter consumed={progress.consumedMin} target={prefs.dailyQuotaMin} />
          <LeanDial drift={todayDrift} threshold={prefs.driftThreshold} compact />
          {feedError && <Text style={styles.error}>{feedError}</Text>}
        </View>
      }
      renderItem={({ item }) => (
        <FeedCard item={item} done={completedSet.has(item.id)} onComplete={completeItem} />
      )}
      ListEmptyComponent={
        !loadingFeed ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>
              {progress.consumedMin >= prefs.dailyQuotaMin
                ? "You've hit today's quota."
                : "No items to show."}
            </Text>
            <Text style={styles.emptySub}>
              {progress.consumedMin >= prefs.dailyQuotaMin
                ? "Come back tomorrow, or raise your quota in Settings."
                : "Pull down to refresh, or broaden your topics in Settings."}
            </Text>
          </View>
        ) : null
      }
    />
  );
}

const styles = StyleSheet.create({
  title: { color: colors.text, fontSize: font.h1, fontWeight: "800" },
  error: { color: colors.danger, fontSize: font.small },
  empty: { padding: spacing.xl, alignItems: "center", gap: spacing.sm },
  emptyTitle: { color: colors.text, fontSize: font.h3, fontWeight: "700", textAlign: "center" },
  emptySub: { color: colors.textDim, fontSize: font.small, textAlign: "center" },
});
