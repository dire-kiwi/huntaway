import { type HostProject, mutate } from "@huntaway/client"
import { ProjectId } from "@huntaway/contracts"
import { Exit } from "effect"
import { useState } from "react"
import { ScrollView, Switch, Text, TextInput, View } from "react-native"
import { useAction } from "../state/action"
import { openTask } from "../state/open"
import { colors, space } from "../theme"
import { Button, Chip, ErrorText, s, Sheet } from "./ui"

// A new task (HE-99: from the Tasks tab, for any of the profile's projects): what the agent should do, in which
// project, and whether it starts now. Made, it opens.

export function NewTask({
  projects,
  initial,
  onClose,
}: {
  /** The projects it may go in. */
  readonly projects: ReadonlyArray<HostProject>
  /** The one the list shows, if it shows one. */
  readonly initial: HostProject | undefined
  readonly onClose: () => void
}) {
  const [project, setProject] = useState<HostProject | undefined>(initial ?? (projects.length === 1 ? projects[0] : undefined))
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [start, setStart] = useState(true)
  const [{ busy, error }, run] = useAction()
  const create = () => {
    if (project === undefined) return
    const host = project.host_id
    run(
      mutate("tasks.create", host, {
        task: {
          project_id: ProjectId.make(project.id),
          // With no title, the board writes one from the description.
          ...(title.trim() === "" ? {} : { title: title.trim() }),
          description: description.trim(),
          status: start ? "in_progress" : "todo",
          ...(start ? { start: true } : {}),
        },
      }),
      (exit) => {
        if (Exit.isFailure(exit)) return
        onClose()
        openTask(host, exit.value.id)
      },
    )
  }
  return (
    <Sheet
      title="New task"
      onClose={onClose}
      footer={
        <View style={{ gap: space.sm }}>
          {error !== null && <ErrorText>{error}</ErrorText>}
          <Button
            title={start ? "Create and start" : "Create"}
            kind="primary"
            icon={start ? "play" : "add"}
            busy={busy}
            disabled={project === undefined || (title.trim() === "" && description.trim() === "")}
            onPress={create}
          />
        </View>
      }
    >
      <View style={{ paddingHorizontal: space.sm, gap: space.md }}>
        {projects.length > 1 && (
          <View style={{ gap: 6 }}>
            <Text style={s.label}>Project</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: space.sm }}>
              {projects.map((p) => (
                <Chip
                  key={`${p.host_id}/${p.id}`}
                  label={p.name}
                  selected={p.host_id === project?.host_id && p.id === project.id}
                  onPress={() => setProject(p)}
                />
              ))}
            </ScrollView>
          </View>
        )}
        <TextInput
          style={[s.input, { minHeight: 120, textAlignVertical: "top", paddingTop: 12 }]}
          value={description}
          onChangeText={setDescription}
          placeholder="What should the agent do?"
          placeholderTextColor={colors.faint}
          accessibilityLabel="What should the agent do?"
          multiline
          autoFocus
        />
        <TextInput
          style={s.input}
          value={title}
          onChangeText={setTitle}
          placeholder="Title (optional: the board writes one)"
          placeholderTextColor={colors.faint}
          accessibilityLabel="Title"
        />
        <View style={[s.row, { justifyContent: "space-between" }]}>
          <Text style={s.body}>Start its agent now</Text>
          <Switch
            value={start}
            onValueChange={setStart}
            trackColor={{ true: colors.accentStrong, false: colors.line }}
            accessibilityLabel="Start its agent now"
          />
        </View>
      </View>
    </Sheet>
  )
}
