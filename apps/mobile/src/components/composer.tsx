import { useAtom, useAtomValue } from "@effect/atom-react"
import { type ComposerDraft, mutate, sendingAtom, sendMessage } from "@huntaway/client"
import { TaskId } from "@huntaway/contracts"
import { Cause } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { errorText, useAction } from "../state/action"
import { colors, radius, space } from "../theme"
import { ErrorText, Icon, s } from "./ui"

// A task's composer: what is typed goes with `sendMessage` (@huntaway/client), which starts the agent's run, steers the
// running one, or is queued. A send outlives the screen that started it, and only what it took comes off the draft, so
// text typed meanwhile stays. The draft is kept per task while the app runs. HE-99: its one button sends what is
// typed, and with nothing typed stops the agent while it runs; a message waiting for the run to end shows above it.

const draftByKey = Atom.family((_key: string) => Atom.make<ComposerDraft | null>(null).pipe(Atom.keepAlive))

export function Composer({
  host,
  taskId,
  running,
  queued = null,
  placeholder = "Message the agent",
  inset = false,
}: {
  readonly host: string
  readonly taskId: string
  /** Its agent is running: with nothing typed, the button stops it. */
  readonly running: boolean
  /** The message that goes to the agent once its run ends, if one waits. */
  readonly queued?: string | null
  readonly placeholder?: string
  /** It is at the bottom of the screen, with nothing under it (no tab bar): it keeps clear of the phone's own edge. */
  readonly inset?: boolean
}) {
  const insets = useSafeAreaInsets()
  const ref = { host_id: host, task_id: taskId }
  const draftAtom = draftByKey(`${host}\u0000${taskId}`)
  const [draft, setDraft] = useAtom(draftAtom)
  const [result, send] = useAtom(sendMessage(ref))
  const sending = useAtomValue(sendingAtom(ref)) > 0
  const [stopping, stop] = useAction()
  const text = draft?.text ?? ""
  const typed = text.trim() !== ""
  const failed = AsyncResult.isFailure(result) && !Cause.hasInterruptsOnly(result.cause) ? errorText(Cause.squash(result.cause)) : null
  const stops = running && !typed
  const go = () => {
    if (stops) return stop(mutate("tasks.stop", host, { id: TaskId.make(taskId) }))
    if (typed) send({ body: text.trim(), sent: text, files: [], draft: draftAtom })
  }
  const busy = sending || stopping.busy
  return (
    <View
      style={{
        borderTopWidth: 1,
        borderTopColor: colors.line,
        backgroundColor: colors.panel,
        paddingHorizontal: space.md,
        paddingTop: space.sm,
        paddingBottom: space.sm + (inset ? insets.bottom : 0),
        gap: 6,
      }}
    >
      {queued !== null && queued !== "" && (
        <View style={s.row}>
          <Icon name="time-outline" size={14} color={colors.faint} />
          <Text style={[s.faint, { flex: 1 }]} numberOfLines={1}>
            Queued: {queued}
          </Text>
        </View>
      )}
      {failed !== null && <ErrorText>{failed}</ErrorText>}
      {stopping.error !== null && <ErrorText>{stopping.error}</ErrorText>}
      <View style={[s.row, { alignItems: "flex-end" }]}>
        <TextInput
          style={[s.input, { flex: 1, minHeight: 44, maxHeight: 140, paddingTop: 11, paddingBottom: 11, borderRadius: 22, paddingHorizontal: space.lg }]}
          multiline
          placeholder={running ? "Steer the agent" : placeholder}
          placeholderTextColor={colors.faint}
          accessibilityLabel={placeholder}
          value={text}
          onChangeText={(t) => setDraft(t === "" ? null : { text: t, files: draft?.files ?? [] })}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={stops ? "Stop the agent" : "Send"}
          accessibilityState={{ disabled: !stops && !typed, busy }}
          disabled={(!stops && !typed) || stopping.busy}
          onPress={go}
          style={({ pressed }) => [
            {
              width: 44,
              height: 44,
              borderRadius: radius.pill,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: stops ? colors.raised : colors.accentStrong,
            },
            stops && { borderWidth: 1, borderColor: colors.lineStrong },
            !stops && !typed && s.disabled,
            pressed && s.pressed,
          ]}
        >
          {busy ? (
            <ActivityIndicator size="small" color={colors.fg} />
          ) : (
            <Icon name={stops ? "stop" : "arrow-up"} size={stops ? 18 : 22} color={stops ? colors.red : colors.fg} />
          )}
        </Pressable>
      </View>
    </View>
  )
}
