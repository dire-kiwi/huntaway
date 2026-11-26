import { useAtom } from "@effect/atom-react"
import type { HostProject, HostTask } from "@huntaway/client"
import type { Status } from "@huntaway/contracts"
import { useMemo, useState } from "react"
import { Pressable, SectionList, Text, TextInput, View } from "react-native"
import { NewTask } from "../../components/newTask"
import { TaskCard } from "../../components/taskCard"
import { Empty, Icon, IconButton, s, Section, Sheet, SheetRow } from "../../components/ui"
import { FOLDED, groupTasks, searchTasks } from "../../logic/tasks"
import { projectKey, projectsOf, shownProjectAtom, useBoard, useProfile } from "../../state/board"
import { useNow } from "../../state/clock"
import { colors, radius, space, STATUS_COLOR } from "../../theme"

// Tasks (HE-99, in place of Projects and a project's own screen): the shown profile's tasks by status, what needs the
// user first, across its projects or in the one picked at the top; a search by key and title; Backlog and Done folded
// until asked for; and a new task from anywhere.

/** What is going on in a project: its tasks that aren't put away or done. */
const ACTIVE: ReadonlySet<Status> = new Set(["needs_attention", "in_progress", "in_review", "ready_for_merge"])

interface TaskSection {
  readonly status: Status
  readonly title: string
  readonly count: number
  readonly data: Array<HostTask>
}

export default function TasksScreen() {
  const profile = useProfile()
  const projects = useBoard((b) => b.projects)
  const profiles = useBoard((b) => b.profiles)
  const hosts = useBoard((b) => b.hosts)
  const tasks = useBoard((b) => b.tasks)
  const loaded = useBoard((b) => b.loaded)
  const [picked, setPicked] = useAtom(shownProjectAtom)
  const [text, setText] = useState("")
  const [searching, setSearching] = useState(false)
  const [folded, setFolded] = useState<ReadonlyArray<Status>>(FOLDED)
  const [picking, setPicking] = useState(false)
  const [adding, setAdding] = useState(false)
  const now = useNow(60_000)

  const mine = useMemo(() => projectsOf({ projects, profiles }, profile), [projects, profiles, profile])
  const project = mine.find((p) => projectKey(p) === picked)
  const names = useMemo(() => new Map(mine.map((p) => [projectKey(p), p.name])), [mine])
  const listed = useMemo(() => {
    const of = project === undefined ? new Set(names.keys()) : new Set([projectKey(project)])
    return Object.values(tasks).filter((t) => t.project_id !== null && of.has(`${t.host_id}/${t.project_id}`))
  }, [tasks, names, project])
  const sections = useMemo(
    (): Array<TaskSection> =>
      groupTasks(searchTasks(listed, text)).map((g) => ({
        status: g.status,
        title: g.label,
        count: g.tasks.length,
        // A search looks in what is folded too.
        data: folded.includes(g.status) && text.trim() === "" ? [] : [...g.tasks],
      })),
    [listed, text, folded],
  )
  const active = (p: HostProject): number =>
    Object.values(tasks).filter((t) => t.host_id === p.host_id && t.project_id === p.id && t.kind === "task" && ACTIVE.has(t.status)).length
  const hostName = (id: string): string | undefined => (hosts.length > 1 ? hosts.find((h) => h.id === id)?.name : undefined)
  const fold = (status: Status) => setFolded((was) => (was.includes(status) ? was.filter((st) => st !== status) : [...was, status]))

  return (
    <View style={s.screen}>
      <View style={{ paddingHorizontal: space.md, paddingBottom: space.sm, gap: space.sm }}>
        <View style={s.row}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Project: ${project?.name ?? "All projects"}`}
            onPress={() => setPicking(true)}
            style={({ pressed }) => [
              s.row,
              {
                flex: 1,
                height: 44,
                paddingHorizontal: space.md,
                borderRadius: radius.md,
                backgroundColor: colors.panel2,
                borderWidth: 1,
                borderColor: colors.line,
              },
              pressed && s.pressed,
            ]}
          >
            <Icon name={project === undefined ? "albums-outline" : "folder-outline"} size={17} />
            <Text style={[s.title, { flex: 1 }]} numberOfLines={1}>
              {project?.name ?? "All projects"}
            </Text>
            <Icon name="chevron-down" size={15} color={colors.faint} />
          </Pressable>
          <IconButton
            icon={searching ? "close" : "search"}
            label={searching ? "Close the search" : "Search tasks"}
            color={colors.muted}
            style={{ width: 44, height: 44 }}
            onPress={() => {
              setSearching(!searching)
              setText("")
            }}
          />
        </View>
        {searching && (
          <TextInput
            style={s.input}
            value={text}
            onChangeText={setText}
            placeholder="Search by key or title"
            placeholderTextColor={colors.faint}
            accessibilityLabel="Search tasks"
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            returnKeyType="search"
          />
        )}
      </View>
      <SectionList
        sections={sections}
        keyExtractor={(t) => `${t.host_id}/${t.id}`}
        stickySectionHeadersEnabled={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: 96 }}
        ListEmptyComponent={
          !loaded ? (
            <Empty title="Loading the board…" />
          ) : text.trim() !== "" ? (
            <Empty icon="search-outline" title="No task matches." />
          ) : mine.length === 0 ? (
            <Empty icon="folder-open-outline" title="No projects in this profile." hint="Add one on the board, on a computer." />
          ) : (
            <Empty icon="checkmark-done-outline" title="No tasks yet." hint="Tap + to give an agent something to do." />
          )
        }
        renderSectionHeader={({ section }) => (
          <Section
            title={section.title}
            count={section.count}
            color={STATUS_COLOR[section.status]}
            open={section.data.length > 0 || !folded.includes(section.status)}
            onPress={() => fold(section.status)}
          />
        )}
        renderItem={({ item }) => (
          <TaskCard task={item} project={project === undefined ? names.get(`${item.host_id}/${item.project_id}`) : undefined} now={now} />
        )}
      />
      {mine.length > 0 && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New task"
          onPress={() => setAdding(true)}
          style={({ pressed }) => [
            {
              position: "absolute",
              right: space.lg,
              bottom: space.lg,
              width: 56,
              height: 56,
              borderRadius: 28,
              backgroundColor: colors.accentStrong,
              alignItems: "center",
              justifyContent: "center",
              elevation: 6,
              shadowColor: "#000",
              shadowOpacity: 0.4,
              shadowRadius: 8,
              shadowOffset: { width: 0, height: 4 },
            },
            pressed && s.pressed,
          ]}
        >
          <Icon name="add" size={30} color={colors.fg} />
        </Pressable>
      )}
      {picking && (
        <Sheet title="Project" onClose={() => setPicking(false)}>
          <SheetRow
            icon="albums-outline"
            label="All projects"
            selected={project === undefined}
            onPress={() => {
              setPicked(null)
              setPicking(false)
            }}
          />
          {mine.map((p) => {
            const going = active(p)
            return (
              <SheetRow
                key={projectKey(p)}
                icon="folder-outline"
                label={p.name}
                detail={[p.key, hostName(p.host_id), going === 0 ? "nothing going on" : `${going} going on`].filter((x) => x !== undefined).join(" · ")}
                selected={project !== undefined && projectKey(project) === projectKey(p)}
                onPress={() => {
                  setPicked(projectKey(p))
                  setPicking(false)
                }}
              />
            )
          })}
        </Sheet>
      )}
      {adding && <NewTask projects={mine} initial={project} onClose={() => setAdding(false)} />}
    </View>
  )
}
