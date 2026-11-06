// The app's small building blocks: buttons, chips, the board label, empty and error states.
import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { colors } from "./theme";

export function Button({
  title,
  onPress,
  kind = "secondary",
  disabled,
  busy,
  small,
  style,
}: {
  title: string;
  onPress: () => void;
  kind?: "primary" | "secondary" | "danger" | "ghost";
  disabled?: boolean;
  busy?: boolean;
  small?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [s.button, small && s.small, s[kind], (disabled || busy) && s.disabled, pressed && s.pressed, style]}
    >
      {busy ? <ActivityIndicator size="small" color={colors.fg} /> : <Text style={[s.buttonText, kind === "danger" && { color: colors.red }]}>{title}</Text>}
    </Pressable>
  );
}

export function Chip({ label, selected, onPress, color }: { label: string; selected?: boolean; onPress?: () => void; color?: string }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress} style={[s.chip, selected && s.chipSelected]}>
      {color && <View style={[s.dot, { backgroundColor: color }]} />}
      <Text style={[s.chipText, selected && { color: colors.fg }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/** Which board an item is from. */
export function BoardLabel({ name }: { name: string }) {
  return (
    <View style={s.boardLabel}>
      <Text style={s.boardLabelText} numberOfLines={1}>
        {name}
      </Text>
    </View>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <View style={s.empty}>
      <Text style={s.emptyTitle}>{title}</Text>
      {children}
    </View>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  return <Text style={s.error}>{children}</Text>;
}

export function Section({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <View style={s.section}>
      <Text style={s.sectionText}>{title}</Text>
      {right}
    </View>
  );
}

export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  button: { minHeight: 44, paddingHorizontal: 16, borderRadius: 8, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.line },
  small: { minHeight: 34, paddingHorizontal: 12 },
  primary: { backgroundColor: colors.accentStrong, borderColor: colors.accentStrong },
  secondary: { backgroundColor: colors.raised },
  danger: { backgroundColor: "rgba(248,113,113,0.1)", borderColor: "rgba(248,113,113,0.3)" },
  ghost: { backgroundColor: "transparent", borderColor: "transparent" },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.75 },
  buttonText: { color: colors.fg, fontSize: 15, fontWeight: "600" },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panel,
  },
  chipSelected: { borderColor: colors.accent, backgroundColor: "rgba(139,124,246,0.15)" },
  chipText: { color: colors.muted, fontSize: 14, maxWidth: 180 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  boardLabel: {
    alignSelf: "flex-start",
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
    backgroundColor: colors.raised,
    borderWidth: 1,
    borderColor: colors.line,
  },
  boardLabelText: { color: colors.muted, fontSize: 11, fontWeight: "600", maxWidth: 160 },
  empty: { padding: 32, alignItems: "center", gap: 12 },
  emptyTitle: { color: colors.muted, fontSize: 15, textAlign: "center" },
  error: { color: colors.red, fontSize: 14 },
  section: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingTop: 18, paddingBottom: 6 },
  sectionText: { color: colors.faint, fontSize: 12, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.6 },
  card: {
    marginHorizontal: 12,
    marginVertical: 5,
    padding: 12,
    borderRadius: 10,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.line,
    gap: 6,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { color: colors.fg, fontSize: 15, fontWeight: "600" },
  muted: { color: colors.muted, fontSize: 14 },
  faint: { color: colors.faint, fontSize: 12 },
  input: {
    minHeight: 44,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panel,
    color: colors.fg,
    paddingHorizontal: 12,
    fontSize: 15,
  },
});
