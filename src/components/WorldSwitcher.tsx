// Horizontal world selector. Each "world" is a distinct news universe with its
// own sources + analyzed pool. Because deep analysis is expensive, only one world
// refreshes at a time — the chip for a world that's currently refreshing shows a
// spinner, and the Today screen surfaces a "busy" banner when a switch is blocked.

import React from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { WORLDS } from "../data/worlds";
import { useT } from "../store/AppContext";
import { colors, font, radius, spacing } from "../theme";

export function WorldSwitcher({
  worldId,
  busyWorld,
  onSelect,
}: {
  worldId: string;
  busyWorld: string | null;
  onSelect: (id: string) => void;
}) {
  const t = useT();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
    >
      {WORLDS.map((w) => {
        const active = w.id === worldId;
        const busy = busyWorld === w.id;
        return (
          <Pressable
            key={w.id}
            onPress={() => onSelect(w.id)}
            style={[styles.chip, active && styles.chipActive]}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
          >
            <Ionicons
              name={w.icon as keyof typeof Ionicons.glyphMap}
              size={14}
              color={active ? colors.bg : colors.textDim}
            />
            <Text style={[styles.label, active && styles.labelActive]} numberOfLines={1}>
              {t(`world.${w.id}`)}
            </Text>
            {busy && (
              <ActivityIndicator size="small" color={active ? colors.bg : colors.accent} />
            )}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { gap: spacing.sm, paddingVertical: spacing.xs, paddingRight: spacing.lg },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  label: { color: colors.textDim, fontSize: font.small, fontWeight: "700" },
  labelActive: { color: colors.bg },
});
