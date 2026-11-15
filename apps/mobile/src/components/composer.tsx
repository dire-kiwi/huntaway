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
// text typed meanwhile stays. The draft is kept per task while the app runs.

const draftByKey = Atom.family((_key: string) => Atom.make<ComposerDraft | null>(null).pipe(Atom.keepAlive))

export function Composer({
  host,
  taskId,
  placeholder = "Message the agent",
}: {
  readonly host: string
  readonly taskId: string
  readonly placeholder?: string
}) {
  const ref = { host_id: host, task_id: taskId }
  const draftAtom = draftByKey(`${host}\u0000${taskId}`)
  const [draft, setDraft] = useAtom(draftAtom)
  const [result, send] = useAtom(sendMessage(ref))
  const sending = useAtomValue(sendingAtom(ref)) > 0
  const text = draft?.text ?? ""
  const failed = AsyncResult.isFailure(result) && !Cause.hasInterruptsOnly(result.cause) ? errorText(Cause.squash(result.cause)) : null
  const go = () => {
    const sent = text.trim()
    if (sent === "") return
    send({ body: sent, sent: text, files: [], draft: draftAtom })
  }
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
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send"
          disabled={text.trim() === ""}
          onPress={go}
          style={({ pressed }) => [
            { height: 44, paddingHorizontal: 16, borderRadius: 8, backgroundColor: colors.accentStrong, justifyContent: "center" },
            text.trim() === "" && s.disabled,
            pressed && s.pressed,
          ]}
        >
          <Text style={s.buttonText}>{sending ? "Sending…" : "Send"}</Text>
        </Pressable>
      </View>
    </View>
  )
}
