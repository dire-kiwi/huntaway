import { useAtom, useAtomValue } from "@effect/atom-react"
import { type ComposerDraft, sendingAtom, sendMessage } from "@huntaway/client"
import { Atom, AsyncResult } from "effect/reactivity"
import { Cause } from "effect"
import { Pressable, Text, TextInput, View } from "react-native"
import { errorText } from "../state/action"
import { colors } from "../theme"
import { ErrorText, s } from "./ui"

// A task's composer: what is typed goes with `sendMessage` (@huntaway/client), which starts the agent's run, steers the
// running one, or is queued. A send outlives the screen that started it, and only what it took comes off the draft, so
// text typed meanwhile stays. The draft is kept per task while the app runs. While the agent is in a turn it would
// steer, Queue sends it once the turn is over instead (HE-113).

const draftByKey = Atom.family((_key: string) => Atom.make<ComposerDraft | null>(null).pipe(Atom.keepAlive))

export function Composer({
  host,
  taskId,
  placeholder = "Message the agent",
  queueable = false,
}: {
  readonly host: string
  readonly taskId: string
  readonly placeholder?: string
  /** The agent is in a turn a message steers: Queue holds one for the turn's end. */
  readonly queueable?: boolean
}) {
  const ref = { host_id: host, task_id: taskId }
  const draftAtom = draftByKey(`${host}\u0000${taskId}`)
  const [draft, setDraft] = useAtom(draftAtom)
  const [result, send] = useAtom(sendMessage(ref))
  const sending = useAtomValue(sendingAtom(ref)) > 0
  const text = draft?.text ?? ""
  const failed = AsyncResult.isFailure(result) && !Cause.hasInterruptsOnly(result.cause) ? errorText(Cause.squash(result.cause)) : null
  const go = (queue = false) => {
    const sent = text.trim()
    if (sent === "") return
    send({ body: sent, sent: text, files: [], draft: draftAtom, queue })
  }
  const button = (pressed: boolean, primary: boolean) => [
    { height: 44, paddingHorizontal: 16, borderRadius: 8, backgroundColor: primary ? colors.accentStrong : colors.raised, justifyContent: "center" as const },
    text.trim() === "" && s.disabled,
    pressed && s.pressed,
  ]
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.panel, padding: 8, gap: 6 }}>
      {failed !== null && <ErrorText>{failed}</ErrorText>}
      <View style={[s.row, { alignItems: "flex-end" }]}>
        <TextInput
          style={[s.input, { flex: 1, minHeight: 44, maxHeight: 140, paddingTop: 11, paddingBottom: 11 }]}
          multiline
          placeholder={placeholder}
          placeholderTextColor={colors.faint}
          value={text}
          onChangeText={(t) => setDraft(t === "" ? null : { text: t, files: draft?.files ?? [] })}
        />
        {queueable && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Queue for when the agent finishes its turn"
            disabled={text.trim() === "" || sending}
            onPress={() => go(true)}
            style={({ pressed }) => button(pressed, false)}
          >
            <Text style={s.buttonText}>Queue</Text>
          </Pressable>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send"
          disabled={text.trim() === ""}
          onPress={() => go()}
          style={({ pressed }) => button(pressed, true)}
        >
          <Text style={s.buttonText}>{sending ? "Sending…" : "Send"}</Text>
        </Pressable>
      </View>
    </View>
  )
}
