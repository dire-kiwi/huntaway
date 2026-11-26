import { useAtomValue } from "@effect/atom-react"
import { agentWorking, mutate, QUESTION_TOOLS } from "@huntaway/client"
import { RequestId } from "@huntaway/contracts"
import { router } from "expo-router"
import { useMemo } from "react"
import { Pressable, SectionList, Text, View } from "react-native"
import { TaskCard } from "../../components/taskCard"
import { Button, Empty, ErrorText, Icon, s, Section } from "../../components/ui"
import { type InboxItem, needsAnswer } from "../../logic/inbox"
import { inputText, shortToolName } from "../../logic/thread"
import { useAction } from "../../state/action"
import { useBoard } from "../../state/board"
import { useNow } from "../../state/clock"
import { inboxAtom } from "../../state/inbox"
import { openTask } from "../../state/open"
import { colors, space, tint } from "../../theme"

// The Inbox: what waits on the user across the board's hosts (state/inbox.ts). First what waits on an answer: prompts
// (Allow or Deny here; questions and plans open their task) and the tasks in Needs attention. Then what waits on a look:
// the tasks new in In review (HE-99). Above them, how many agents are at work.

function PromptCard({ item }: { readonly item: Extract<InboxItem, { type: "prompt" }> }) {
  const [{ busy, error }, run] = useAction()
  const { prompt, task, host_id } = item
  // A question or a plan has its own card in the thread.
  const answersHere = !QUESTION_TOOLS.includes(prompt.tool_name) && prompt.tool_name !== "ExitPlanMode"
  const decide = (decision: "allow" | "deny") => run(mutate("permissions.answer", host_id, { id: RequestId.make(prompt.id), answer: { decision } }))
  const said = answersHere ? inputText(prompt.input) : ""
  return (
    <Pressable
      style={[s.card, { borderColor: tint(colors.amber, 0.6) }]}
      accessibilityRole="link"
      accessibilityLabel={task === undefined ? "A prompt" : `${task.key} ${task.title}`}
      onPress={() => openTask(host_id, prompt.task_id)}
    >
      <Text style={s.faint} numberOfLines={1}>
        {task === undefined ? prompt.task_id : `${task.key} · ${task.title}`}
      </Text>
      <View style={s.row}>
        <Icon name={answersHere ? "shield-half-outline" : "help-circle-outline"} size={18} color={colors.amber} />
        <Text style={[s.title, { flex: 1 }]}>
          {answersHere ? `Allow ${shortToolName(prompt.tool_name)}?` : prompt.tool_name === "ExitPlanMode" ? "A plan to approve" : "A question for you"}
        </Text>
      </View>
      {said !== "" && (
        <Text style={[s.muted, { fontFamily: "monospace", fontSize: 13 }]} numberOfLines={3}>
          {said}
        </Text>
      )}
      {answersHere ? (
        <View style={[s.row, { paddingTop: 2 }]}>
          <Button title="Allow" kind="primary" icon="checkmark" busy={busy} style={{ flex: 1 }} onPress={() => decide("allow")} />
          <Button title="Deny" kind="danger" icon="close" disabled={busy} style={{ flex: 1 }} onPress={() => decide("deny")} />
        </View>
      ) : (
        <Button title="Open to answer" icon="chatbubble-ellipses-outline" onPress={() => openTask(host_id, prompt.task_id)} />
      )}
      {error !== null && <ErrorText>{error}</ErrorText>}
    </Pressable>
  )
}

/** How many agents are at work, which takes you to them. */
function Working() {
  const working = useBoard((b) => Object.values(b.tasks).filter((t) => t.kind === "task" && agentWorking(t)).length)
  if (working === 0) return null
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`${working} ${working === 1 ? "agent" : "agents"} working`}
      onPress={() => router.navigate("/tasks")}
      style={({ pressed }) => [s.row, { marginHorizontal: space.md, marginBottom: space.xs, paddingHorizontal: space.md, height: 44 }, pressed && s.pressed]}
    >
      <Icon name="pulse" size={18} color={colors.blue} />
      <Text style={[s.muted, { flex: 1 }]}>
        {working} {working === 1 ? "agent" : "agents"} working
      </Text>
      <Icon name="chevron-forward" size={15} color={colors.faint} />
    </Pressable>
  )
}

export default function InboxScreen() {
  const loaded = useBoard((b) => b.loaded)
  const projects = useBoard((b) => b.projects)
  const items = useAtomValue(inboxAtom)
  const now = useNow(60_000)
  const names = useMemo(() => new Map(projects.map((p) => [`${p.host_id}/${p.id}`, p.name])), [projects])
  const sections = useMemo(
    () =>
      [
        { title: "Waiting on you", data: items.filter(needsAnswer) },
        { title: "New in review", data: items.filter((it) => !needsAnswer(it)) },
      ].filter((section) => section.data.length > 0),
    [items],
  )
  return (
    <SectionList
      style={s.screen}
      sections={sections}
      keyExtractor={(it) => it.key}
      stickySectionHeadersEnabled={false}
      contentContainerStyle={{ paddingBottom: space.xl, flexGrow: 1 }}
      ListHeaderComponent={<Working />}
      ListEmptyComponent={
        loaded ? (
          <Empty icon="checkmark-circle-outline" title="Nothing waits on you." hint="Prompts, questions and finished work show here." />
        ) : (
          <Empty title="Loading the board…" />
        )
      }
      renderSectionHeader={({ section }) => <Section title={section.title} count={section.data.length} />}
      renderItem={({ item }) =>
        item.type === "prompt" ? (
          <PromptCard item={item} />
        ) : (
          <TaskCard task={item.task} project={names.get(`${item.task.host_id}/${item.task.project_id}`)} now={now} />
        )
      }
    />
  )
}
