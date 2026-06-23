// Place navigator with two interchangeable presentations sharing ONE contract:
//   - "list"  → the lightweight chip drill-down (GeoNavigator), always available
//               as a fast, dependency-free fallback;
//   - "globe" → the 3D metallic world (Globe), the richer spatial view.
// A small segmented toggle flips between them; everything else (selection, World =
// Front Page, home pinning) is identical, so callers don't care which is shown.

import React, { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { GeoNavigator } from "./GeoNavigator";
import { Globe } from "./globe/Globe";
import { colors, radius, spacing } from "../theme";

type Mode = "list" | "globe";

export function GeoBrowser(props: {
  activePoolId?: string;
  home?: string;
  onSelect: (poolId?: string) => void;
  onSelectWorld?: () => void;
  worldActive?: boolean;
  onSetHome?: (nodeId: string) => void;
}) {
  const [mode, setMode] = useState<Mode>("list");

  return (
    <View style={styles.wrap}>
      <View style={styles.toggle}>
        <Pressable
          onPress={() => setMode("list")}
          style={[styles.tab, mode === "list" && styles.tabActive]}
          accessibilityRole="button"
          accessibilityState={{ selected: mode === "list" }}
          accessibilityLabel="List view"
        >
          <Ionicons name="list" size={15} color={mode === "list" ? colors.bg : colors.textDim} />
        </Pressable>
        <Pressable
          onPress={() => setMode("globe")}
          style={[styles.tab, mode === "globe" && styles.tabActive]}
          accessibilityRole="button"
          accessibilityState={{ selected: mode === "globe" }}
          accessibilityLabel="3D globe view"
        >
          <Ionicons name="globe-outline" size={15} color={mode === "globe" ? colors.bg : colors.textDim} />
        </Pressable>
      </View>

      {mode === "globe" ? <Globe {...props} /> : <GeoNavigator {...props} />}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.xs },
  toggle: {
    flexDirection: "row",
    alignSelf: "flex-end",
    gap: 2,
    padding: 2,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  tab: {
    width: 32,
    height: 26,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
  },
  tabActive: { backgroundColor: colors.accent },
});
