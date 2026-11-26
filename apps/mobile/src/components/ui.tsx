import Ionicons from "@expo/vector-icons/Ionicons"
import type { ComponentProps, ReactNode } from "react"
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  type StyleProp,
  StyleSheet,
  Text,
  type TextStyle,
  View,
  type ViewStyle,
} from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { colors, radius, space, tint } from "../theme"

// The app's building blocks (HE-99's redesign): icons, buttons with a thumb's reach, chips, pills, empty and error
// states, sections that fold, and the bottom sheet every menu and form opens in.

export type IconName = ComponentProps<typeof Ionicons>["name"]

export function Icon({
  name,
  size = 18,
  color = colors.muted,
  style,
}: {
  readonly name: IconName
  readonly size?: number
  readonly color?: string
  readonly style?: StyleProp<TextStyle>
}) {
  return <Ionicons name={name} size={size} color={color} style={style} />
}

type ButtonKind = "primary" | "secondary" | "danger" | "ghost"

export function Button({
  title,
  onPress,
  kind = "secondary",
  icon,
  disabled = false,
  busy = false,
  small = false,
  style,
}: {
  readonly title: string
  readonly onPress: () => void
  readonly kind?: ButtonKind
  readonly icon?: IconName
  readonly disabled?: boolean
  readonly busy?: boolean
  readonly small?: boolean
  readonly style?: StyleProp<ViewStyle>
}) {
  const off = disabled || busy
  const color = kind === "danger" ? colors.red : kind === "ghost" ? colors.muted : colors.fg
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: off, busy }}
      disabled={off}
      onPress={onPress}
      style={({ pressed }) => [s.button, small && s.small, s[kind], off && s.disabled, pressed && s.pressed, style]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={colors.fg} />
      ) : (
        <>
          {icon !== undefined && <Icon name={icon} size={small ? 15 : 17} color={color} />}
          <Text style={[s.buttonText, small && { fontSize: 14 }, { color }]}>{title}</Text>
        </>
      )}
    </Pressable>
  )
}

/** A button that is only its icon, with a target a thumb can hit. */
export function IconButton({
  icon,
  label,
  onPress,
  color = colors.fg,
  size = 22,
  disabled = false,
  style,
}: {
  readonly icon: IconName
  readonly label: string
  readonly onPress: () => void
  readonly color?: string
  readonly size?: number
  readonly disabled?: boolean
  readonly style?: StyleProp<ViewStyle>
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [s.iconButton, disabled && s.disabled, pressed && s.pressed, style]}
    >
      <Icon name={icon} size={size} color={color} />
    </Pressable>
  )
}

export function Chip({
  label,
  selected = false,
  onPress,
  color,
  icon,
}: {
  readonly label: string
  readonly selected?: boolean
  readonly onPress?: () => void
  readonly color?: string
  readonly icon?: IconName
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[s.chip, selected && s.chipSelected]}
    >
      {color !== undefined && <View style={[s.dot, { backgroundColor: color }]} />}
      {icon !== undefined && <Icon name={icon} size={14} color={selected ? colors.fg : colors.muted} />}
      <Text style={[s.chipText, selected && s.chipTextSelected]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  )
}

/** A few words on a wash of their colour: a status, an agent's state. */
export function Pill({
  label,
  color,
  icon,
  busy = false,
}: {
  readonly label: string
  readonly color: string
  readonly icon?: IconName
  readonly busy?: boolean
}) {
  return (
    <View style={[s.pill, { backgroundColor: tint(color, 0.14) }]}>
      {busy ? (
        <ActivityIndicator size={10} color={color} />
      ) : icon !== undefined ? (
        <Icon name={icon} size={12} color={color} />
      ) : (
        <View style={[s.dot, { backgroundColor: color }]} />
      )}
      <Text style={[s.pillText, { color }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  )
}

export function Empty({
  title,
  hint,
  icon,
  children,
}: {
  readonly title: string
  readonly hint?: string
  readonly icon?: IconName
  readonly children?: ReactNode
}) {
  return (
    <View style={s.empty}>
      {icon !== undefined && <Icon name={icon} size={36} color={colors.lineStrong} />}
      <Text style={s.emptyTitle}>{title}</Text>
      {hint !== undefined && <Text style={s.emptyHint}>{hint}</Text>}
      {children}
    </View>
  )
}

export function ErrorText({ children }: { readonly children: ReactNode }) {
  return <Text style={s.error}>{children}</Text>
}

/** A list's section heading; with `onPress` it folds, and `open` says which way its chevron points. */
export function Section({
  title,
  count,
  color,
  right,
  open,
  onPress,
}: {
  readonly title: string
  readonly count?: number
  readonly color?: string
  readonly right?: ReactNode
  readonly open?: boolean
  readonly onPress?: () => void
}) {
  const body = (
    <>
      <View style={s.row}>
        {color !== undefined && <View style={[s.dot, { backgroundColor: color }]} />}
        <Text style={s.sectionText}>{title}</Text>
        {count !== undefined && <Text style={s.sectionCount}>{count}</Text>}
      </View>
      {right ?? (open !== undefined && <Icon name={open ? "chevron-down" : "chevron-forward"} size={14} color={colors.faint} />)}
    </>
  )
  if (onPress === undefined) return <View style={s.section}>{body}</View>
  return (
    <Pressable
      style={s.section}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={open === undefined ? {} : { expanded: open }}
      onPress={onPress}
    >
      {body}
    </Pressable>
  )
}

/**
 * A sheet from the bottom of the screen, over what was there: the app's menus, pickers and forms. A tap beside it or
 * the back button closes it. It scrolls when it is taller than the screen leaves it, and stays above the keyboard.
 */
export function Sheet({
  title,
  onClose,
  children,
  footer,
}: {
  readonly title: string
  readonly onClose: () => void
  readonly children: ReactNode
  readonly footer?: ReactNode
}) {
  const insets = useSafeAreaInsets()
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={s.sheetBack}>
        <Pressable style={StyleSheet.absoluteFill} accessibilityLabel="Close" onPress={onClose} />
        <View style={[s.sheet, { paddingBottom: Math.max(insets.bottom, space.lg) }]} accessibilityViewIsModal>
          <View style={s.grabber} />
          <View style={[s.row, { justifyContent: "space-between", paddingHorizontal: space.lg, paddingBottom: space.sm }]}>
            <Text style={s.sheetTitle} accessibilityRole="header">
              {title}
            </Text>
            <IconButton icon="close" label="Close" color={colors.muted} onPress={onClose} />
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: space.sm, gap: 2 }}>
            {children}
          </ScrollView>
          {footer !== undefined && <View style={{ paddingHorizontal: space.lg, paddingTop: space.md }}>{footer}</View>}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}

