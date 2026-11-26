import { useAtomValue } from "@effect/atom-react"
import { Redirect, Tabs } from "expo-router"
import { ActivityIndicator, type ColorValue, View } from "react-native"
import { ProfileButton } from "../../components/profile"
import { Icon, type IconName } from "../../components/ui"
import { connectionAtom } from "../../state/connection"
import { inboxCountAtom } from "../../state/inbox"
import { colors } from "../../theme"

// The app's five places (HE-99): what waits on you, every task, your assistant, your documents, and the board itself.
// The Inbox's tab counts what waits on an answer; the screens that show one profile's things say which, and change it.

const icon = (name: IconName, active: IconName) =>
  function TabIcon({ color, focused }: { readonly color: ColorValue; readonly focused: boolean }) {
    return <Icon name={focused ? active : name} size={23} color={typeof color === "string" ? color : colors.faint} />
  }

const profile = () => <ProfileButton />

export default function TabsLayout() {
  const connection = useAtomValue(connectionAtom)
  const waiting = useAtomValue(inboxCountAtom)
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
        headerStyle: { backgroundColor: colors.bg },
        headerShadowVisible: false,
        headerTintColor: colors.fg,
        headerTitleAlign: "left",
        headerTitleStyle: { fontSize: 22, fontWeight: "700" },
        tabBarStyle: { backgroundColor: colors.panel, borderTopColor: colors.line },
        tabBarActiveTintColor: colors.fg,
        tabBarInactiveTintColor: colors.faint,
        tabBarLabelStyle: { fontSize: 11, fontWeight: "600" },
        tabBarBadgeStyle: { backgroundColor: colors.amber, color: colors.bg, fontSize: 11, fontWeight: "700" },
        sceneStyle: { backgroundColor: colors.bg },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Inbox",
          tabBarIcon: icon("file-tray-outline", "file-tray"),
          ...(waiting > 0 ? { tabBarBadge: waiting > 99 ? "99+" : waiting } : {}),
        }}
      />
      <Tabs.Screen name="tasks" options={{ title: "Tasks", tabBarIcon: icon("list-outline", "list"), headerRight: profile }} />
      <Tabs.Screen
        name="assistant"
        options={{ title: "Assistant", tabBarIcon: icon("sparkles-outline", "sparkles"), tabBarHideOnKeyboard: true, headerRight: profile }}
      />
      <Tabs.Screen name="docs" options={{ title: "Docs", tabBarIcon: icon("document-text-outline", "document-text"), headerRight: profile }} />
      <Tabs.Screen name="board" options={{ title: "Board", tabBarIcon: icon("hardware-chip-outline", "hardware-chip") }} />
    </Tabs>
  )
}
