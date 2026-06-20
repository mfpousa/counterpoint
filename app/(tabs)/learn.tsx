// The "Learn" tab: the reader's knowledge profile built from their graded recall
// summaries. Shows overall + per-topic mastery (computed locally), an AI
// narrative with gap-filling suggestions (hybrid: cheap single call), and the
// full history of graded summaries with their teaching feedback.

import React, { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useApp } from "../../src/store/AppContext";
import { fetchKnowledgeInsight } from "../../src/lib/api";
import { computeProfile, pickCandidates } from "../../src/lib/knowledge";
import { topicMeta } from "../../src/lib/topics";
import { GradeFeedback, ScorePill, scoreColor } from "../../src/components/GradeFeedback";
import { ArticleReader } from "../../src/components/ArticleReader";
import { SummaryModal } from "../../src/components/SummaryModal";
import { colors, font, radius, spacing } from "../../src/theme";
import type { FeedItem, KnowledgeInsight, StoredSummary } from "../../src/types";

export default function LearnScreen() {
  const insets = useSafeAreaInsets();
  const { summaries, pool, gradeAndRecord } = useApp();

  // In-app read -> summarize loop for gap-filling suggestions (the learning chain).
  const [readingItem, setReadingItem] = useState<FeedItem | null>(null);
  const [summarizingItem, setSummarizingItem] = useState<FeedItem | null>(null);

  const summaryById = useMemo(() => {
    const m = new Map<string, StoredSummary>();
    for (const s of summaries) m.set(s.id, s);
    return m;
  }, [summaries]);

  const profile = useMemo(() => computeProfile(summaries), [summaries]);
  const candidates = useMemo(
    () => pickCandidates(pool, profile, summaries),
    [pool, profile, summaries],
  );

  const [insight, setInsight] = useState<KnowledgeInsight | null>(null);
  const [loadingInsight, setLoadingInsight] = useState(false);

  // A signature that changes when the graded set OR the candidate pool changes,
  // so we don't re-call the model on every render — but DO re-fetch once the feed
  // pool loads (candidates were empty at first mount → no suggestions otherwise).
  const candidateKey = useMemo(
    () => candidates.map((c) => c.id).sort().join(","),
    [candidates],
  );
  const signature = useMemo(
    () => `${profile.totalGraded}:${profile.avgScore}:${profile.weakTopics.join(",")}:${candidateKey}`,
    [profile, candidateKey],
  );

  useEffect(() => {
    if (profile.totalGraded === 0) {
      setInsight(null);
      return;
    }
    let cancelled = false;
    setLoadingInsight(true);
    const candidatePayload = candidates.map((c) => ({
      id: c.id,
      title: c.title,
      topic: c.topic,
      summary: c.summary,
    }));
    fetchKnowledgeInsight(profile, candidatePayload)
      .then((res) => {
        if (!cancelled) setInsight(res);
      })
      .finally(() => {
        if (!cancelled) setLoadingInsight(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const poolById = useMemo(() => {
    const m = new Map(pool.map((p) => [p.id, p]));
    return m;
  }, [pool]);

  return (
    <>
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{
        paddingTop: insets.top + spacing.md,
        paddingBottom: spacing.xxl,
        paddingHorizontal: spacing.lg,
        gap: spacing.lg,
      }}
    >
      <View>
        <Text style={styles.title}>Learn</Text>
        <Text style={styles.subtitle}>
          What you've understood, where your gaps are, and what to read next.
        </Text>
      </View>

      {profile.totalGraded === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="school-outline" size={40} color={colors.textFaint} />
          <Text style={styles.emptyTitle}>No summaries yet</Text>
          <Text style={styles.emptySub}>
            On the Today tab, read an article then tap "Summarize to mark read". Your graded
            summaries build a knowledge profile here.
          </Text>
        </View>
      ) : (
        <>
          {/* Overview */}
          <View style={styles.card}>
            <View style={styles.overviewRow}>
              <View style={[styles.bigScore, { borderColor: scoreColor(profile.avgScore) }]}>
                <Text style={[styles.bigScoreNum, { color: scoreColor(profile.avgScore) }]}>
                  {profile.avgScore}
                </Text>
                <Text style={styles.bigScoreLabel}>avg</Text>
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={styles.overviewStat}>
                  {profile.totalGraded} {profile.totalGraded === 1 ? "summary" : "summaries"} graded
                </Text>
                <Text style={styles.overviewSub}>
                  across {profile.topics.length} topic{profile.topics.length === 1 ? "" : "s"}
                </Text>
              </View>
            </View>

            {/* Per-topic mastery bars */}
            <View style={{ gap: spacing.sm, marginTop: spacing.md }}>
              {profile.topics.map((t) => {
                const m = topicMeta(t.topic);
                return (
                  <View key={t.topic} style={styles.masteryRow}>
                    <View style={styles.masteryLabel}>
                      <Ionicons name={m.icon} size={13} color={m.color} />
                      <Text style={styles.masteryName}>{m.label}</Text>
                    </View>
                    <View style={styles.barTrack}>
                      <View
                        style={[
                          styles.barFill,
                          { width: `${t.avgScore}%`, backgroundColor: scoreColor(t.avgScore) },
                        ]}
                      />
                    </View>
                    <Text style={[styles.masteryScore, { color: scoreColor(t.avgScore) }]}>
                      {t.avgScore}
                    </Text>
                  </View>
                );
              })}
            </View>
          </View>

          {/* AI insight + gap-filling suggestions */}
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Ionicons name="sparkles" size={16} color={colors.accent} />
              <Text style={styles.cardTitle}>Your knowledge profile</Text>
            </View>
            {loadingInsight ? (
              <View style={styles.insightLoading}>
                <ActivityIndicator size="small" color={colors.accent} />
                <Text style={styles.emptySub}>Analyzing your gaps…</Text>
              </View>
            ) : insight ? (
              <>
                {!!insight.narrative && <Text style={styles.narrative}>{insight.narrative}</Text>}
                {profile.weakTopics.length > 0 && (
                  <View style={styles.gapChips}>
                    {profile.weakTopics.map((t) => {
                      const m = topicMeta(t);
                      return (
                        <View key={t} style={[styles.gapChip, { borderColor: m.color }]}>
                          <Ionicons name={m.icon} size={11} color={m.color} />
                          <Text style={[styles.gapChipText, { color: m.color }]}>{m.label}</Text>
                        </View>
                      );
                    })}
                  </View>
                )}
                {insight.suggestions.length > 0 && (
                  <View style={{ gap: spacing.sm, marginTop: spacing.sm }}>
                    <Text style={styles.suggestHeader}>Read these to fill the gaps</Text>
                    {insight.suggestions.map((s) => {
                      const it = poolById.get(s.id);
                      if (!it) return null;
                      const m = topicMeta(it.topic);
                      const existing = summaryById.get(it.id);
                      return (
                        <View key={s.id} style={styles.suggestion}>
                          <View style={styles.suggestTopRow}>
                            <View style={[styles.suggestTopic, { borderColor: m.color }]}>
                              <Ionicons name={m.icon} size={11} color={m.color} />
                              <Text style={[styles.suggestTopicText, { color: m.color }]}>{m.label}</Text>
                            </View>
                            {existing && <ScorePill score={existing.grade.score} size="sm" />}
                          </View>
                          <Text style={styles.suggestTitle} numberOfLines={3}>
                            {it.title}
                          </Text>
                          <View style={styles.suggestReasonRow}>
                            <Ionicons name="sparkles-outline" size={12} color={colors.accent} />
                            <Text style={styles.suggestReason}>{s.reason}</Text>
                          </View>
                          <View style={styles.suggestActions}>
                            <Pressable
                              onPress={() => setReadingItem(it)}
                              style={styles.suggestReadBtn}
                              accessibilityRole="button"
                            >
                              <Ionicons name="book-outline" size={15} color={colors.accent} />
                              <Text style={styles.suggestReadText}>Read in app</Text>
                            </Pressable>
                            <Pressable
                              onPress={() => setSummarizingItem(it)}
                              style={styles.suggestSummBtn}
                              accessibilityRole="button"
                            >
                              <Ionicons name="create-outline" size={15} color={colors.bg} />
                              <Text style={styles.suggestSummText}>
                                {existing ? "Revise" : "Summarize"}
                              </Text>
                            </Pressable>
                          </View>
                        </View>
                      );
                    })}
                  </View>
                )}
              </>
            ) : (
              <Text style={styles.emptySub}>
                Couldn't reach the model for insights. Your local stats above are still up to date.
              </Text>
            )}
          </View>

          {/* History */}
          <Text style={styles.sectionLabel}>Your summaries</Text>
          {summaries.map((s) => (
            <SummaryHistoryCard key={s.id} summary={s} />
          ))}
        </>
      )}
      </ScrollView>

      {/* Learning chain: read a suggested article, then prove recall — both in app. */}
      <ArticleReader item={readingItem} onClose={() => setReadingItem(null)} />
      <SummaryModal
        item={summarizingItem}
        existing={summarizingItem ? summaryById.get(summarizingItem.id) : undefined}
        onGrade={gradeAndRecord}
        onClose={() => setSummarizingItem(null)}
      />
    </>
  );
}

function SummaryHistoryCard({ summary }: { summary: StoredSummary }) {
  const [open, setOpen] = useState(false);
  const m = topicMeta(summary.topic);
  return (
    <View style={styles.card}>
      <Pressable style={styles.histHeader} onPress={() => setOpen((o) => !o)} accessibilityRole="button">
        <ScorePill score={summary.grade.score} size="sm" />
        <View style={{ flex: 1 }}>
          <Text style={styles.histTitle} numberOfLines={2}>
            {summary.title}
          </Text>
          <View style={styles.histMeta}>
            <Ionicons name={m.icon} size={11} color={m.color} />
            <Text style={[styles.histTopic, { color: m.color }]}>{m.label}</Text>
            <Text style={styles.histDot}>·</Text>
            <Text style={styles.histSource} numberOfLines={1}>
              {summary.sourceTitle}
            </Text>
          </View>
        </View>
        <Ionicons name={open ? "chevron-up" : "chevron-down"} size={18} color={colors.textDim} />
      </Pressable>
      {open && (
        <View style={{ gap: spacing.md, marginTop: spacing.md }}>
          <View style={styles.yourSummary}>
            <Text style={styles.yourSummaryLabel}>Your summary</Text>
            <Text style={styles.yourSummaryText}>{summary.summary}</Text>
          </View>
          <GradeFeedback grade={summary.grade} />
          <Pressable
            onPress={() => void Linking.openURL(summary.url)}
            style={styles.openLink}
            accessibilityRole="link"
          >
            <Ionicons name="open-outline" size={14} color={colors.accent} />
            <Text style={styles.openLinkText}>Open original</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  title: { color: colors.text, fontSize: font.h1, fontWeight: "800" },
  subtitle: { color: colors.textDim, fontSize: font.small, marginTop: 2, lineHeight: font.small * 1.4 },
  empty: { padding: spacing.xl, alignItems: "center", gap: spacing.sm, marginTop: spacing.xl },
  emptyTitle: { color: colors.text, fontSize: font.h3, fontWeight: "700", textAlign: "center" },
  emptySub: { color: colors.textDim, fontSize: font.small, textAlign: "center", lineHeight: font.small * 1.5 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },
  overviewRow: { flexDirection: "row", alignItems: "center", gap: spacing.lg },
  bigScore: {
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: 3,
    alignItems: "center",
    justifyContent: "center",
  },
  bigScoreNum: { fontSize: font.h2, fontWeight: "800" },
  bigScoreLabel: { color: colors.textFaint, fontSize: font.tiny, fontWeight: "700", textTransform: "uppercase" },
  overviewStat: { color: colors.text, fontSize: font.body, fontWeight: "700" },
  overviewSub: { color: colors.textDim, fontSize: font.small },
  masteryRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  masteryLabel: { flexDirection: "row", alignItems: "center", gap: spacing.xs, width: 110 },
  masteryName: { color: colors.textDim, fontSize: font.small, fontWeight: "600" },
  barTrack: { flex: 1, height: 8, borderRadius: 4, backgroundColor: colors.surfaceAlt, overflow: "hidden" },
  barFill: { height: "100%", borderRadius: 4 },
  masteryScore: { width: 28, textAlign: "right", fontSize: font.small, fontWeight: "800" },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: spacing.xs, marginBottom: spacing.sm },
  cardTitle: { color: colors.text, fontSize: font.h3, fontWeight: "800" },
  insightLoading: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: spacing.sm },
  narrative: { color: colors.text, fontSize: font.body, lineHeight: font.body * 1.5 },
  gapChips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs, marginTop: spacing.md },
  gapChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  gapChipText: { fontSize: font.tiny, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.3 },
  suggestHeader: {
    color: colors.textFaint,
    fontSize: font.tiny,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  suggestion: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  suggestTopRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  suggestTopic: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  suggestTopicText: { fontSize: font.tiny, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.3 },
  suggestTitle: { color: colors.text, fontSize: font.body, fontWeight: "700", lineHeight: font.body * 1.3 },
  suggestReasonRow: { flexDirection: "row", alignItems: "flex-start", gap: spacing.xs },
  suggestReason: { flex: 1, color: colors.textDim, fontSize: font.small, lineHeight: font.small * 1.5 },
  suggestActions: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: spacing.xs },
  suggestReadBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
    borderColor: colors.accent,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  suggestReadText: { color: colors.accent, fontSize: font.small, fontWeight: "700" },
  suggestSummBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  suggestSummText: { color: colors.bg, fontSize: font.small, fontWeight: "800" },
  sectionLabel: { color: colors.text, fontSize: font.h3, fontWeight: "800", marginTop: spacing.sm },
  histHeader: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  histTitle: { color: colors.text, fontSize: font.small, fontWeight: "700", lineHeight: font.small * 1.4 },
  histMeta: { flexDirection: "row", alignItems: "center", gap: spacing.xs, marginTop: 3 },
  histTopic: { fontSize: font.tiny, fontWeight: "700" },
  histDot: { color: colors.textFaint },
  histSource: { color: colors.textDim, fontSize: font.tiny, flexShrink: 1 },
  yourSummary: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  yourSummaryLabel: {
    color: colors.textFaint,
    fontSize: font.tiny,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  yourSummaryText: { color: colors.textDim, fontSize: font.small, lineHeight: font.small * 1.5, fontStyle: "italic" },
  openLink: { flexDirection: "row", alignItems: "center", gap: spacing.xs, alignSelf: "flex-start" },
  openLinkText: { color: colors.accent, fontSize: font.small, fontWeight: "700" },
});
