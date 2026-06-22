import React, { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useApp, useT } from "../../src/store/AppContext";
import { LANGUAGES } from "../../src/lib/i18n";
import { regionsFor, seededCountries } from "../../src/data/places";
import { resetAll } from "../../src/storage/storage";
import { colors, font, radius, spacing } from "../../src/theme";
import type { Kind, Topic } from "../../src/types";

const QUOTAS = [30, 60, 90, 120, 180, 240];
const TOPICS: Topic[] = [
  "world",
  "politics",
  "economics",
  "science",
  "technology",
  "history",
  "culture",
];
const KINDS: Kind[] = ["video", "podcast", "news"];
const THRESHOLDS = [0.15, 0.25, 0.35];
const INTEREST_PRESETS = [
  "AI and AI-related scientific progress",
  "Geopolitics, economics, and markets",
  "Climate, energy, and the environment",
  "Health, medicine, and longevity",
];

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const { prefs, updatePrefs, resetToday, refreshFeed } = useApp();
  const t = useT();
  const [interestDraft, setInterestDraft] = useState(prefs.interestPrompt);
  const interestDirty = interestDraft.trim() !== prefs.interestPrompt.trim();

  const saveInterest = (value: string) => {
    setInterestDraft(value);
    void updatePrefs({ interestPrompt: value.trim() });
  };

  const toggleTopic = (topic: Topic) => {
    const next = prefs.enabledTopics.includes(topic)
      ? prefs.enabledTopics.filter((x) => x !== topic)
      : [...prefs.enabledTopics, topic];
    void updatePrefs({ enabledTopics: next });
  };
  const toggleKind = (k: Kind) => {
    const next = prefs.includeKinds.includes(k)
      ? prefs.includeKinds.filter((x) => x !== k)
      : [...prefs.includeKinds, k];
    void updatePrefs({ includeKinds: next });
  };

  // Place lens (country -> region -> locality). Country/region come from the
  // shared gazetteer seed; locality is free text (matched server-side).
  const place = prefs.place ?? null;
  const countries = seededCountries();
  const regions = place?.country ? regionsFor(place.country) : [];
  const [localityDraft, setLocalityDraft] = useState(place?.locality ?? "");

  const selectCountry = (code: string | null) => {
    setLocalityDraft("");
    // Switching country invalidates any region/locality from another country.
    void updatePrefs({ place: code ? { country: code } : null });
  };
  const selectRegion = (regionId: string | null) => {
    if (!place?.country) return;
    void updatePrefs({
      place: { country: place.country, region: regionId ?? undefined, locality: place.locality },
    });
  };
  const saveLocality = () => {
    if (!place?.country) return;
    const locality = localityDraft.trim();
    void updatePrefs({
      place: { country: place.country, region: place.region, locality: locality || undefined },
    });
  };

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
      <Text style={styles.title}>{t("settings.title")}</Text>

      <View style={styles.card}>
        <Text style={styles.h}>{t("settings.language")}</Text>
        <Text style={styles.sub}>{t("settings.languageSub")}</Text>
        <View style={styles.wrap}>
          {LANGUAGES.map((l) => (
            <Pressable
              key={l.code}
              onPress={() => updatePrefs({ language: l.code })}
              style={[styles.pill, prefs.language === l.code && styles.pillActive]}
            >
              <Text style={[styles.pillText, prefs.language === l.code && styles.pillTextActive]}>
                {l.endonym}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={styles.card}>
        <View style={styles.rowBetween}>
          <Text style={styles.h}>{t("settings.place")}</Text>
          <Ionicons name="location" size={18} color={colors.accent} />
        </View>
        <Text style={styles.sub}>{t("settings.placeSub")}</Text>
        <View style={styles.wrap}>
          <Pressable
            onPress={() => selectCountry(null)}
            style={[styles.pill, !place?.country && styles.pillActive]}
          >
            <Text style={[styles.pillText, !place?.country && styles.pillTextActive]}>
              {t("settings.placeGlobal")}
            </Text>
          </Pressable>
          {countries.map((c) => (
            <Pressable
              key={c.code}
              onPress={() => selectCountry(c.code)}
              style={[styles.pill, place?.country === c.code && styles.pillActive]}
            >
              <Text style={[styles.pillText, place?.country === c.code && styles.pillTextActive]}>
                {c.label}
              </Text>
            </Pressable>
          ))}
        </View>
        {place?.country && regions.length > 0 && (
          <View style={styles.wrap}>
            <Pressable
              onPress={() => selectRegion(null)}
              style={[styles.pill, !place.region && styles.pillActive]}
            >
              <Text style={[styles.pillText, !place.region && styles.pillTextActive]}>
                {t("settings.placeRegionAll")}
              </Text>
            </Pressable>
            {regions.map((r) => (
              <Pressable
                key={r.id}
                onPress={() => selectRegion(r.id)}
                style={[styles.pill, place.region === r.id && styles.pillActive]}
              >
                <Text style={[styles.pillText, place.region === r.id && styles.pillTextActive]}>
                  {r.label}
                </Text>
              </Pressable>
            ))}
          </View>
        )}
        {place?.country && (
          <>
            <Text style={styles.sub}>{t("settings.placeLocality")}</Text>
            <TextInput
              style={styles.localityInput}
              value={localityDraft}
              onChangeText={setLocalityDraft}
              onBlur={saveLocality}
              onSubmitEditing={saveLocality}
              placeholder={t("settings.placeLocalityPlaceholder")}
              placeholderTextColor={colors.textFaint}
              returnKeyType="done"
            />
          </>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.h}>{t("settings.dailyQuota")}</Text>
        <View style={styles.wrap}>
          {QUOTAS.map((q) => (
            <Pressable
              key={q}
              onPress={() => updatePrefs({ dailyQuotaMin: q })}
              style={[styles.pill, prefs.dailyQuotaMin === q && styles.pillActive]}
            >
              <Text style={[styles.pillText, prefs.dailyQuotaMin === q && styles.pillTextActive]}>
                {q < 60 ? `${q}m` : `${q / 60}h`}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.h}>{t("settings.topics")}</Text>
        <View style={styles.wrap}>
          {TOPICS.map((topic) => (
            <Pressable
              key={topic}
              onPress={() => toggleTopic(topic)}
              style={[styles.pill, prefs.enabledTopics.includes(topic) && styles.pillActive]}
            >
              <Text style={[styles.pillText, prefs.enabledTopics.includes(topic) && styles.pillTextActive]}>
                {topic}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.h}>{t("settings.contentTypes")}</Text>
        <View style={styles.wrap}>
          {KINDS.map((k) => (
            <Pressable
              key={k}
              onPress={() => toggleKind(k)}
              style={[styles.pill, prefs.includeKinds.includes(k) && styles.pillActive]}
            >
              <Text style={[styles.pillText, prefs.includeKinds.includes(k) && styles.pillTextActive]}>
                {t(`settings.kind.${k}`)}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.h}>{t("settings.drift")}</Text>
        <Text style={styles.sub}>{t("settings.driftSub")}</Text>
        <View style={styles.wrap}>
          {THRESHOLDS.map((th) => (
            <Pressable
              key={th}
              onPress={() => updatePrefs({ driftThreshold: th })}
              style={[styles.pill, prefs.driftThreshold === th && styles.pillActive]}
            >
              <Text style={[styles.pillText, prefs.driftThreshold === th && styles.pillTextActive]}>
                {th === 0.15 ? t("settings.strict") : th === 0.25 ? t("settings.balanced") : t("settings.relaxed")}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={styles.card}>
        <View style={styles.rowBetween}>
          <Text style={styles.h}>{t("settings.steer")}</Text>
          <Ionicons name="navigate" size={18} color={colors.accent} />
        </View>
        <Text style={styles.sub}>{t("settings.steerSub")}</Text>
        <TextInput
          style={styles.interestInput}
          value={interestDraft}
          onChangeText={setInterestDraft}
          placeholder={t("settings.steerPlaceholder")}
          placeholderTextColor={colors.textFaint}
          multiline
          textAlignVertical="top"
        />
        <View style={styles.wrap}>
          {INTEREST_PRESETS.map((p) => (
            <Pressable key={p} onPress={() => saveInterest(p)} style={styles.presetPill}>
              <Text style={styles.presetText}>{p}</Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.rowBetween}>
          <Pressable
            onPress={() => saveInterest("")}
            disabled={interestDraft.trim().length === 0}
          >
            <Text
              style={[
                styles.clearText,
                interestDraft.trim().length === 0 && { color: colors.textFaint },
              ]}
            >
              {t("settings.clear")}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => saveInterest(interestDraft)}
            disabled={!interestDirty}
            style={[styles.saveBtn, !interestDirty && styles.saveBtnDisabled]}
          >
            <Ionicons
              name="checkmark"
              size={15}
              color={interestDirty ? colors.bg : colors.textFaint}
            />
            <Text style={[styles.saveText, !interestDirty && { color: colors.textFaint }]}>
              {interestDirty ? t("settings.saveUpdate") : t("settings.saved")}
            </Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.card}>
        <View style={styles.rowBetween}>
          <Text style={styles.h}>{t("settings.howBuilt")}</Text>
          <Ionicons name="sparkles" size={18} color={colors.accent} />
        </View>
        <Text style={styles.sub}>{t("settings.howBuiltSub")}</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.h}>{t("settings.data")}</Text>
        <Pressable onPress={() => refreshFeed({ force: true })} style={styles.btn}>
          <Text style={styles.btnText}>{t("settings.refreshNow")}</Text>
        </Pressable>
        <Pressable onPress={resetToday} style={styles.btn}>
          <Text style={styles.btnText}>{t("settings.resetToday")}</Text>
        </Pressable>
        <Pressable
          onPress={() => updatePrefs({ onboarded: false })}
          style={styles.btn}
        >
          <Text style={styles.btnText}>{t("settings.rerunOnboarding")}</Text>
        </Pressable>
        <Pressable
          onPress={async () => {
            await resetAll();
            await updatePrefs({ onboarded: false });
          }}
          style={[styles.btn, styles.btnDanger]}
        >
          <Text style={[styles.btnText, { color: colors.danger }]}>{t("settings.eraseAll")}</Text>
        </Pressable>
      </View>

      <Text style={styles.footnote}>{t("settings.footnote")}</Text>
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
    gap: spacing.md,
  },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  h: { color: colors.text, fontSize: font.h3, fontWeight: "700" },
  sub: { color: colors.textDim, fontSize: font.small, lineHeight: 19 },
  wrap: { flexDirection: "row", gap: spacing.sm, flexWrap: "wrap" },
  pill: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
  },
  pillActive: { backgroundColor: colors.accentDim, borderColor: colors.accent },
  pillText: { color: colors.textDim, fontSize: font.small, fontWeight: "600", textTransform: "capitalize" },
  pillTextActive: { color: colors.text },
  interestInput: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: font.body,
    minHeight: 64,
  },
  localityInput: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: font.body,
  },
  presetPill: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
  },
  presetText: { color: colors.textDim, fontSize: font.small, fontWeight: "600" },
  clearText: { color: colors.accent, fontSize: font.small, fontWeight: "700" },
  saveBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  saveBtnDisabled: { backgroundColor: colors.surfaceAlt },
  saveText: { color: colors.bg, fontSize: font.small, fontWeight: "800" },
  btn: {
    backgroundColor: colors.surfaceAlt,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: "center",
  },
  btnDanger: { backgroundColor: "transparent", borderWidth: 1, borderColor: colors.danger },
  btnText: { color: colors.text, fontSize: font.body, fontWeight: "700" },
  footnote: { color: colors.textFaint, fontSize: font.tiny, textAlign: "center" },
});
