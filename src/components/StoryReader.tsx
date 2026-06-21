// Full-screen reader for a synthesized cross-source story: the neutral synthesis,
// a per-outlet framing breakdown, cross-outlet contradictions, the linked source
// articles, and related stories. Presentational — the parent owns selection so
// "related" navigation just swaps the displayed story.

import React from "react";
import { Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, font, radius, spacing } from "../theme";
import { topicMeta } from "../lib/topics";
import type { Lean, Story } from "../types";
import { leanColor } from "./ui";

function leanLabel(lean: Lean): string {
  if (lean === null || Number.isNaN(lean as number)) return "non-political";
  const v = lean as number;
  if (v <= -0.6) return "left";
  if (v < -0.15) return "center-left";
  if (v <= 0.15) return "center";
  if (v < 0.6) return "center-right";
  return "right";
}

function age(ms: number): string {
  const h = Math.max(0, Math.round((Date.now() - ms) / 3_600_000));
  if (h < 1) return "just now";
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function StoryReader({
  story,
  related,
  onOpenRelated,
  onClose,
}: {
  story: Story | null;
  related: Story[];
  onOpenRelated: (id: string) => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const m = story ? topicMeta(story.topic) : null;

  return (
    <Modal visible={!!story} animationType="slide" onRequestClose={onClose} transparent={false}>
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.topBar}>
          <Pressable onPress={onClose} hitSlop={10} style={styles.iconBtn} accessibilityRole="button">
            <Ionicons name="chevron-down" size={22} color={colors.text} />
          </Pressable>
          <View style={styles.synthTag}>
            <Ionicons name="git-merge-outline" size={12} color={colors.accent} />
            <Text style={styles.synthTagText}>Synthesis</Text>
          </View>
          <View style={{ flex: 1 }} />
        </View>

        {story && (
          <ScrollView
            contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xxl }]}
            showsVerticalScrollIndicator={false}
          >
            {m && (
              <View style={[styles.topicPill, { backgroundColor: m.color + "22" }]}>
                <Ionicons name={m.icon} size={12} color={m.color} />
                <Text style={[styles.topicText, { color: m.color }]}>{m.label}</Text>
              </View>
            )}
            <Text style={styles.title}>{story.title}</Text>
            {!!story.summary && <Text style={styles.dek}>{story.summary}</Text>}
            <View style={styles.metaRow}>
              <Text style={styles.meta}>
                {story.sources.length} outlet{story.sources.length === 1 ? "" : "s"}
              </Text>
              <Text style={styles.dot}>·</Text>
              <Text style={styles.meta}>{age(story.updatedAt)}</Text>
              {story.lean !== null && (
                <>
                  <Text style={styles.dot}>·</Text>
                  <View style={[styles.leanChip, { borderColor: leanColor(story.lean) }]}>
                    <View style={[styles.leanDot, { backgroundColor: leanColor(story.lean) }]} />
                    <Text style={[styles.leanChipText, { color: leanColor(story.lean) }]}>
                      {leanLabel(story.lean)} overall
                    </Text>
                  </View>
                </>
              )}
            </View>

            {story.degraded && (
              <View style={styles.degradedBanner}>
                <Ionicons name="information-circle-outline" size={16} color={colors.warn} />
                <Text style={styles.degradedText}>
                  Synthesized from limited information (the model was unavailable). This stitches the
                  outlets' one-line summaries; open the sources below for full coverage.
                </Text>
              </View>
            )}

            {/* The neutral synthesis */}
            {story.synthesis.map((p, i) => (
              <Text key={i} style={styles.paragraph}>
                {p}
              </Text>
            ))}

            {/* How each outlet framed it */}
            {story.angles.length > 0 && (
              <View style={styles.section}>
                <SectionHeader icon="color-wand-outline" label="How outlets framed it" />
                {story.angles.map((a, i) => (
                  <View key={i} style={styles.angleRow}>
                    <View style={[styles.leanDot, { backgroundColor: leanColor(a.lean), marginTop: 5 }]} />
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.angleOutlet, { color: leanColor(a.lean) }]}>
                        {a.outlet}
                        <Text style={styles.angleLean}>  {leanLabel(a.lean)}</Text>
                      </Text>
                      <Text style={styles.angleFraming}>{a.framing}</Text>
                    </View>
                  </View>
                ))}
              </View>
            )}

            {/* Contradictions across outlets */}
            {story.contradictions.length > 0 && (
              <View style={styles.section}>
                <SectionHeader icon="flash-outline" label="Contradictions & differences" color={colors.warn} />
                {story.contradictions.map((c, i) => (
                  <View key={i} style={styles.bulletRow}>
                    <Text style={[styles.bullet, { color: colors.warn }]}>•</Text>
                    <Text style={styles.bulletText}>{c}</Text>
                  </View>
                ))}
              </View>
            )}

            {/* Source articles */}
            <View style={styles.section}>
              <SectionHeader icon="link-outline" label={`Sources (${story.sources.length})`} />
              {story.sources.map((s) => (
                <Pressable
                  key={s.id}
                  style={styles.sourceRow}
                  onPress={() => void Linking.openURL(s.url)}
                  accessibilityRole="link"
                  accessibilityLabel={`Open ${s.sourceTitle} article`}
                >
                  <View style={[styles.leanDot, { backgroundColor: leanColor(s.lean), marginTop: 5 }]} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.sourceOutlet}>{s.sourceTitle}</Text>
                    <Text style={styles.sourceTitle} numberOfLines={2}>
                      {s.title}
                    </Text>
                  </View>
                  <Ionicons name="open-outline" size={16} color={colors.textDim} />
                </Pressable>
              ))}
            </View>

            {/* Related stories */}
            {related.length > 0 && (
              <View style={styles.section}>
                <SectionHeader icon="git-network-outline" label="Related stories" />
                {related.map((r) => (
                  <Pressable
                    key={r.id}
                    style={styles.relatedRow}
                    onPress={() => onOpenRelated(r.id)}
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

            <Text style={styles.disclaimer}>
              AI-synthesized from the linked sources for a neutral overview. Open the originals for the
              authoritative reporting.
            </Text>
          </ScrollView>
        )}
      </View>
    </Modal>
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

const READ_WIDTH = 720;

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
  title: { color: colors.text, fontSize: font.h1, fontWeight: "800", lineHeight: font.h1 * 1.22 },
  dek: { color: colors.textDim, fontSize: font.h3, lineHeight: font.h3 * 1.4 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginBottom: spacing.sm },
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
  sourceRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  sourceOutlet: { color: colors.text, fontSize: font.small, fontWeight: "700" },
  sourceTitle: { color: colors.textDim, fontSize: font.small, lineHeight: font.small * 1.4, marginTop: 1 },
  relatedRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs, paddingVertical: spacing.xs },
  relatedText: { flex: 1, color: colors.accent, fontSize: font.small, fontWeight: "600" },
  disclaimer: { color: colors.textFaint, fontSize: font.tiny, fontStyle: "italic", marginTop: spacing.lg },
  degradedBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    backgroundColor: colors.warn + "1A",
    borderColor: colors.warn + "55",
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    marginVertical: spacing.sm,
  },
  degradedText: { flex: 1, color: colors.textDim, fontSize: font.small, lineHeight: font.small * 1.4 },
});
