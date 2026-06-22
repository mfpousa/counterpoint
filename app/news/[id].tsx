// Full-screen, ROUTE-BASED in-app reader for a single news item.
//
// This replaces the old state-driven ArticleReader modal so the browser's
// virtual history works: each opened article is a real /news/[id] URL you can
// back/forward through and deep-link to. Shows the AI rewrite, the recall-summary
// gate, and a "Related news" rail that pushes further /news/[id] routes for a
// continuous, stay-in-app reading flow.

import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { fetchRelated, fetchRewrite, streamRewrite } from "../../src/lib/api";
import { goBack, openNews } from "../../src/lib/nav";
import { Cursor } from "../../src/components/anim";
import { SummaryModal } from "../../src/components/SummaryModal";
import { topicMeta } from "../../src/lib/topics";
import { LeanBadge } from "../../src/components/ui";
import { useApp, useT } from "../../src/store/AppContext";
import { colors, font, radius, spacing } from "../../src/theme";
import type { FeedItem, RewrittenArticle } from "../../src/types";

const READ_WIDTH = 720;

export default function NewsReader() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  // Use the EFFECTIVE pool id (feedWorldId), not the topical worldId: an item
  // opened from a GEO pool (coverage map) or REGIONAL pool is stored under that
  // pool, so the rewrite/related lookups must target it or they 404 ("item not
  // found"). worldId (topical) would miss those pools entirely.
  const { pool, feedWorldId, prefs, summaries, gradeAndRecord, progress } = useApp();
  const t = useT();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [article, setArticle] = useState<RewrittenArticle | null>(null);
  const [streamed, setStreamed] = useState("");
  const [thinking, setThinking] = useState("");
  const [related, setRelated] = useState<FeedItem[]>([]);
  const [grading, setGrading] = useState(false);

  // The pool item (if still loaded) backs the recall/grade flow + meta.
  const poolItem = pool.find((it) => it.id === id) ?? null;
  const summary = summaries.find((s) => s.id === id);
  const done = progress.completedItemIds.includes(id ?? "");

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setArticle(null);
    setStreamed("");
    setThinking("");
    setRelated([]);

    // Non-streaming fallback (streaming unsupported here, or it errored).
    const plain = () => {
      fetchRewrite(id, prefs.language, feedWorldId)
        .then((a) => {
          if (!cancelled) setArticle(a);
        })
        .catch((e: unknown) => {
          if (!cancelled) setError(e instanceof Error ? e.message : t("reader.couldntLoad"));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };

    // Stream the rewrite so the reader shows the model writing in real time.
    const handle = streamRewrite(id, {
      world: feedWorldId,
      lang: prefs.language,
      onDelta: (d) => {
        if (!cancelled) setStreamed((p) => p + d);
      },
      onReasoning: (d) => {
        // Keep a short rolling preview of the model's reasoning.
        if (!cancelled) setThinking((p) => (p + d).slice(-400));
      },
      onDone: (a) => {
        if (!cancelled) {
          setArticle(a);
          setLoading(false);
        }
      },
      onError: () => {
        if (!cancelled) plain();
      },
    });
    if (!handle) plain();

    fetchRelated(id, { world: feedWorldId }).then((r) => {
      if (!cancelled) setRelated(r);
    });
    return () => {
      cancelled = true;
      handle?.cancel();
    };
  }, [id, feedWorldId, prefs.language]);

  // Paragraphs to show WHILE streaming (before the final cleaned article lands).
  const streamingParas = streamed
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const open = article ? () => void Linking.openURL(article.url) : undefined;

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.topBar}>
        <Pressable onPress={goBack} hitSlop={10} style={styles.iconBtn} accessibilityRole="button">
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </Pressable>
        <View style={styles.aiTag}>
          <Ionicons name="sparkles" size={12} color={colors.accent} />
          <Text style={styles.aiTagText}>AI rewrite</Text>
        </View>
        <View style={{ flex: 1 }} />
        {open && (
          <Pressable onPress={open} hitSlop={10} style={styles.iconBtn} accessibilityRole="link">
            <Ionicons name="open-outline" size={20} color={colors.textDim} />
          </Pressable>
        )}
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xxl }]}
        showsVerticalScrollIndicator={false}
      >
        {loading && !streamed && !article && (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={colors.accent} />
            <Text style={styles.centerText}>
              {thinking ? t("reader.thinking") : t("reader.reading")}
            </Text>
            {!!thinking && (
              <Text style={styles.thinkingPreview} numberOfLines={3}>
                {thinking}
              </Text>
            )}
          </View>
        )}

        {!article && error && (
          <View style={styles.center}>
            <Ionicons name="alert-circle-outline" size={28} color={colors.danger} />
            <Text style={styles.errorText}>{error}</Text>
            {open && (
              <Pressable onPress={open} style={styles.primaryBtn} accessibilityRole="link">
                <Ionicons name="open-outline" size={16} color={colors.bg} />
                <Text style={styles.primaryBtnText}>{t("reader.openOriginal")}</Text>
              </Pressable>
            )}
          </View>
        )}

        {/* Live: the model's prose as it streams in, with a blinking cursor. */}
        {!article && !error && streamingParas.length > 0 && (
          <View>
            <View style={styles.writingRow}>
              <Ionicons name="sparkles" size={14} color={colors.accent} />
              <Text style={styles.writingText}>{t("reader.writing")}</Text>
            </View>
            {streamingParas.map((p, i) => (
              <Text key={i} style={styles.paragraph}>
                {p}
                {i === streamingParas.length - 1 ? <Cursor /> : null}
              </Text>
            ))}
          </View>
        )}

        {article && (
          <>
            <Text style={styles.title}>{article.title}</Text>
            <View style={styles.metaRow}>
              <Text style={styles.meta}>{article.sourceTitle}</Text>
              <Text style={styles.dot}>·</Text>
              <Text style={styles.meta}>{t("reader.minRead", { n: article.estMinutes })}</Text>
              {poolItem && (
                <>
                  <Text style={styles.dot}>·</Text>
                  <LeanBadge
                    lean={poolItem.lean}
                    source={poolItem.leanSource}
                    rationale={poolItem.leanRationale}
                  />
                </>
              )}
            </View>

            {article.degraded && (
              <View style={styles.degradedBanner}>
                <Ionicons name="information-circle-outline" size={16} color={colors.warn} />
                <Text style={styles.degradedText}>{t("reader.degraded")}</Text>
              </View>
            )}

            {article.paragraphs.map((p, i) => (
              <Text key={i} style={styles.paragraph}>
                {p}
              </Text>
            ))}

            {/* Recall / mark-read gate (only when the item is still in the pool). */}
            {poolItem && (
              <Pressable
                onPress={() => setGrading(true)}
                style={[styles.recallBtn, done && styles.recallBtnDone]}
                accessibilityRole="button"
              >
                <Ionicons
                  name={done ? "checkmark-circle" : "create-outline"}
                  size={18}
                  color={done ? colors.good : colors.accent}
                />
                <Text style={[styles.recallText, done && { color: colors.good }]}>
                  {summary
                    ? done
                      ? t("reader.readRevise")
                      : t("reader.reviseRecall")
                    : t("reader.summarizeToRead")}
                </Text>
              </Pressable>
            )}

            <Text style={styles.disclaimer}>
              {article.degraded ? t("reader.disclaimerDegraded") : t("reader.disclaimer")}
            </Text>

            {/* Related news rail — continuous in-app reading. */}
            {related.length > 0 && (
              <View style={styles.relatedSection}>
                <View style={styles.sectionHeader}>
                  <Ionicons name="git-network-outline" size={15} color={colors.accent} />
                  <Text style={styles.sectionTitle}>{t("reader.related")}</Text>
                </View>
                {related.map((r) => {
                  const m = topicMeta(r.topic);
                  return (
                    <Pressable
                      key={r.id}
                      style={styles.relatedRow}
                      onPress={() => openNews(r.id)}
                      accessibilityRole="button"
                    >
                      <View style={[styles.relatedDot, { backgroundColor: m.color }]} />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.relatedTitle} numberOfLines={2}>
                          {r.title}
                        </Text>
                        <Text style={styles.relatedMeta}>
                          {r.sourceTitle} · {m.label}
                        </Text>
                      </View>
                      <Ionicons name="chevron-forward" size={16} color={colors.textFaint} />
                    </Pressable>
                  );
                })}
              </View>
            )}
          </>
        )}
      </ScrollView>

      {/* Recall/grade gate stays a modal layered on the route. */}
      <SummaryModal
        item={grading ? poolItem : null}
        existing={summary}
        onGrade={gradeAndRecord}
        onClose={() => setGrading(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
  },
  iconBtn: { padding: spacing.xs },
  aiTag: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    backgroundColor: colors.accent + "1A",
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  aiTagText: { color: colors.accent, fontSize: font.tiny, fontWeight: "700" },
  content: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    width: "100%",
    maxWidth: READ_WIDTH,
    alignSelf: "center",
  },
  center: { alignItems: "center", gap: spacing.md, paddingVertical: spacing.xxl },
  centerText: { color: colors.textDim, fontSize: font.body, textAlign: "center" },
  thinkingPreview: {
    color: colors.textFaint,
    fontSize: font.small,
    fontStyle: "italic",
    textAlign: "center",
    lineHeight: font.small * 1.45,
    maxWidth: 460,
  },
  errorText: { color: colors.text, fontSize: font.body, textAlign: "center" },
  title: { color: colors.text, fontSize: font.h1, fontWeight: "800", lineHeight: font.h1 * 1.25 },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.sm,
    marginBottom: spacing.lg,
    flexWrap: "wrap",
  },
  meta: { color: colors.textDim, fontSize: font.small },
  dot: { color: colors.textFaint },
  paragraph: { color: colors.text, fontSize: font.h3, lineHeight: font.h3 * 1.6, marginBottom: spacing.lg },
  writingRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs, marginBottom: spacing.md },
  writingText: { color: colors.accent, fontSize: font.small, fontWeight: "700" },
  recallBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    borderColor: colors.accent,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    marginTop: spacing.sm,
  },
  recallBtnDone: { borderColor: colors.good },
  recallText: { color: colors.accent, fontSize: font.body, fontWeight: "700" },
  disclaimer: { color: colors.textFaint, fontSize: font.tiny, fontStyle: "italic", marginTop: spacing.md },
  relatedSection: {
    marginTop: spacing.xl,
    borderTopColor: colors.border,
    borderTopWidth: 1,
    paddingTop: spacing.lg,
    gap: spacing.sm,
  },
  sectionHeader: { flexDirection: "row", alignItems: "center", gap: spacing.xs, marginBottom: spacing.xs },
  sectionTitle: { color: colors.text, fontSize: font.body, fontWeight: "800" },
  relatedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
  },
  relatedDot: { width: 9, height: 9, borderRadius: 5 },
  relatedTitle: { color: colors.text, fontSize: font.small, fontWeight: "700", lineHeight: font.small * 1.4 },
  relatedMeta: { color: colors.textDim, fontSize: font.tiny, marginTop: 2 },
  primaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    marginTop: spacing.sm,
  },
  primaryBtnText: { color: colors.bg, fontSize: font.body, fontWeight: "700" },
  degradedBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    backgroundColor: colors.warn + "1A",
    borderColor: colors.warn + "55",
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  degradedText: { flex: 1, color: colors.textDim, fontSize: font.small, lineHeight: font.small * 1.4 },
});
