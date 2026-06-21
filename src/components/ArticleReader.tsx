// Full-screen in-app reader showing an AI-rewritten, distraction-free version of
// an article. Fetches on open; degrades gracefully with a clear error + an
// "Open original" escape hatch.

import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { fetchRewrite } from "../lib/api";
import { useApp, useT } from "../store/AppContext";
import { colors, font, radius, spacing } from "../theme";
import type { FeedItem, RewrittenArticle } from "../types";

export function ArticleReader({
  item,
  onClose,
}: {
  item: FeedItem | null;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { prefs } = useApp();
  const t = useT();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [article, setArticle] = useState<RewrittenArticle | null>(null);

  useEffect(() => {
    if (!item) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setArticle(null);
    fetchRewrite(item.id, prefs.language)
      .then((a) => {
        if (!cancelled) setArticle(a);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : t("reader.couldntLoad"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [item]);

  const open = item ? () => void Linking.openURL(item.url) : undefined;

  return (
    <Modal visible={!!item} animationType="slide" onRequestClose={onClose} transparent={false}>
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.topBar}>
          <Pressable onPress={onClose} hitSlop={10} style={styles.iconBtn} accessibilityRole="button">
            <Ionicons name="chevron-down" size={22} color={colors.text} />
          </Pressable>
          <View style={styles.aiTag}>
            <Ionicons name="sparkles" size={12} color={colors.accent} />
            <Text style={styles.aiTagText}>{t("reader.aiRewrite")}</Text>
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
          {loading && (
            <View style={styles.center}>
              <ActivityIndicator size="large" color={colors.accent} />
              <Text style={styles.centerText}>{t("reader.rewriting")}</Text>
            </View>
          )}

          {!loading && error && (
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

          {!loading && article && (
            <>
              <Text style={styles.title}>{article.title}</Text>
              <View style={styles.metaRow}>
                <Text style={styles.meta}>{article.sourceTitle}</Text>
                <Text style={styles.dot}>·</Text>
                <Text style={styles.meta}>{t("reader.minRead", { n: article.estMinutes })}</Text>
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
              {article.degraded && open && (
                <Pressable onPress={open} style={styles.primaryBtn} accessibilityRole="link">
                  <Ionicons name="open-outline" size={16} color={colors.bg} />
                  <Text style={styles.primaryBtnText}>{t("reader.readFull")}</Text>
                </Pressable>
              )}
              <Text style={styles.disclaimer}>
                {article.degraded ? t("reader.disclaimerDegraded") : t("reader.disclaimer")}
              </Text>
            </>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

const READ_WIDTH = 680;

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
  errorText: { color: colors.text, fontSize: font.body, textAlign: "center" },
  title: { color: colors.text, fontSize: font.h1, fontWeight: "800", lineHeight: font.h1 * 1.25 },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.sm,
    marginBottom: spacing.lg,
  },
  meta: { color: colors.textDim, fontSize: font.small },
  dot: { color: colors.textFaint },
  paragraph: {
    color: colors.text,
    fontSize: font.h3,
    lineHeight: font.h3 * 1.6,
    marginBottom: spacing.lg,
  },
  disclaimer: {
    color: colors.textFaint,
    fontSize: font.tiny,
    fontStyle: "italic",
    marginTop: spacing.md,
  },
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
