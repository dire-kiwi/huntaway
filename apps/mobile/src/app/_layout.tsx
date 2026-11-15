import { RegistryContext } from "@effect/atom-react"
import { Stack } from "expo-router"
import { StatusBar } from "expo-status-bar"
import { SafeAreaProvider } from "react-native-safe-area-context"
import { startProfile } from "../state/board"
import { startConnection } from "../state/connection"
import { registry } from "../state/registry"
import { colors } from "../theme"

// The app: the board kept in the keychain is read first (the tabs send you to Connect when there is none), then the
// tabs (Inbox, Assistant, Projects, Board) and the screens pushed over them (a project's tasks, a task's thread).
startConnection()
startProfile()

export default function RootLayout() {
  return (
    <RegistryContext.Provider value={registry}>
      <SafeAreaProvider>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: colors.panel },
            headerTintColor: colors.fg,
            contentStyle: { backgroundColor: colors.bg },
          }}
        >
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="connect" options={{ title: "Connect a board" }} />
          <Stack.Screen name="project/[host]/[id]" options={{ title: "Project" }} />
          <Stack.Screen name="task/[host]/[id]" options={{ title: "Task" }} />
        </Stack>
      </SafeAreaProvider>
    </RegistryContext.Provider>
  )
}
