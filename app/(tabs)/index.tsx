import React, { useMemo } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useApp } from "../../src/store/AppContext";
import { assessDrift } from "../../src/lib/lean";
import { FeedCard } from "../../src/components/FeedCard";
import { LeanDial, QuotaMeter } from "../../src/components/meters";
import { colors, font, radius, spacing } from "../../src/theme";

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
          <View>
            <Text style={styles.title}>Today</Text>
            {feed.length > 0 && (
              <Text style={styles.subtitle}>{feed.length} picks chosen to keep you balanced</Text>
            )}
          </View>
          <QuotaMeter consumed={progress.consumedMin} target={prefs.dailyQuotaMin} />
          <LeanDial drift={todayDrift} threshold={prefs.driftThreshold} compact />
          {feedError && (
            <View style={styles.errorBanner}>
              <Ionicons name="cloud-offline-outline" size={16} color={colors.danger} />
              <Text style={styles.errorText}>{feedError}</Text>
              <Pressable onPress={refreshFeed} hitSlop={8}>
                <Text style={styles.retry}>Retry</Text>
              </Pressable>
            </View>
          )}
        </View>
      }
      renderItem={({ item }) => (
        <FeedCard item={item} done={completedSet.has(item.id)} onComplete={completeItem} />
      )}
      ListEmptyComponent={
        loadingFeed ? (
          <View style={styles.empty}>
            <ActivityIndicator color={colors.accent} />
            <Text style={styles.emptySub}>Curating your balanced feed…</Text>
          </View>
        ) : feedError ? null : (
          <View style={styles.empty}>
            <Ionicons
              name={
                progress.consumedMin >= prefs.dailyQuotaMin
                  ? "checkmark-done-circle-outline"
                  : "newspaper-outline"
              }
              size={40}
              color={colors.textFaint}
            />
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
        )
      }
    />
  );
}

const styles = StyleSheet.create({
  title: { color: colors.text, fontSize: font.h1, fontWeight: "800" },
  subtitle: { color: colors.textDim, fontSize: font.small, marginTop: 2 },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.danger,
    backgroundColor: colors.surface,
  },
  errorText: { color: colors.textDim, fontSize: font.small, flex: 1, lineHeight: 18 },
  retry: { color: colors.accent, fontSize: font.small, fontWeight: "700" },
  empty: { padding: spacing.xl, alignItems: "center", gap: spacing.sm, marginTop: spacing.xl },
  emptyTitle: { color: colors.text, fontSize: font.h3, fontWeight: "700", textAlign: "center" },
  emptySub: { color: colors.textDim, fontSize: font.small, textAlign: "center" },
});
