import { ActivityIndicator, Pressable, type StyleProp, type ViewStyle } from "react-native"
import type { Dictation } from "../state/dictation"
import { colors, radius, tint } from "../theme"
import { Icon, s } from "./ui"

// A text field's microphone (HE-99, state/dictation.ts): a tap dictates after what the field holds, another stops.
// Red while the phone listens; not there at all on a phone that can't recognise speech.

export function MicButton({
  dictation,
  text,
  size = 44,
  style,
}: {
  readonly dictation: Dictation
  /** What the field holds: what is heard goes after it. */
  readonly text: string
  readonly size?: number
  readonly style?: StyleProp<ViewStyle>
}) {
  if (!dictation.available) return null
  const on = dictation.phase !== null
  const busy = dictation.phase === "starting" || dictation.phase === "stopping"
  const color = on ? colors.red : colors.muted
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={on ? "Stop dictating" : "Dictate"}
      accessibilityState={{ busy, selected: on }}
      hitSlop={4}
      onPress={() => dictation.toggle(text)}
      style={({ pressed }) => [
        {
          width: size,
          height: size,
          borderRadius: radius.pill,
          alignItems: "center",
          justifyContent: "center",
          borderWidth: 1,
          backgroundColor: on ? tint(colors.red, 0.16) : colors.raised,
          borderColor: on ? tint(colors.red, 0.7) : colors.lineStrong,
        },
        pressed && s.pressed,
        style,
      ]}
    >
      {busy ? <ActivityIndicator size="small" color={color} /> : <Icon name={on ? "mic" : "mic-outline"} size={size >= 44 ? 20 : 18} color={color} />}
    </Pressable>
  )
}
