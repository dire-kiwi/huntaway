import { type HostTask, mutate } from "@huntaway/client"
import { ProjectId } from "@huntaway/contracts"
import { Exit } from "effect"
import { router, Stack, useLocalSearchParams } from "expo-router"
import { useMemo, useState } from "react"
import { KeyboardAvoidingView, Modal, Platform, Pressable, SectionList, Switch, Text, TextInput, View } from "react-native"
import { Button, Empty, ErrorText, s, Section } from "../../../components/ui"
import { agentState, groupTasks } from "../../../logic/tasks"
import { useAction } from "../../../state/action"
import { useBoard } from "../../../state/board"
import { colors, STATUS_COLOR } from "../../../theme"

// A project's tasks, by status (what needs the user first), live from the board, and a new task.

const param = (v: string | ReadonlyArray<string> | undefined): string => (typeof v === "string" ? v : (v?.[0] ?? ""))

export default function ProjectScreen() {
  const params = useLocalSearchParams()
  const host = param(params["host"])
  const id = param(params["id"])
  const project = useBoard((b) => b.projects.find((p) => p.host_id === host && p.id === id))
  const tasks = useBoard((b) => b.tasks)
  const [adding, setAdding] = useState(false)
  const sections = useMemo(
    () =>
      groupTasks(Object.values(tasks).filter((t) => t.host_id === host && t.project_id === id)).map((g) => ({
        title: g.label,
        data: [...g.tasks],
      })),
    [tasks, host, id],
  )
  return (
    <View style={s.screen}>
      <Stack.Screen
        options={{
          title: project?.name ?? "Project",
          headerRight: () => <Button title="New task" small kind="primary" onPress={() => setAdding(true)} />,
        }}
      />
      <SectionList
        sections={sections}
        keyExtractor={(t) => t.id}
        ListEmptyComponent={<Empty title={project === undefined ? "This project isn't on the board." : "No tasks yet."} />}
        renderSectionHeader={({ section }) => <Section title={`${section.title} · ${section.data.length}`} />}
        stickySectionHeadersEnabled={false}
        renderItem={({ item }) => <TaskRow task={item} />}
      />
      {adding && <NewTask host={host} projectId={id} onClose={() => setAdding(false)} />}
    </View>
  )
}

function TaskRow({ task: t }: { readonly task: HostTask }) {
  const agent = agentState(t)
  return (
    <Pressable style={s.card} accessibilityRole="link" onPress={() => router.push({ pathname: "/task/[host]/[id]", params: { host: t.host_id, id: t.id } })}>
      <View style={s.row}>
        <View style={[s.dot, { backgroundColor: STATUS_COLOR[t.status] }]} />
        <Text style={s.faint}>{t.key}</Text>
        {agent !== null && <Text style={[s.faint, { color: colors.blue }]}>{agent}</Text>}
      </View>
      <Text style={s.title} numberOfLines={2}>
        {t.title}
      </Text>
      {t.status === "needs_attention" && t.attention_reason !== null && (
        <Text style={s.muted} numberOfLines={2}>
          {t.attention_reason}
        </Text>
      )}
    </Pressable>
  )
}

function NewTask({ host, projectId, onClose }: { readonly host: string; readonly projectId: string; readonly onClose: () => void }) {
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [start, setStart] = useState(true)
  const [{ busy, error }, run] = useAction()
  const create = () =>
    void run(
      mutate("tasks.create", host, {
        task: {
          project_id: ProjectId.make(projectId),
          // With no title, the board writes one from the description.
          ...(title.trim() === "" ? {} : { title: title.trim() }),
          description: description.trim(),
          status: start ? "in_progress" : "todo",
          ...(start ? { start: true } : {}),
        },
      }),
    ).then((exit) => {
      if (Exit.isFailure(exit)) return
      onClose()
      router.push({ pathname: "/task/[host]/[id]", params: { host, id: exit.value.id } })
    })
  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.5)" }}
      >
        <View style={{ backgroundColor: colors.panel, padding: 16, gap: 12, borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingBottom: 32 }}>
          <Text style={[s.title, { fontSize: 17 }]}>New task</Text>
          <TextInput style={s.input} value={title} onChangeText={setTitle} placeholder="Title (optional)" placeholderTextColor={colors.faint} />
          <TextInput
            style={[s.input, { minHeight: 120, textAlignVertical: "top", paddingTop: 10 }]}
            value={description}
            onChangeText={setDescription}
            placeholder="What should the agent do?"
            placeholderTextColor={colors.faint}
            multiline
            autoFocus
          />
          <View style={s.row}>
            <Switch
              value={start}
              onValueChange={setStart}
              trackColor={{ true: colors.accentStrong, false: colors.line }}
              accessibilityLabel="Start its agent now"
            />
            <Text style={s.muted}>Start its agent now</Text>
          </View>
          {error !== null && <ErrorText>{error}</ErrorText>}
          <View style={[s.row, { justifyContent: "flex-end" }]}>
            <Button title="Cancel" kind="ghost" onPress={onClose} />
            <Button
              title={start ? "Create and start" : "Create"}
              kind="primary"
              busy={busy}
              disabled={title.trim() === "" && description.trim() === ""}
              onPress={create}
            />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}
