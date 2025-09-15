import { Stack } from "expo-router";

export default function RootLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: "#000" },
        headerTintColor: "#fff",
      }}
    >
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="sessions" options={{ title: "Sessions" }} />
      <Stack.Screen name="build" options={{ title: "Build Video" }} />
      <Stack.Screen name="settings" options={{ title: "Settings" }} />
      <Stack.Screen name="permissions" options={{ title: "Permissions" }} />
    </Stack>
  );
}
