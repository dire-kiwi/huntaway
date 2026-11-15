import { useAtomValue } from "@effect/atom-react"
import { boardHosts, mutate, query, QUESTION_TOOLS } from "@huntaway/client"
import { RequestId } from "@huntaway/contracts"
import { AsyncResult, Atom } from "effect/reactivity"
import { router } from "expo-router"
import { FlatList, Pressable, Text, View } from "react-native"
import { Button, Empty, ErrorText, s } from "../../components/ui"
import { type HostPrompts, type InboxItem, inboxItems } from "../../logic/inbox"
import { shortToolName } from "../../logic/thread"
import { useAction } from "../../state/action"
import { useBoard } from "../../state/board"
import { colors, STATUS_COLOR } from "../../theme"
import { boardAtom } from "@huntaway/client"

// The Inbox: what waits on the user across the board's hosts. Prompts (Allow or Deny here; questions and plans open
// their task) and the tasks in Needs attention. Prompts are no board event, so they are read again every few seconds
// while the Inbox shows.

const PROMPTS_EVERY = "5 seconds"

const noPrompts: HostPrompts["prompts"] = []

/** Every usable host's pending prompts, as each last answered. */
const promptsAtom = Atom.make((get): ReadonlyArray<HostPrompts> =>
  boardHosts(get(boardAtom).hosts).map((h) => ({
    host_id: h.id,
    prompts: AsyncResult.getOrElse(get(query("permissions.pending", h.id, {}, { refresh: PROMPTS_EVERY })), () => noPrompts),
  })),
)

const openTask = (host: string, id: string) => router.push({ pathname: "/task/[host]/[id]", params: { host, id } })

function PromptCard({ item }: { readonly item: Extract<InboxItem, { type: "prompt" }> }) {
  const [{ busy, error }, run] = useAction()
  const { prompt, task, host_id } = item
  // A question or a plan has its own card in the thread.
  const answersHere = !QUESTION_TOOLS.includes(prompt.tool_name) && prompt.tool_name !== "ExitPlanMode"
  const decide = (decision: "allow" | "deny") => run(mutate("permissions.answer", host_id, { id: RequestId.make(prompt.id), answer: { decision } }))
  return (
    <Pressable style={[s.card, { borderColor: colors.amber }]} onPress={() => openTask(host_id, prompt.task_id)}>
      <Text style={s.faint}>{task === undefined ? prompt.task_id : `${task.key} · ${task.title}`}</Text>
      <Text style={s.title}>{answersHere ? `Allow ${shortToolName(prompt.tool_name)}?` : "A question for you"}</Text>
      {answersHere ? (
        <View style={s.row}>
          <Button title="Allow" kind="primary" small busy={busy} onPress={() => decide("allow")} />
          <Button title="Deny" kind="danger" small disabled={busy} onPress={() => decide("deny")} />
        </View>
      ) : (
        <Button title="Answer" small onPress={() => openTask(host_id, prompt.task_id)} />
      )}
      {error !== null && <ErrorText>{error}</ErrorText>}
    </Pressable>
  )
}

function AttentionCard({ item }: { readonly item: Extract<InboxItem, { type: "attention" }> }) {
  const { task } = item
  return (
    <Pressable style={s.card} accessibilityRole="link" onPress={() => openTask(task.host_id, task.id)}>
      <View style={s.row}>
        <View style={[s.dot, { backgroundColor: STATUS_COLOR[task.status] }]} />
        <Text style={s.faint}>{task.key}</Text>
      </View>
      <Text style={s.title} numberOfLines={2}>
        {task.title}
      </Text>
      {task.attention_reason !== null && (
        <Text style={s.muted} numberOfLines={3}>
          {task.attention_reason}
        </Text>
      )}
    </Pressable>
  )
}

export default function InboxScreen() {
  const tasks = useBoard((b) => b.tasks)
  const loaded = useBoard((b) => b.loaded)
  const prompts = useAtomValue(promptsAtom)
  const items = inboxItems(Object.values(tasks), prompts)
  return (
    <FlatList
      style={s.screen}
      data={items}
      keyExtractor={(it) => it.key}
      ListEmptyComponent={<Empty title={loaded ? "Nothing waits on you." : "Loading the board…"} />}
      renderItem={({ item }) => (item.type === "prompt" ? <PromptCard item={item} /> : <AttentionCard item={item} />)}
    />
  )
}
