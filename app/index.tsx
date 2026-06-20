import React from "react";
import { ActivityIndicator, View } from "react-native";
import { Redirect } from "expo-router";
import { useApp } from "../src/store/AppContext";
import { colors } from "../src/theme";

export default function Index() {
  const { ready, prefs } = useApp();

  if (!ready) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg }}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return <Redirect href={prefs.onboarded ? "/(tabs)" : "/onboarding"} />;
}
