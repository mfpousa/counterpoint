// Recall-summary gate. Before an article counts as "seen", the reader writes a
// short summary of what they learned. The backend grades it against the article;
// a passing score marks the item done, a failing one teaches what was missed and
// invites a retry. Reopening a graded item shows the stored score + feedback.

import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GradeFeedback, ScorePill, scoreColor } from "./GradeFeedback";
import { PASS_SCORE } from "../lib/knowledge";
import { useT } from "../store/AppContext";
import { colors, font, radius, spacing } from "../theme";
import type { FeedItem, StoredSummary, SummaryGrade } from "../types";

const MIN_CHARS = 10;
const READ_WIDTH = 680;

export function SummaryModal({
  item,
  existing,
  onGrade,
  onClose,
}: {
  item: FeedItem | null;
  existing?: StoredSummary;
  onGrade: (item: FeedItem, text: string) => Promise<SummaryGrade>;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const tr = useT();
  const [text, setText] = useState("");
  const [editing, setEditing] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [grade, setGrade] = useState<SummaryGrade | null>(null);
  const [error, setError] = useState<string | null>(null);

  // (Re)initialize whenever the target item changes.
  useEffect(() => {
    if (!item) return;
    setText(existing?.summary ?? "");
    setGrade(existing?.grade ?? null);
    setEditing(!existing);
    setSubmitting(false);
    setError(null);
  }, [item, existing]);

  const passed = grade ? grade.score >= PASS_SCORE : false;

  const submit = async () => {
    if (!item || text.trim().length < MIN_CHARS) return;
    setSubmitting(true);
    setError(null);
    try {
      const g = await onGrade(item, text);
      setGrade(g);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : tr("summary.couldntGrade"));
    } finally {
      setSubmitting(false);
    }
  };

  const charCount = text.trim().length;
  const canSubmit = charCount >= MIN_CHARS && !submitting;

  return (
    <Modal visible={!!item} animationType="slide" onRequestClose={onClose} transparent={false}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={[styles.inner, { paddingTop: insets.top }]}>
          <View style={styles.topBar}>
            <Pressable onPress={onClose} hitSlop={10} style={styles.iconBtn} accessibilityRole="button">
              <Ionicons name="chevron-down" size={22} color={colors.text} />
            </Pressable>
            <View style={styles.aiTag}>
              <Ionicons name="create-outline" size={12} color={colors.accent} />
              <Text style={styles.aiTagText}>{tr("summary.recallCheck")}</Text>
            </View>
            <View style={{ flex: 1 }} />
            {grade && <ScorePill score={grade.score} />}
          </View>

          <ScrollView
            contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xxl }]}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {!!item && (
              <Text style={styles.headline} numberOfLines={3}>
                {item.title}
              </Text>
            )}
            <Text style={styles.prompt}>{tr("summary.prompt")}</Text>

            {editing ? (
              <>
                <TextInput
                  style={styles.input}
                  value={text}
                  onChangeText={setText}
                  placeholder={tr("summary.placeholder")}
                  placeholderTextColor={colors.textFaint}
                  multiline
                  textAlignVertical="top"
                  autoFocus={!existing}
                  editable={!submitting}
                />
                <View style={styles.metaRow}>
                  <Text style={[styles.charCount, charCount < MIN_CHARS && { color: colors.textFaint }]}>
                    {charCount < MIN_CHARS
                      ? tr("summary.minChars", { n: MIN_CHARS })
                      : tr("summary.charCount", { n: charCount })}
                  </Text>
                </View>
                {error && (
                  <View style={styles.errorBanner}>
                    <Ionicons name="alert-circle-outline" size={16} color={colors.danger} />
                    <Text style={styles.errorText}>{error}</Text>
                  </View>
                )}
                <Pressable
                  onPress={submit}
                  disabled={!canSubmit}
                  style={[styles.primaryBtn, !canSubmit && styles.primaryBtnDisabled]}
                  accessibilityRole="button"
                >
                  {submitting ? (
                    <ActivityIndicator size="small" color={colors.bg} />
                  ) : (
                    <Ionicons name="checkmark-circle" size={18} color={colors.bg} />
                  )}
                  <Text style={styles.primaryBtnText}>
                    {submitting ? tr("summary.grading") : tr("summary.submit")}
                  </Text>
                </Pressable>
              </>
            ) : grade ? (
              <>
                <View style={[styles.resultBanner, { borderColor: scoreColor(grade.score) }]}>
                  <Ionicons
                    name={passed ? "trophy" : "barbell-outline"}
                    size={20}
                    color={scoreColor(grade.score)}
                  />
                  <Text style={styles.resultText}>
                    {passed ? tr("summary.passed") : tr("summary.failed")}
                  </Text>
                </View>

                <View style={styles.yourSummary}>
                  <Text style={styles.yourSummaryLabel}>{tr("summary.yourSummary")}</Text>
                  <Text style={styles.yourSummaryText}>{text}</Text>
                </View>

                <GradeFeedback grade={grade} />

                <Pressable onPress={() => setEditing(true)} style={styles.secondaryBtn} accessibilityRole="button">
                  <Ionicons name="refresh" size={16} color={colors.accent} />
                  <Text style={styles.secondaryBtnText}>{passed ? tr("summary.revise") : tr("summary.tryAgain")}</Text>
                </Pressable>
              </>
            ) : null}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  inner: { flex: 1 },
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
    gap: spacing.md,
  },
  headline: { color: colors.text, fontSize: font.h3, fontWeight: "800", lineHeight: font.h3 * 1.3 },
  prompt: { color: colors.textDim, fontSize: font.small, lineHeight: font.small * 1.5 },
  input: {
    minHeight: 160,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    color: colors.text,
    fontSize: font.body,
    lineHeight: font.body * 1.4,
  },
  metaRow: { flexDirection: "row", justifyContent: "flex-end" },
  charCount: { color: colors.textDim, fontSize: font.tiny },
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
  primaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
  },
  primaryBtnDisabled: { opacity: 0.5 },
  primaryBtnText: { color: colors.bg, fontSize: font.body, fontWeight: "800" },
  resultBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1.5,
    backgroundColor: colors.surface,
  },
  resultText: { flex: 1, color: colors.text, fontSize: font.body, fontWeight: "600", lineHeight: font.body * 1.4 },
  yourSummary: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
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
  secondaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
    borderColor: colors.accent,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
  },
  secondaryBtnText: { color: colors.accent, fontSize: font.body, fontWeight: "700" },
});
