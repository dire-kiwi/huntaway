import { useAtomValue } from "@effect/atom-react"
import { Redirect, Tabs } from "expo-router"
import { ActivityIndicator, type ColorValue, Text, View } from "react-native"
import { connectionAtom } from "../../state/connection"
import { colors } from "../../theme"

const icon = (glyph: string) =>
  function TabIcon({ color }: { readonly color: ColorValue }) {
    return <Text style={{ color, fontSize: 18 }}>{glyph}</Text>
  }

export default function TabsLayout() {
  const connection = useAtomValue(connectionAtom)
  if (connection._tag === "loading")
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={colors.accent} />
      </View>
    )
  if (connection._tag === "none") return <Redirect href="/connect" />
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.panel },
        headerTintColor: colors.fg,
        tabBarStyle: { backgroundColor: colors.panel, borderTopColor: colors.line },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.faint,
        sceneStyle: { backgroundColor: colors.bg },
      }}
    >
      <Tabs.Screen name="index" options={{ title: "Inbox", tabBarIcon: icon("◉") }} />
      <Tabs.Screen name="assistant" options={{ title: "Assistant", tabBarIcon: icon("✦"), tabBarHideOnKeyboard: true }} />
      <Tabs.Screen name="projects" options={{ title: "Projects", tabBarIcon: icon("▤") }} />
      <Tabs.Screen name="board" options={{ title: "Board", tabBarIcon: icon("⇄") }} />
    </Tabs>
  )
}
