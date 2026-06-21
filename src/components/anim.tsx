// Lightweight entrance animation used to make new feed cards feel "live": each
// card fades + lifts into place on mount. Because React reuses elements by key,
// only genuinely NEW cards (new ids) mount and animate; existing cards stay put.

import React, { useEffect, useRef, useState } from "react";
import { Animated, Easing, Text, type TextStyle, type ViewStyle } from "react-native";
import { colors } from "../theme";

export function FadeInView({
  children,
  style,
  /** Stagger (ms) so a batch of new cards cascades in instead of popping at once. */
  delay = 0,
}: {
  children: React.ReactNode;
  style?: ViewStyle;
  delay?: number;
}) {
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const anim = Animated.timing(progress, {
      toValue: 1,
      duration: 320,
      delay,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    anim.start();
    return () => anim.stop();
  }, [progress, delay]);

  return (
    <Animated.View
      style={[
        style,
        {
          opacity: progress,
          transform: [
            { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) },
          ],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}

/** A blinking text cursor — shown at the end of streaming text ("AI is writing"). */
export function Cursor({ style }: { style?: TextStyle }) {
  const o = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(o, { toValue: 0.1, duration: 500, useNativeDriver: true }),
        Animated.timing(o, { toValue: 1, duration: 500, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [o]);
  return <Animated.Text style={[{ color: colors.accent, fontWeight: "800", opacity: o }, style]}>▌</Animated.Text>;
}

/**
 * Reveals `text` progressively (typewriter) while `active`, then shows it whole.
 * Used for structured story text that arrives complete but should still feel like
 * the AI is writing it. Reveals ~`cps` characters/second.
 */
export function Typewriter({
  text,
  active = true,
  cps = 220,
  style,
}: {
  text: string;
  active?: boolean;
  cps?: number;
  style?: TextStyle;
}) {
  const [shown, setShown] = useState(active ? "" : text);
  useEffect(() => {
    if (!active) {
      setShown(text);
      return;
    }
    let raf = 0;
    let start = 0;
    const step = (ts: number) => {
      if (!start) start = ts;
      const n = Math.min(text.length, Math.floor(((ts - start) / 1000) * cps));
      setShown(text.slice(0, n));
      if (n < text.length) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [text, active, cps]);
  const done = shown.length >= text.length;
  return (
    <Text style={style}>
      {shown}
      {active && !done ? <Cursor /> : null}
    </Text>
  );
}