/** A row of a sheet's menu: an icon or a dot, what it does, and a tick when it is the one chosen. */
export function SheetRow({
  label,
  detail,
  icon,
  dot,
  selected = false,
  danger = false,
  disabled = false,
  onPress,
}: {
  readonly label: string
  readonly detail?: string
  readonly icon?: IconName
  readonly dot?: string
  readonly selected?: boolean
  readonly danger?: boolean
  readonly disabled?: boolean
  readonly onPress: () => void
}) {
  const color = danger ? colors.red : colors.fg
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [s.sheetRow, disabled && s.disabled, pressed && { backgroundColor: colors.raised }]}
    >
      {icon !== undefined && <Icon name={icon} size={20} color={danger ? colors.red : colors.muted} />}
      {dot !== undefined && <View style={[s.dot, { backgroundColor: dot, marginHorizontal: 6 }]} />}
      <View style={{ flex: 1 }}>
        <Text style={[s.body, { color }]} numberOfLines={1}>
          {label}
        </Text>
        {detail !== undefined && (
          <Text style={s.faint} numberOfLines={1}>
            {detail}
          </Text>
        )}
      </View>
      {selected && <Icon name="checkmark" size={18} color={colors.accent} />}
    </Pressable>
  )
}

export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  button: {
    minHeight: 46,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    flexDirection: "row",
    gap: 6,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.line,
  },
  small: { minHeight: 36, paddingHorizontal: space.md, borderRadius: radius.sm },
  primary: { backgroundColor: colors.accentStrong, borderColor: colors.accentStrong },
  secondary: { backgroundColor: colors.raised },
  danger: { backgroundColor: tint(colors.red, 0.1), borderColor: tint(colors.red, 0.3) },
  ghost: { backgroundColor: "transparent", borderColor: "transparent" },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.7 },
  buttonText: { color: colors.fg, fontSize: 15, fontWeight: "600" },
  iconButton: { minWidth: 36, minHeight: 36, alignItems: "center", justifyContent: "center", borderRadius: radius.pill },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: space.md,
    height: 34,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panel,
  },
  chipSelected: { borderColor: colors.accent, backgroundColor: tint(colors.accent, 0.16) },
  chipText: { color: colors.muted, fontSize: 14, maxWidth: 200 },
  chipTextSelected: { color: colors.fg },
  pill: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 8, height: 22, borderRadius: radius.pill, flexShrink: 1 },
  pillText: { fontSize: 12, fontWeight: "600", flexShrink: 1 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  empty: { padding: space.xl * 1.5, alignItems: "center", gap: space.md },
  emptyTitle: { color: colors.muted, fontSize: 16, fontWeight: "600", textAlign: "center" },
  emptyHint: { color: colors.faint, fontSize: 14, textAlign: "center", lineHeight: 20 },
  error: { color: colors.red, fontSize: 14 },
  section: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.sm,
    minHeight: 44,
  },
  sectionText: { color: colors.muted, fontSize: 13, fontWeight: "700" },
  sectionCount: { color: colors.faint, fontSize: 13 },
  card: {
    marginHorizontal: space.md,
    marginVertical: 4,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.line,
    gap: 6,
  },
  row: { flexDirection: "row", alignItems: "center", gap: space.sm },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  title: { color: colors.fg, fontSize: 16, fontWeight: "600", lineHeight: 21 },
  body: { color: colors.fg, fontSize: 15, lineHeight: 21 },
  muted: { color: colors.muted, fontSize: 14, lineHeight: 19 },
  faint: { color: colors.faint, fontSize: 12 },
  input: {
    minHeight: 46,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panel2,
    color: colors.fg,
    paddingHorizontal: space.md,
    fontSize: 16,
  },
  label: { color: colors.muted, fontSize: 13, fontWeight: "600" },
  sheetBack: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.55)" },
  sheet: {
    maxHeight: "88%",
    backgroundColor: colors.panel,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderTopWidth: 1,
    borderColor: colors.line,
    paddingTop: space.sm,
  },
  grabber: { alignSelf: "center", width: 36, height: 4, borderRadius: 2, backgroundColor: colors.lineStrong, marginBottom: space.sm },
  sheetTitle: { color: colors.fg, fontSize: 17, fontWeight: "700" },
  sheetRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 48,
    paddingHorizontal: space.sm,
    paddingVertical: 6,
    borderRadius: radius.sm,
  },
})
