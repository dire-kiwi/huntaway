import { RegistryContext } from "@effect/atom-react"
import { Stack } from "expo-router"
import { StatusBar } from "expo-status-bar"
import { View } from "react-native"
import { SafeAreaProvider } from "react-native-safe-area-context"
import { ConnectionBanner } from "../components/connection"
import { LinkPrompt } from "../components/linkPrompt"
import { startProfile } from "../state/board"
import { startConnection } from "../state/connection"
import { registry } from "../state/registry"
import { colors } from "../theme"

// The app: the board kept in the keychain is read first (the tabs send you to Connect when there is none), then the
// tabs (Inbox, Tasks, Assistant, Docs, Board) and the screens pushed over them (a task's thread, a plugin's page: a
// document). Over all of them: whether the board is there, and the question before a link leaves the app.
startConnection()
startProfile()

export default function RootLayout() {
  return (
    <RegistryContext.Provider value={registry}>
      <SafeAreaProvider>
        <StatusBar style="light" />
        <View style={{ flex: 1, backgroundColor: colors.bg }}>
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: colors.bg },
              headerShadowVisible: false,
              headerTintColor: colors.fg,
              headerBackButtonDisplayMode: "minimal",
              contentStyle: { backgroundColor: colors.bg },
            }}
          >
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="connect" options={{ title: "Connect a board" }} />
            <Stack.Screen name="task/[host]/[id]" options={{ title: "" }} />
            <Stack.Screen name="page" options={{ title: "" }} />
          </Stack>
          <ConnectionBanner />
          <LinkPrompt />
        </View>
      </SafeAreaProvider>
    </RegistryContext.Provider>
  )
}
