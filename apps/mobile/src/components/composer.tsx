import { useAtom, useAtomValue } from "@effect/atom-react"
import { type ComposerDraft, mutate, sendingAtom, sendMessage } from "@huntaway/client"
import { TaskId } from "@huntaway/contracts"
import { Cause, Effect } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { useEffect, useState } from "react"
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { errorText, runExit, useAction } from "../state/action"
import { useDictation } from "../state/dictation"
import { colors, radius, space } from "../theme"
import { MicButton } from "./mic"
import { ErrorText, Icon, s } from "./ui"

// A task's composer: what is typed goes with `sendMessage` (@huntaway/client), which starts the agent's run, steers the
// running one, or is queued. A send outlives the screen that started it, and only what it took comes off the draft, so
// text typed meanwhile stays. The draft is kept per task while the app runs. HE-99: its one button sends what is
// typed, and with nothing typed stops the agent while it runs; a message waiting for the run to end shows above it.
// The button never turns from Send into Stop under a thumb: it does nothing while a message is on its way, and stays
// Send (with nothing to send) for a moment after, so a second tap meant for Send can't stop the agent just messaged or
// send the message twice.
// Its microphone dictates into the field with the phone's speech recognition (state/dictation.ts).

/** How long after a message went the button waits before it can be Stop. */
const STOP_AFTER_SEND = "1 second"

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
  const write = (t: string) => setDraft((was) => (t === "" ? null : { text: t, files: was?.files ?? [] }))
  const dictation = useDictation(write)
  const typed = text.trim() !== ""
  const failed = AsyncResult.isFailure(result) && !Cause.hasInterruptsOnly(result.cause) ? errorText(Cause.squash(result.cause)) : null
  // A message was sent from here, and the moment after it hasn't passed.
  const [sent, setSent] = useState(false)
  useEffect(() => {
    if (!sent || sending) return undefined
    let shown = true
    runExit(Effect.sleep(STOP_AFTER_SEND), () => {
      if (shown) setSent(false)
    })
    return () => {
      shown = false
    }
  }, [sent, sending])
  const stops = running && !typed && !sending && !sent
  const sends = typed && !sending
  const go = () => {
    if (stops) return stop(mutate("tasks.stop", host, { id: TaskId.make(taskId) }))
    // What is sent is what the field holds now: words still on their way would land in the next message.
    dictation.drop()
    if (!sends) return
    setSent(true)
    send({ body: text.trim(), sent: text, files: [], draft: draftAtom })
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
      {dictation.error !== null && <ErrorText>{dictation.error}</ErrorText>}
      <View style={[s.row, { alignItems: "flex-end" }]}>
        <TextInput
          style={[s.input, { flex: 1, minHeight: 44, maxHeight: 140, paddingTop: 11, paddingBottom: 11, borderRadius: 22, paddingHorizontal: space.lg }]}
          multiline
          placeholder={dictation.phase === "listening" ? "Listening…" : running ? "Steer the agent" : placeholder}
          placeholderTextColor={colors.faint}
          accessibilityLabel={placeholder}
          value={text}
          onChangeText={(t) => {
            dictation.edited(t)
            write(t)
          }}
        />
        <MicButton dictation={dictation} text={text} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={stops ? "Stop the agent" : "Send"}
          accessibilityState={{ disabled: !stops && !sends, busy }}
          disabled={(!stops && !sends) || stopping.busy}
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
            !stops && !sends && s.disabled,
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
