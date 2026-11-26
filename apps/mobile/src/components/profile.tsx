import { useState } from "react"
import { Pressable, Text } from "react-native"
import { pickProfile, profileNames, useBoard, useProfile } from "../state/board"
import { colors, radius, space } from "../theme"
import { Icon, Sheet, SheetRow } from "./ui"

// Which profile the app shows (HE-99): its name in the header of the screens that show one profile's things (Tasks,
// Assistant, Docs), which opens the board's profiles to pick another. A board with one profile shows nothing.

export function ProfileButton() {
  const names = useBoard(profileNames)
  const profile = useProfile()
  const [open, setOpen] = useState(false)
  if (names.length < 2 || profile === null) return null
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Profile ${profile}`}
        hitSlop={8}
        onPress={() => setOpen(true)}
        style={({ pressed }) => [
          {
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
            height: 32,
            paddingHorizontal: space.md,
            marginRight: space.md,
            borderRadius: radius.pill,
            backgroundColor: colors.raised,
          },
          pressed && { opacity: 0.7 },
        ]}
      >
        <Icon name="person-circle-outline" size={16} color={colors.muted} />
        <Text style={{ color: colors.fg, fontSize: 14, fontWeight: "600", maxWidth: 120 }} numberOfLines={1}>
          {profile}
        </Text>
        <Icon name="chevron-down" size={12} color={colors.faint} />
      </Pressable>
      {open && (
        <Sheet title="Profile" onClose={() => setOpen(false)}>
          {names.map((name) => (
            <SheetRow
              key={name}
              icon="person-circle-outline"
              label={name}
              selected={name === profile}
              onPress={() => {
                pickProfile(name)
                setOpen(false)
              }}
            />
          ))}
        </Sheet>
      )}
    </>
  )
}
