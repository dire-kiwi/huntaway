import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { mutate, optimisticMove, STATUSES, taskAtom, unreadInReview } from "@huntaway/client"
import { TaskId } from "@huntaway/contracts"
import { Stack, useLocalSearchParams } from "expo-router"
import { useEffect, useState } from "react"
import { KeyboardAvoidingView, Linking, Modal, Platform, Pressable, Text, View } from "react-native"
import { Composer } from "../../../components/composer"
import { ThreadView } from "../../../components/thread"
import { Button, Empty, ErrorText, s } from "../../../components/ui"
import { agentState, statusLabel } from "../../../logic/tasks"
import { runExit, useAction } from "../../../state/action"
import { colors, STATUS_COLOR } from "../../../theme"

// A task: its status, its agent, its pull request, Stop / Start / Move, its thread and the composer.

const param = (v: string | ReadonlyArray<string> | undefined): string => (typeof v === "string" ? v : (v?.[0] ?? ""))

export default function TaskScreen() {
  const params = useLocalSearchParams()
  const host = param(params["host"])
  const id = param(params["id"])
  const task = useAtomValue(taskAtom({ host_id: host, id }))
  const move = useAtomSet(optimisticMove({ host_id: host, id }))
  const [{ busy, error }, run] = useAction()
  const [moving, setMoving] = useState(false)
  // Opened in In review, it has been seen there (HE-65); a failed save leaves the mark for the next time.
  const fresh = task !== undefined && unreadInReview(task)
  useEffect(() => {
    if (fresh) runExit(mutate("tasks.update", host, { id: TaskId.make(id), patch: { review_unread: false } }), () => undefined)
  }, [fresh, host, id])
  if (task === undefined)
    return (
      <View style={s.screen}>
        <Stack.Screen options={{ title: "Task" }} />
        <Empty title="Loading the task…" />
      </View>
    )
  const agent = agentState(task)
  const stop = () => run(mutate("tasks.stop", host, { id: TaskId.make(id) }))
  // An empty message starts its agent, and moves it to In progress.
  const start = () => run(mutate("tasks.send", host, { id: TaskId.make(id), text: "" }))
  return (
    <KeyboardAvoidingView style={s.screen} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}>
      <Stack.Screen
        options={{
          title: task.key,
          headerRight: () => (
            <View style={s.row}>
              {task.running ? (
                <Button title="Stop" small kind="danger" busy={busy} onPress={stop} />
              ) : (
                <Button title="Start" small busy={busy} onPress={start} />
              )}
              <Button title="Move" small onPress={() => setMoving(true)} />
            </View>
          ),
        }}
      />
      <View style={{ padding: 12, gap: 4, borderBottomWidth: 1, borderBottomColor: colors.line, backgroundColor: colors.panel }}>
        <Text style={s.title} numberOfLines={2}>
          {task.title}
        </Text>
        <View style={s.row}>
          <View style={[s.dot, { backgroundColor: STATUS_COLOR[task.status] }]} />
          <Text style={s.muted}>{statusLabel(task.status)}</Text>
          {agent !== null && <Text style={[s.faint, { color: colors.blue }]}>{agent}</Text>}
        </View>
        {task.status === "needs_attention" && task.attention_reason !== null && <Text style={[s.muted, { color: colors.amber }]}>{task.attention_reason}</Text>}
        {task.pr_url !== null && (
          <Text style={[s.faint, { color: colors.accent }]} onPress={() => task.pr_url !== null && void Linking.openURL(task.pr_url)}>
            {task.pr_url.replace(/^https:\/\/github\.com\//, "")}
          </Text>
        )}
        {error !== null && <ErrorText>{error}</ErrorText>}
      </View>
      <View style={{ flex: 1 }}>
        <ThreadView host={host} task={task} />
      </View>
      <Composer host={host} taskId={id} />
      {moving && (
        <Modal visible transparent animationType="fade" onRequestClose={() => setMoving(false)}>
          <Pressable style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.5)" }} onPress={() => setMoving(false)}>
            <View style={{ backgroundColor: colors.panel, padding: 12, paddingBottom: 32, borderTopLeftRadius: 16, borderTopRightRadius: 16, gap: 4 }}>
              <Text style={[s.title, { padding: 8 }]}>Move to</Text>
              {STATUSES.map((st) => (
                <Pressable
                  key={st.id}
                  accessibilityRole="button"
                  style={({ pressed }) => [s.row, { padding: 12, borderRadius: 8 }, pressed && { backgroundColor: colors.raised }]}
                  onPress={() => {
                    setMoving(false)
                    if (st.id !== task.status) move({ status: st.id })
                  }}
                >
                  <View style={[s.dot, { backgroundColor: STATUS_COLOR[st.id] }]} />
                  <Text style={[s.body, st.id === task.status && { color: colors.accent }]}>{st.label}</Text>
                </Pressable>
              ))}
            </View>
          </Pressable>
        </Modal>
      )}
    </KeyboardAvoidingView>
  )
}
