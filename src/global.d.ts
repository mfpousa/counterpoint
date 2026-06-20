// Ambient declaration so TS knows about `process.env` on the client.
// At runtime React Native shims `process.env`, and Expo statically inlines any
// `EXPO_PUBLIC_*` variables at build time (e.g. EXPO_PUBLIC_API_URL).
declare const process: {
  env: { [key: string]: string | undefined };
};
