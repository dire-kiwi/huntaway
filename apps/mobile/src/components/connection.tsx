import { useAtomValue } from "@effect/atom-react"
import { router } from "expo-router"
import { ActivityIndicator, Pressable, Text } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useBoard } from "../state/board"
import { connectionAtom } from "../state/connection"
import { colors, radius, space, tint } from "../theme"
import { Icon } from "./ui"

// Whether the board is there (HE-99): nothing while it is live; a note over the bottom of every screen while the app is
// finding it again, so a list that has stopped moving says why, and one that takes you to Board when the board turned
// this phone down.

export function ConnectionBanner() {
  const insets = useSafeAreaInsets()
  const connected = useBoard((b) => b.connected)
  const authed = useBoard((b) => b.authed)
  const loaded = useBoard((b) => b.loaded)
  const connection = useAtomValue(connectionAtom)
  // With no board, Connect says so; before the first board has arrived, the screens say they are loading.
  if (connection._tag !== "board" || (authed !== false && (connected || !loaded))) return null
  const refused = authed === false
  const color = refused ? colors.red : colors.amber
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={refused ? "The board turned this phone down" : "Reconnecting to the board"}
      onPress={() => router.navigate("/board")}
      style={{
        position: "absolute",
        alignSelf: "center",
        bottom: insets.bottom + 68,
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
        paddingHorizontal: space.md,
        height: 36,
        borderRadius: radius.pill,
        backgroundColor: colors.raised,
        borderWidth: 1,
        borderColor: tint(color, 0.5),
      }}
    >
      {refused ? <Icon name="lock-closed" size={14} color={color} /> : <ActivityIndicator size="small" color={color} />}
      <Text style={{ color: colors.fg, fontSize: 13, fontWeight: "600" }}>{refused ? "The board turned this phone down" : "Reconnecting to the board…"}</Text>
    </Pressable>
  )
}
