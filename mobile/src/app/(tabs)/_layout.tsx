import { Tabs } from "expo-router";
import { Text } from "react-native";
import { colors } from "../../theme";

const icon = (glyph: string) =>
  function TabIcon({ color }: { color: import("react-native").ColorValue }) {
    return <Text style={{ color, fontSize: 18 }}>{glyph}</Text>;
  };

export default function TabsLayout() {
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
      <Tabs.Screen name="projects" options={{ title: "Projects", tabBarIcon: icon("▤") }} />
      <Tabs.Screen name="boards" options={{ title: "Boards", tabBarIcon: icon("⇄") }} />
    </Tabs>
  );
}
