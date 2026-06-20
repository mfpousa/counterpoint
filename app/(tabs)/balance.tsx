import React, { useMemo } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useApp, useTrailingWindow } from "../../src/store/AppContext";
import { assessDrift, windowDrift } from "../../src/lib/lean";
import { feedLeanBreakdown } from "../../src/lib/buildFeed";
import { LeanDial } from "../../src/components/meters";
import { leanColor } from "../../src/components/ui";
import { colors, font, radius, spacing } from "../../src/theme";
import type { Topic } from "../../src/types";

export default function BalanceScreen() {
  const insets = useSafeAreaInsets();
  const { feed, progress, prefs } = useApp();
  const windowPts = useTrailingWindow();

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

  const trailing = useMemo(
    () => windowDrift(windowPts, prefs.driftThreshold),
    [windowPts, prefs.driftThreshold],
  );

  const breakdown = useMemo(() => feedLeanBreakdown(feed), [feed]);

  // Topic spread of today's built feed.
  const topicMinutes = useMemo(() => {
    const map = new Map<Topic, number>();
    for (const it of feed) map.set(it.topic, (map.get(it.topic) ?? 0) + it.estMinutes);
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [feed]);
  const totalTopicMin = topicMinutes.reduce((a, [, m]) => a + m, 0) || 1;

  const polTotal = breakdown.leftMin + breakdown.rightMin + breakdown.centerMin || 1;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{
        padding: spacing.lg,
        paddingTop: insets.top + spacing.md,
        gap: spacing.lg,
        paddingBottom: spacing.xxl,
      }}
    >
      <Text style={styles.title}>Balance</Text>

      <LeanDial drift={todayDrift} threshold={prefs.driftThreshold} title="Today's perspective balance" />
      <LeanDial drift={trailing} threshold={prefs.driftThreshold} title="Last 30 days" />

      <View style={styles.card}>
        <Text style={styles.h}>Today's feed mix</Text>
        <Text style={styles.sub}>How the feed offered to balance you across the spectrum.</Text>
        <View style={styles.barRow}>
          <View style={[styles.barSeg, { flex: breakdown.leftMin, backgroundColor: leanColor(-0.7) }]} />
          <View style={[styles.barSeg, { flex: breakdown.centerMin, backgroundColor: leanColor(0) }]} />
          <View style={[styles.barSeg, { flex: breakdown.rightMin, backgroundColor: leanColor(0.7) }]} />
        </View>
        <View style={styles.legendRow}>
          <Text style={styles.legend}>Left {Math.round((breakdown.leftMin / polTotal) * 100)}%</Text>
          <Text style={styles.legend}>Center {Math.round((breakdown.centerMin / polTotal) * 100)}%</Text>
          <Text style={styles.legend}>Right {Math.round((breakdown.rightMin / polTotal) * 100)}%</Text>
        </View>
        <Text style={styles.sub}>
          Plus {breakdown.nonPoliticalMin} min of non-political learning (excluded from balance).
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.h}>Topic diversity (today's feed)</Text>
        {topicMinutes.length === 0 ? (
          <Text style={styles.sub}>No feed yet.</Text>
        ) : (
          topicMinutes.map(([topic, min]) => (
            <View key={topic} style={styles.topicRow}>
              <Text style={styles.topicLabel}>{topic}</Text>
              <View style={styles.topicTrack}>
                <View style={[styles.topicFill, { width: `${(min / totalTopicMin) * 100}%` }]} />
              </View>
              <Text style={styles.topicMin}>{min}m</Text>
            </View>
          ))
        )}
      </View>

      <Text style={styles.footnote}>
        Balance reflects what you've actually marked done — not just what was offered. Non-political
        content (science, history, tech) never counts toward left/right.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  title: { color: colors.text, fontSize: font.h1, fontWeight: "800" },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  h: { color: colors.text, fontSize: font.h3, fontWeight: "700" },
  sub: { color: colors.textDim, fontSize: font.small },
  barRow: { flexDirection: "row", height: 14, borderRadius: radius.pill, overflow: "hidden", marginVertical: spacing.xs },
  barSeg: { height: "100%" },
  legendRow: { flexDirection: "row", justifyContent: "space-between" },
  legend: { color: colors.textDim, fontSize: font.tiny, fontWeight: "600" },
  topicRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  topicLabel: { color: colors.textDim, fontSize: font.small, width: 84, textTransform: "capitalize" },
  topicTrack: { flex: 1, height: 8, backgroundColor: colors.surfaceAlt, borderRadius: radius.pill, overflow: "hidden" },
  topicFill: { height: "100%", backgroundColor: colors.accent, borderRadius: radius.pill },
  topicMin: { color: colors.textFaint, fontSize: font.tiny, width: 36, textAlign: "right" },
  footnote: { color: colors.textFaint, fontSize: font.tiny, lineHeight: 16 },
});
