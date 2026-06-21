// Loading skeletons. These reserve the SAME vertical space the real content
// will occupy, so async content (the briefing, developing stories) fades in
// WITHOUT shoving the page down under the reader's finger mid-tap.

import React, { useEffect, useRef } from "react";
import { Animated, StyleSheet, View, type ViewStyle } from "react-native";
import { colors, radius, spacing } from "../theme";

/** A single pulsing placeholder block. */
export function Skeleton({
  width = "100%",
  height,
  radius: r = radius.sm,
  style,
}: {
  width?: ViewStyle["width"];
  height: number;
  radius?: number;
  style?: ViewStyle;
}) {
  const opacity = useRef(new Animated.Value(0.4)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.85, duration: 750, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.4, duration: 750, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);
  return (
    <Animated.View
      style={[{ width, height, borderRadius: r, backgroundColor: colors.surfaceAlt, opacity }, style]}
    />
  );
}

/** Card-shaped skeleton matching a StoryCard's footprint (prevents layout jump
 *  when the developing-stories band resolves). */
export function StoryCardSkeleton() {
  return (
    <View style={styles.card}>
      <Skeleton width={90} height={16} radius={radius.pill} />
      <Skeleton width="85%" height={20} />
      <Skeleton width="100%" height={12} />
      <Skeleton width="70%" height={12} />
      <View style={styles.footer}>
        <Skeleton width={70} height={10} radius={radius.pill} />
        <Skeleton width={50} height={10} radius={radius.pill} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
    minHeight: 150,
  },
  footer: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: 4 },
});
