// Full-screen, ROUTE-BASED panel for a synthesized story / developing issue.
//
// History-aware (/story/[id]): source links open the in-app news reader
// (/news/[id]) and related stories push sibling /story/[id] routes. The timeline
// + left->right comparison are layered in once the server emits them; this screen
// already renders them when present and degrades cleanly when they're absent.

import React, { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { fetchStory } from "../../src/lib/api";
import { cacheStories, getCachedStories, getCachedStory } from "../../src/lib/storyCache";
import { goBack, openNews, openStory } from "../../src/lib/nav";
import { topicMeta } from "../../src/lib/topics";
import { leanColor } from "../../src/components/ui";
import { TypewriterParagraphs } from "../../src/components/anim";
import { useApp, useT } from "../../src/store/AppContext";
import { colors, font, radius, spacing } from "../../src/theme";
import type { Lean, Story, StorySpectrum } from "../../src/types";

const READ_WIDTH = 760;

/** The three spectrum lanes, with their display label and color. */
const SPECTRUM_SIDES: ReadonlyArray<readonly [keyof StorySpectrum, string, string]> = [
  ["left", "Left", colors.left],
  ["center", "Center", colors.center],
  ["right", "Right", colors.right],
];

function leanLabel(lean: Lean): string {
  if (lean === null || Number.isNaN(lean as number)) return "non-political";
  const v = lean as number;
  if (v <= -0.6) return "left";
  if (v < -0.15) return "center-left";
  if (v <= 0.15) return "center";
  if (v < 0.6) return "center-right";
  return "right";
}

type T = (key: string, params?: Record<string, string | number>) => string;

function age(ms: number, t: T): string {
  const h = Math.max(0, Math.round((Date.now() - ms) / 3_600_000));
  if (h < 1) return t("time.now");
  if (h < 24) return t("time.hAgo", { n: h });
  return t("time.dAgo", { n: Math.round(h / 24) });
}

/** Date + time for a timeline milestone, e.g. "Jun 18, 14:05". */
function tlDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function StoryPanel() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const { worldId, prefs } = useApp();
  const t = useT();

  // Seed from the shared cache so a story opened from the feed renders INSTANTLY
  // (no /api/stories rebuild wait, and immune to ids that changed in a rebuild).
  const [story, setStory] = useState<Story | null>(() => (id ? getCachedStory(id) ?? null : null));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    const cached = getCachedStory(id);
    if (cached) {
      setStory(cached);
      setLoading(false);
      setError(null);
      return;
    }
    // Not cached (deep link, or opened after the list moved on): fetch just this
    // one story. This can still take a moment if the set needs (re)building, but
    // it resolves — no indefinite spinner — and 404s cleanly if it aged out.
    let cancelled = false;
    setStory(null);
    setLoading(true);
    setError(null);
    fetchStory(id, worldId, prefs.language)
      .then((s) => {
        if (cancelled) return;
        cacheStories([s]);
        setStory(s);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't load this story.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, worldId, prefs.language]);

  // Related stories resolve from whatever's cached (siblings loaded with it).
  const related = useMemo(() => {
    if (!story) return [];
    const pool = new Map(getCachedStories().map((s) => [s.id, s]));
    return story.relatedIds.map((rid) => pool.get(rid)).filter((s): s is Story => !!s);
  }, [story]);
  const m = story ? topicMeta(story.topic) : null;

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.topBar}>
        <Pressable onPress={goBack} hitSlop={10} style={styles.iconBtn} accessibilityRole="button">
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </Pressable>
        <View style={styles.synthTag}>
          <Ionicons name="git-merge-outline" size={12} color={colors.accent} />
          <Text style={styles.synthTagText}>{t("storyPanel.synthTag")}</Text>
        </View>
        <View style={{ flex: 1 }} />
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xxl }]}
        showsVerticalScrollIndicator={false}
      >
        {loading && !story && (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={colors.accent} />
            <Text style={styles.centerText}>{t("storyPanel.synthesizing")}</Text>
            <Text style={styles.centerHint}>{t("storyPanel.synthHint")}</Text>
          </View>
        )}

        {!loading && (error || !story) && (
          <View style={styles.center}>
            <Ionicons name="time-outline" size={28} color={colors.textDim} />
            <Text style={styles.centerText}>
              {error ?? t("storyPanel.aged")}
            </Text>
            <Pressable onPress={goBack} style={styles.backToFeedBtn} accessibilityRole="button">
              <Ionicons name="arrow-back" size={16} color={colors.bg} />
              <Text style={styles.backToFeedText}>{t("storyPanel.backToLatest")}</Text>
            </Pressable>
          </View>
        )}

        {!loading && story && m && (
          <>
            <View style={styles.pillRow}>
              <View style={[styles.topicPill, { backgroundColor: m.color + "22" }]}>
                <Ionicons name={m.icon} size={12} color={m.color} />
                <Text style={[styles.topicText, { color: m.color }]}>{t(`topic.${story.topic}`)}</Text>
              </View>
              {story.developing && (
                <View style={styles.developingPill}>
                  <Ionicons name="pulse" size={12} color={colors.warn} />
                  <Text style={styles.developingText}>{t("story.developing")}</Text>
                </View>
              )}
            </View>
            <Text style={styles.title}>{story.title}</Text>
            {!!story.summary && <Text style={styles.dek}>{story.summary}</Text>}
            <View style={styles.metaRow}>
              <Text style={styles.meta}>
                {t(story.sources.length === 1 ? "story.outletsOne" : "story.outlets", {
                  count: story.sources.length,
                })}
              </Text>
              <Text style={styles.dot}>·</Text>
              <Text style={styles.meta}>{age(story.updatedAt, t)}</Text>
              {story.lean !== null && (
                <>
                  <Text style={styles.dot}>·</Text>
                  <View style={[styles.leanChip, { borderColor: leanColor(story.lean) }]}>
                    <View style={[styles.leanDot, { backgroundColor: leanColor(story.lean) }]} />
                    <Text style={[styles.leanChipText, { color: leanColor(story.lean) }]}>
                      {t("storyPanel.overall", { lean: t(`olabel.${leanLabel(story.lean)}`) })}
                    </Text>
                  </View>
                </>
              )}
            </View>

            <TypewriterParagraphs paragraphs={story.synthesis} cps={320} style={styles.paragraph} />

            {story.timeline && story.timeline.length > 0 && (
              <View style={styles.section}>
                <SectionHeader icon="time-outline" label={t("storyPanel.timeline")} />
                {story.timeline.map((mst, i) => (
                  <Pressable
                    key={i}
                    style={styles.tlRow}
                    onPress={() => mst.sourceIds[0] && openNews(mst.sourceIds[0])}
                    accessibilityRole="button"
                    accessibilityLabel={`Read coverage from ${tlDate(mst.at)}`}
                  >
                    <View style={styles.tlRail}>
                      <View style={styles.tlDot} />
                      {i < story.timeline!.length - 1 && <View style={styles.tlLine} />}
                    </View>
                    <View style={styles.tlBody}>
                      <Text style={styles.tlDate}>{tlDate(mst.at)}</Text>
                      <Text style={styles.tlTitle}>{mst.title}</Text>
                      {!!mst.detail && mst.detail !== mst.title && (
                        <Text style={styles.tlDetail}>{mst.detail}</Text>
                      )}
                    </View>
                  </Pressable>
                ))}
              </View>
            )}

            {story.spectrum &&
              (story.spectrum.left || story.spectrum.center || story.spectrum.right) && (
                <View style={styles.section}>
                  <SectionHeader icon="swap-horizontal-outline" label={t("storyPanel.spectrum")} />
                  {SPECTRUM_SIDES.map(([key, , color]) =>
                    story.spectrum && story.spectrum[key] ? (
                      <View key={key} style={styles.spectrumRow}>
                        <View style={[styles.spectrumTag, { borderColor: color }]}>
                          <View style={[styles.leanDot, { backgroundColor: color }]} />
                          <Text style={[styles.spectrumLabel, { color }]}>{t(`spectrum.${key}`)}</Text>
                        </View>
                        <Text style={styles.spectrumText}>{story.spectrum[key]}</Text>
                      </View>
                    ) : null,
                  )}
                </View>
              )}

            {story.angles.length > 0 && (
              <View style={styles.section}>
                <SectionHeader icon="color-wand-outline" label={t("storyPanel.framed")} />
                {story.angles.map((a, i) => (
                  <View key={i} style={styles.angleRow}>
                    <View style={[styles.leanDot, { backgroundColor: leanColor(a.lean), marginTop: 5 }]} />
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.angleOutlet, { color: leanColor(a.lean) }]}>
                        {a.outlet}
                        <Text style={styles.angleLean}>  {t(`olabel.${leanLabel(a.lean)}`)}</Text>
                      </Text>
                      <Text style={styles.angleFraming}>{a.framing}</Text>
                    </View>
                  </View>
                ))}
              </View>
            )}

            {story.contradictions.length > 0 && (
              <View style={styles.section}>
                <SectionHeader icon="flash-outline" label={t("storyPanel.contradictions")} color={colors.warn} />
                {story.contradictions.map((c, i) => (
                  <View key={i} style={styles.bulletRow}>
                    <Text style={[styles.bullet, { color: colors.warn }]}>•</Text>
                    <Text style={styles.bulletText}>{c}</Text>
                  </View>
                ))}
              </View>
            )}

            <View style={styles.section}>
              <SectionHeader icon="link-outline" label={t("storyPanel.sources", { n: story.sources.length })} />
              {story.sources.map((s) => (
                <Pressable
                  key={s.id}
                  style={styles.sourceRow}
                  onPress={() => openNews(s.id)}
                  accessibilityRole="button"
                  accessibilityLabel={`Read ${s.sourceTitle} in app`}
                >
                  <View style={[styles.leanDot, { backgroundColor: leanColor(s.lean), marginTop: 5 }]} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.sourceOutlet}>{s.sourceTitle}</Text>
                    <Text style={styles.sourceTitle} numberOfLines={2}>
                      {s.title}
                    </Text>
                  </View>
                  <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
                </Pressable>
              ))}
            </View>

            {related.length > 0 && (
              <View style={styles.section}>
                <SectionHeader icon="git-network-outline" label={t("storyPanel.related")} />
                {related.map((r) => (
                  <Pressable
                    key={r.id}
                    style={styles.relatedRow}
                    onPress={() => openStory(r.id)}
                    accessibilityRole="button"
                  >
                    <Ionicons name="chevron-forward" size={14} color={colors.accent} />
                    <Text style={styles.relatedText} numberOfLines={2}>
                      {r.title}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}

            <Text style={styles.disclaimer}>{t("storyPanel.disclaimer")}</Text>
          </>
        )}
      </ScrollView>
    </View>
  );
}

