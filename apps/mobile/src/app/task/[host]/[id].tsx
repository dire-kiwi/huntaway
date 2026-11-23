import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { type HostTask, mutate, optimisticMove, query, STATUSES, taskAtom, unreadInReview } from "@huntaway/client"
import { TaskId } from "@huntaway/contracts"
import { AsyncResult } from "effect/reactivity"
import { Stack, useLocalSearchParams } from "expo-router"
import { useEffect, useState } from "react"
import { KeyboardAvoidingView, Platform, Pressable, Text, View } from "react-native"
import { Composer } from "../../../components/composer"
import { Markdown } from "../../../components/markdown"
import { PluginFrame } from "../../../components/pluginFrame"
import { ThreadView } from "../../../components/thread"
import { Empty, ErrorText, Icon, IconButton, Pill, s, Section, Sheet, SheetRow } from "../../../components/ui"
import { agentNote, statusLabel } from "../../../logic/tasks"
import { runExit, useAction } from "../../../state/action"
import { connectionAtom } from "../../../state/connection"
import { openInBrowser, param } from "../../../state/open"
import { colors, space, STATUS_COLOR, tint } from "../../../theme"

// A task: what it is and where it stands at the top (its status, which moves it; its agent; its pull request), its
// thread, and the composer, whose button also stops the agent. The rest is behind ⋯: start or stop, move, the details
// (description, the agent's todo list, what its plugins show of it: the documents it published), and the ways out to
// the web (HE-99).

const AGENT_COLOR = { working: colors.blue, waiting: colors.muted, idle: colors.muted, queued: colors.faint } as const

/** A pull request's address, short: "#12" of "…/pull/12". */
const prLabel = (url: string): string => {
  const number = /\/pull\/(\d+)/.exec(url)?.[1]
  return number === undefined ? "Pull request" : `PR #${number}`
}

type Open = "actions" | "move" | "details" | null

