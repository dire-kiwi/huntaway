// The app: the paired boards are read from the keychain first, then the tabs (Assistant, Inbox, Projects, Boards) and the
// screens pushed over them (pairing, a project's tasks, a task's thread, a board's notifications, where a share goes).
// Live updates and push run for as long as it does, and what other apps share into it is taken from the start.
import { Stack } from "expo-router";
import { ShareIntentProvider } from "expo-share-intent";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { ActivityIndicator, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { PushSetup } from "../notifications";
import { boards, LiveUpdates, useBoards } from "../session";
import { ShareHandler } from "../shareHandler";
import { colors } from "../theme";

export default function RootLayout() {
  const { loaded } = useBoards();
  useEffect(() => {
    void boards.load();
  }, []);
  return (
    // Before the boards are read: a share that opened the app is held until they are.
    <ShareIntentProvider>
      <SafeAreaProvider>
        <StatusBar style="light" />
        {!loaded ? (
          <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center" }}>
            <ActivityIndicator color={colors.accent} />
          </View>
        ) : (
          <>
            <LiveUpdates />
            <PushSetup />
            <ShareHandler />
            <Stack
              screenOptions={{
                headerStyle: { backgroundColor: colors.panel },
                headerTintColor: colors.fg,
                contentStyle: { backgroundColor: colors.bg },
              }}
            >
              <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
              <Stack.Screen name="pair" options={{ title: "Pair a board", presentation: "modal" }} />
              <Stack.Screen name="project/[board]/[host]/[id]" options={{ title: "Project" }} />
              <Stack.Screen name="task/[board]/[host]/[id]" options={{ title: "Task" }} />
              <Stack.Screen name="notifications/[board]" options={{ title: "Notifications" }} />
              <Stack.Screen name="share" options={{ title: "Share with your assistant", presentation: "modal" }} />
            </Stack>
          </>
        )}
      </SafeAreaProvider>
    </ShareIntentProvider>
  );
}