function SectionHeader({
  icon,
  label,
  color = colors.accent,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  color?: string;
}) {
  return (
    <View style={styles.sectionHeader}>
      <Ionicons name={icon} size={15} color={color} />
      <Text style={styles.sectionTitle}>{label}</Text>
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
  synthTag: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    backgroundColor: colors.accent + "1A",
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  synthTagText: { color: colors.accent, fontSize: font.tiny, fontWeight: "700" },
  content: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    width: "100%",
    maxWidth: READ_WIDTH,
    alignSelf: "center",
    gap: spacing.sm,
  },
  center: { alignItems: "center", gap: spacing.md, paddingVertical: spacing.xxl },
  centerText: { color: colors.text, fontSize: font.body, textAlign: "center", fontWeight: "600" },
  centerHint: { color: colors.textDim, fontSize: font.small, textAlign: "center", lineHeight: font.small * 1.5, maxWidth: 360 },
  backToFeedBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    marginTop: spacing.sm,
  },
  backToFeedText: { color: colors.bg, fontSize: font.body, fontWeight: "700" },
  topicPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    alignSelf: "flex-start",
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  topicText: { fontSize: font.tiny, fontWeight: "700" },
  pillRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" },
  developingPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: colors.warn + "22",
    borderWidth: 1,
    borderColor: colors.warn + "66",
  },
  developingText: { color: colors.warn, fontSize: font.tiny, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.4 },
  tlRow: { flexDirection: "row", gap: spacing.md },
  tlRail: { width: 14, alignItems: "center" },
  tlDot: { width: 11, height: 11, borderRadius: 6, backgroundColor: colors.accent, marginTop: 3 },
  tlLine: { flex: 1, width: 2, backgroundColor: colors.border, marginTop: 2 },
  tlBody: { flex: 1, paddingBottom: spacing.md },
  tlDate: { color: colors.accent, fontSize: font.tiny, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.4 },
  tlTitle: { color: colors.text, fontSize: font.small, fontWeight: "700", marginTop: 1 },
  tlDetail: { color: colors.textDim, fontSize: font.small, lineHeight: font.small * 1.45, marginTop: 1 },
  spectrumRow: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm },
  spectrumTag: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    minWidth: 76,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  spectrumLabel: { fontSize: font.tiny, fontWeight: "800" },
  spectrumText: { flex: 1, color: colors.textDim, fontSize: font.small, lineHeight: font.small * 1.45 },
  title: { color: colors.text, fontSize: font.h1, fontWeight: "800", lineHeight: font.h1 * 1.22 },
  dek: { color: colors.textDim, fontSize: font.h3, lineHeight: font.h3 * 1.4 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginBottom: spacing.sm, flexWrap: "wrap" },
  meta: { color: colors.textDim, fontSize: font.small },
  dot: { color: colors.textFaint },
  leanChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  leanChipText: { fontSize: font.tiny, fontWeight: "700" },
  leanDot: { width: 9, height: 9, borderRadius: 5 },
  paragraph: { color: colors.text, fontSize: font.h3, lineHeight: font.h3 * 1.6, marginBottom: spacing.sm },
  section: {
    marginTop: spacing.lg,
    gap: spacing.sm,
    borderTopColor: colors.border,
    borderTopWidth: 1,
    paddingTop: spacing.lg,
  },
  sectionHeader: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  sectionTitle: { color: colors.text, fontSize: font.body, fontWeight: "800" },
  angleRow: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm },
  angleOutlet: { fontSize: font.small, fontWeight: "800" },
  angleLean: { color: colors.textFaint, fontSize: font.tiny, fontWeight: "600", fontStyle: "italic" },
  angleFraming: { color: colors.textDim, fontSize: font.small, lineHeight: font.small * 1.45, marginTop: 1 },
  bulletRow: { flexDirection: "row", gap: spacing.sm },
  bullet: { fontSize: font.body, fontWeight: "800", lineHeight: font.small * 1.5 },
  bulletText: { flex: 1, color: colors.textDim, fontSize: font.small, lineHeight: font.small * 1.5 },
  sourceRow: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm, paddingVertical: spacing.xs },
  sourceOutlet: { color: colors.text, fontSize: font.small, fontWeight: "700" },
  sourceTitle: { color: colors.textDim, fontSize: font.small, lineHeight: font.small * 1.4, marginTop: 1 },
  relatedRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs, paddingVertical: spacing.xs },
  relatedText: { flex: 1, color: colors.accent, fontSize: font.small, fontWeight: "600" },
  disclaimer: { color: colors.textFaint, fontSize: font.tiny, fontStyle: "italic", marginTop: spacing.lg },
});