export default function TaskScreen() {
  const params = useLocalSearchParams()
  const host = param(params["host"])
  const id = param(params["id"])
  const task = useAtomValue(taskAtom({ host_id: host, id }))
  const [{ busy, error }, run] = useAction()
  const [open, setOpen] = useState<Open>(null)
  // Opened in In review, it has been seen there (HE-65); a failed save leaves the mark for the next time.
  const fresh = task !== undefined && unreadInReview(task)
  useEffect(() => {
    if (fresh) runExit(mutate("tasks.update", host, { id: TaskId.make(id), patch: { review_unread: false } }), () => undefined)
  }, [fresh, host, id])
  if (task === undefined)
    return (
      <View style={s.screen}>
        <Stack.Screen options={{ title: "" }} />
        <Empty title="Loading the task…" />
      </View>
    )
  const agent = agentNote(task)
  const checks = task.pr_checks?.outcome
  const done = task.todos.filter((t) => t.status === "completed").length
  const prUrl = task.pr_url
  return (
    <KeyboardAvoidingView style={s.screen} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}>
      <Stack.Screen
        options={{
          title: task.key,
          headerRight: () => <IconButton icon="ellipsis-horizontal" label="More" onPress={() => setOpen("actions")} />,
        }}
      />
      <View style={{ paddingHorizontal: space.lg, paddingBottom: space.md, gap: space.sm, borderBottomWidth: 1, borderBottomColor: colors.line }}>
        <Text style={[s.title, { fontSize: 18, lineHeight: 24 }]} numberOfLines={3}>
          {task.title}
        </Text>
        <View style={[s.wrap, { gap: 6, alignItems: "center" }]}>
          <Pressable accessibilityRole="button" accessibilityLabel={`Status: ${statusLabel(task.status)}. Move`} hitSlop={8} onPress={() => setOpen("move")}>
            <Pill label={statusLabel(task.status)} color={STATUS_COLOR[task.status]} />
          </Pressable>
          {agent !== null && <Pill label={agent.label} color={AGENT_COLOR[agent.state]} busy={agent.state === "working"} icon="time-outline" />}
          {prUrl !== null && (
            <Pressable accessibilityRole="link" accessibilityLabel={prLabel(prUrl)} hitSlop={8} onPress={() => openInBrowser(prUrl)}>
              <Pill
                label={prLabel(prUrl)}
                color={checks === "failed" ? colors.red : checks === "passed" ? colors.green : colors.accent}
                icon={checks === "failed" ? "close-circle-outline" : checks === "passed" ? "checkmark-circle-outline" : "git-pull-request-outline"}
              />
            </Pressable>
          )}
          {task.todos.length > 0 && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Todos: ${done} of ${task.todos.length} done`}
              hitSlop={8}
              onPress={() => setOpen("details")}
            >
              <Pill label={`${done}/${task.todos.length}`} color={colors.muted} icon="checkbox-outline" />
            </Pressable>
          )}
        </View>
        {task.status === "needs_attention" && task.attention_reason !== null && (
          <View style={[s.row, { alignItems: "flex-start", padding: space.sm, borderRadius: 8, backgroundColor: tint(colors.amber, 0.1) }]}>
            <Icon name="alert-circle" size={16} color={colors.amber} />
            <Text style={[s.muted, { flex: 1, color: colors.amber }]}>{task.attention_reason}</Text>
          </View>
        )}
        {error !== null && <ErrorText>{error}</ErrorText>}
      </View>
      <View style={{ flex: 1 }}>
        <ThreadView host={host} task={task} />
      </View>
      <Composer host={host} taskId={id} running={task.running} queued={task.queued_message} inset />
      {open === "actions" && (
        <Sheet title={task.key} onClose={() => setOpen(null)}>
          {task.running ? (
            <SheetRow
              icon="stop-circle-outline"
              label="Stop the agent"
              danger
              disabled={busy}
              onPress={() => {
                setOpen(null)
                run(mutate("tasks.stop", host, { id: TaskId.make(id) }))
              }}
            />
          ) : (
            <SheetRow
              icon="play-circle-outline"
              label="Start the agent"
              disabled={busy}
              onPress={() => {
                setOpen(null)
                // An empty message starts its agent, and moves it to In progress.
                run(mutate("tasks.send", host, { id: TaskId.make(id), text: "" }))
              }}
            />
          )}
          <SheetRow icon="swap-horizontal-outline" label="Move to…" detail={statusLabel(task.status)} onPress={() => setOpen("move")} />
          <SheetRow icon="information-circle-outline" label="Details" detail="Description, todos, documents" onPress={() => setOpen("details")} />
          {prUrl !== null && (
            <SheetRow
              icon="git-pull-request-outline"
              label="Open the pull request"
              detail={prUrl.replace(/^https:\/\/github\.com\//, "")}
              onPress={() => openInBrowser(prUrl)}
            />
          )}
          <OnTheWeb id={id} />
        </Sheet>
      )}
      {open === "move" && <Move host={host} task={task} onClose={() => setOpen(null)} />}
      {open === "details" && <Details host={host} task={task} onClose={() => setOpen(null)} />}
    </KeyboardAvoidingView>
  )
}

/** The task on the board's own web page, for what the phone doesn't do (its changes, its terminal). */
function OnTheWeb({ id }: { readonly id: string }) {
  const connection = useAtomValue(connectionAtom)
  if (connection._tag !== "board") return null
  const url = `${connection.link.url}/t/${id}`
  return <SheetRow icon="open-outline" label="Open on the web" onPress={() => openInBrowser(url)} />
}

function Move({ host, task, onClose }: { readonly host: string; readonly task: HostTask; readonly onClose: () => void }) {
  const move = useAtomSet(optimisticMove({ host_id: host, id: task.id }))
  return (
    <Sheet title="Move to" onClose={onClose}>
      {STATUSES.map((st) => (
        <SheetRow
          key={st.id}
          dot={STATUS_COLOR[st.id]}
          label={st.label}
          selected={st.id === task.status}
          onPress={() => {
            onClose()
            if (st.id !== task.status) move({ status: st.id })
          }}
        />
      ))}
    </Sheet>
  )
}

const TODO_ICON = { pending: "ellipse-outline", in_progress: "ellipsis-horizontal-circle", completed: "checkmark-circle" } as const
const TODO_COLOR = { pending: colors.faint, in_progress: colors.blue, completed: colors.green } as const

function Details({ host, task, onClose }: { readonly host: string; readonly task: HostTask; readonly onClose: () => void }) {
  return (
    <Sheet title="Details" onClose={onClose}>
      <View style={{ paddingHorizontal: space.sm, gap: space.sm }}>
        {task.description.trim() === "" ? <Text style={s.faint}>No description.</Text> : <Markdown text={task.description} />}
        {task.branch !== null && (
          <View style={s.row}>
            <Icon name="git-branch-outline" size={15} />
            <Text style={[s.muted, { flex: 1, fontFamily: "monospace", fontSize: 13 }]} selectable>
              {task.branch}
            </Text>
          </View>
        )}
      </View>
      {task.todos.length > 0 && (
        <>
          <Section title="Todos" count={task.todos.length} />
          <View style={{ paddingHorizontal: space.sm, gap: 6 }}>
            {task.todos.map((todo, i) => (
              <View key={`${i}:${todo.text}`} style={[s.row, { alignItems: "flex-start" }]}>
                <Icon name={TODO_ICON[todo.status]} size={17} color={TODO_COLOR[todo.status]} />
                <Text style={[s.body, { flex: 1 }, todo.status === "completed" && { color: colors.muted, textDecorationLine: "line-through" }]}>
                  {todo.text}
                </Text>
              </View>
            ))}
          </View>
        </>
      )}
      <PluginSections host={host} taskId={task.id} onLeave={onClose} />
    </Sheet>
  )
}

/** What the host's plugins show of the task (docs/plan/15-plugins.md, the `task` slot): the documents it published. */
function PluginSections({ host, taskId, onLeave }: { readonly host: string; readonly taskId: string; readonly onLeave: () => void }) {
  const plugins = useAtomValue(query("plugins.list", host, undefined))
  const shown = AsyncResult.isSuccess(plugins) ? plugins.value.filter((p) => p.task && p.error === null) : []
  return shown.map((p) => <PluginSection key={p.id} host={host} plugin={p.id} name={p.name} taskId={taskId} onLeave={onLeave} />)
}

function PluginSection({
  host,
  plugin,
  name,
  taskId,
  onLeave,
}: {
  readonly host: string
  readonly plugin: string
  readonly name: string
  readonly taskId: string
  readonly onLeave: () => void
}) {
  const [empty, setEmpty] = useState(true)
  return (
    <View>
      {!empty && <Section title={name} />}
      <PluginFrame host={host} page={{ plugin, path: "", search: "" }} slot="task" taskId={taskId} onEmpty={setEmpty} onLeave={onLeave} />
    </View>
  )
}
