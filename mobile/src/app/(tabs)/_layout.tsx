import { Tabs } from "expo-router";
import { Text } from "react-native";
import { showsAssistant } from "../../assistant";
import { boards, statusOf, useBoards, useBoardStatuses } from "../../session";
import { colors } from "../../theme";

const icon = (glyph: string) =>
  function TabIcon({ color }: { color: import("react-native").ColorValue }) {
    return <Text style={{ color, fontSize: 18 }}>{glyph}</Text>;
  };

export default function TabsLayout() {
  useBoards();
  const statuses = useBoardStatuses();
  const board = boards.selectedBoard();
  // Home is the assistant, on a board that has it for the app; otherwise the Inbox (the Assistant screen sends you there).
  const assistant = !!board && showsAssistant(board, statusOf(statuses, board.id));
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
      <Tabs.Screen name="index" options={{ title: "Assistant", tabBarIcon: icon("✦"), href: assistant ? undefined : null, tabBarHideOnKeyboard: true }} />
      <Tabs.Screen name="inbox" options={{ title: "Inbox", tabBarIcon: icon("◉") }} />
      <Tabs.Screen name="projects" options={{ title: "Projects", tabBarIcon: icon("▤") }} />
      <Tabs.Screen name="boards" options={{ title: "Boards", tabBarIcon: icon("⇄") }} />
    </Tabs>
  );
}
