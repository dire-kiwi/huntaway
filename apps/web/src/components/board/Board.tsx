import { clsx } from "clsx"
import { Folder, FolderGit2, Settings2 } from "lucide-react"
import { useCallback, useMemo, useState } from "react"
import { isArchived, isAssistants, isPenThreads, needsWorktreeSetup, type HostProject as Project, type HostTask as Task } from "@huntaway/client"
import { ACTIVE_VIEW, canPen, inTab, isPenView, loadCollapsed, loadTab, moveToPen, saveCollapsed, saveTab, viewTabs, type PenLanes } from "./pens"
import { useShallow } from "../boardHelpers"
import { PenTabs, tabCounts, usePenTabs } from "./Pens"
import { groupProjects, groupTasks } from "../../projectGroups"
import { navigate } from "../../state/route"
import { scratchHost, useHost } from "../boardHelpers"
import { IconButton, MenuButton } from "../ui"
import { NewTaskButton, TaskBoard } from "./TaskBoard"
import { useBoard } from "../../state/board"

/** A project's board. */
export function Board({ projectId }: { projectId: string }) {
  const project = useBoard((s) => s.projects.find((p) => p.id === projectId))
  const hostCount = useBoard((s) => s.hosts.length)
  const host = useBoard((s) => s.hosts.find((h) => h.id === project?.host_id))
  const archived = useBoard((s) => (project ? undefined : s.archived.find((p) => p.id === projectId)))
  const projects = useMemo(() => (project ? [project] : []), [project])
  if (archived)
    return (
      <div className="p-8 text-muted">
        {archived.name} is archived.{" "}
        <button className="text-accent hover:underline" onClick={() => navigate({ name: "settings", tab: "archived" })}>
          Unarchive it in Settings
        </button>{" "}
        to see its board.
      </div>
    )
  if (!project) return <div className="p-8 text-muted">Project not found.</div>
  // Its tasks wait for worktrees: the old board showed the thread that helps get the folder ready instead
  // (task/WorktreeSetup), which needs agents. Not yet on this server: the board shows a notice above its tasks.
  const setup = needsWorktreeSetup(project)
  const boardKey = `project:${project.host_id}:${project.id}`
  return (
    <TaskBoard
      key={boardKey}
      boardKey={boardKey}
      hostId={project.host_id}
      projects={projects}
      notice={
        setup &&
        `${project.name} isn't ready for worktrees yet (its folder needs to be a git repository with a commit). Setting it up comes with agents on this server.`
      }
      renderHeader={({ controls, newTask }) => (
        <header className="drag flex h-12 shrink-0 items-center gap-3 border-b border-line px-5 narrow:gap-2 narrow:px-3">
          <MenuButton />
          <FolderGit2 size={16} className="shrink-0 text-muted narrow:hidden" />
          <div className="flex min-w-0 items-baseline gap-2">
            <h1 className="shrink-0 text-[14px] font-semibold narrow:min-w-0 narrow:truncate">{project.name}</h1>
            <span className="truncate font-mono text-[11.5px] text-faint narrow:hidden">
              {hostCount > 1 && <span className="mr-1.5 font-sans text-muted">{host?.name} ·</span>}
              {project.repo_path}
            </span>
          </div>
          <div className="no-drag ml-auto flex items-center gap-1.5">
            {controls}
            <IconButton title="Project settings" onClick={() => navigate({ name: "projectSettings", projectId })}>
              <Settings2 size={15} />
            </IconButton>
            <NewTaskButton onClick={newTask} />
          </div>
        </header>
      )}
    />
  )
}

/** A group's board: the tasks of all its projects together. */
export function GroupBoard({ hostId, group }: { hostId: string; group: string }) {
  const all = useBoard((s) => s.projects)
  const hostCount = useBoard((s) => s.hosts.length)
  const host = useHost(hostId)
  const projects = useMemo(() => groupProjects(all, hostId, group), [all, hostId, group])
  // Ungrouping or deleting its last project leaves its group tasks, which keep the board.
  const hasTasks = useBoard((s) => groupTasks(Object.values(s.tasks), hostId, group).length > 0)
  if (!projects.length && !hasTasks) return <div className="p-8 text-muted">Group not found.</div>
  return (
    <TaskBoard
      key={`group:${hostId}:${group}`}
      boardKey={`group:${hostId}:${group}`}
      hostId={hostId}
      projects={projects}
      group={group}
      notice={
        !projects.length &&
        `${group} has no projects any more, so only its group tasks are left. Their agents can still run, and you can delete them; put a project back in the group to plan in it again.`
      }
      renderHeader={({ controls, newTask }) => (
        <header className="drag flex h-12 shrink-0 items-center gap-3 border-b border-line px-5 narrow:gap-2 narrow:px-3">
          <MenuButton />
          <Folder size={16} className="shrink-0 text-muted narrow:hidden" />
          <div className="flex min-w-0 items-baseline gap-2">
            <h1 className="shrink-0 text-[14px] font-semibold narrow:min-w-0 narrow:truncate">{group}</h1>
            <span className="min-w-0 truncate text-[11.5px] text-faint narrow:hidden">
              {hostCount > 1 && <span className="mr-1.5 text-muted">{host?.name} ·</span>}
              {projects.map((p, i) => (
                <span key={p.id}>
                  {i > 0 && ", "}
                  <button className="no-drag hover:text-fg" title={`Open the ${p.name} board`} onClick={() => navigate({ name: "board", projectId: p.id })}>
                    {p.name}
                  </button>
                </span>
              ))}
            </span>
          </div>
          <div className="no-drag ml-auto flex items-center gap-1.5">
            {controls}
            {projects.length > 0 && <NewTaskButton onClick={newTask} />}
          </div>
        </header>
      )}
    />
  )
}

/** Projects a new task can go in: those on a connected host. */
function useTaskProjects(projects: ReadonlyArray<Project>) {
  const hosts = useBoard((s) => s.hosts)
  return useMemo(() => projects.filter((p) => hosts.some((h) => h.id === p.host_id && h.connected)), [projects, hosts])
}

/** A profile's board: the tasks of all its projects on every host, its group tasks and its scratch tasks. */
export function ProfileBoard({ profile }: { profile: string }) {
  const all = useBoard((s) => s.projects)
  const profiles = useBoard((s) => s.profiles)
  const hosts = useBoard((s) => s.hosts)
  const loaded = useBoard((s) => s.loaded)
  // The profile on each host that has it, by `<host>:<profile id>`.
  const ids = useMemo(() => new Set(profiles.filter((p) => p.name === profile).map((p) => `${p.host_id}:${p.id}`)), [profiles, profile])
  const projects = useMemo(() => all.filter((p) => ids.has(`${p.host_id}:${p.profile_id}`)), [all, ids])
  const targets = useTaskProjects(projects)
  // Recomputed with the hosts and their settings, which pick where scratch tasks go.
  const hostSettings = useBoard((s) => s.hostSettings)
  const scratch = useMemo(() => scratchHost(profile, { profiles, hosts, hostSettings }), [profile, profiles, hosts, hostSettings])
  // Its pens' tabs (HA-285): the one picked last on this client, while it's there.
  const tabs = usePenTabs(ids)
  const [picked, setPicked] = useState(() => loadTab(profile))
  const tab = tabs.find((t) => t.key === picked)
  const pickTab = (key: string) => {
    setPicked(key)
    saveTab(profile, key)
  }
  // Or the Active or Inactive view (HA-292): the tasks in those pens, in a row for each pen, which can be collapsed.
  const view = !tab && isPenView(picked) && tabs.length ? picked : undefined
  const [collapsed, setCollapsed] = useState(() => loadCollapsed(profile))
  const lanes = useMemo((): PenLanes | undefined => {
    if (!view) return undefined
    const onToggle = (key: string) =>
      setCollapsed((c) => {
        const next = new Set(c)
        if (!next.delete(key)) next.add(key)
        saveCollapsed(profile, next)
        return next
      })
    const empty =
      view === ACTIVE_VIEW ? "No pen is active: pick one from the inactive pens to mark it active" : "No pen is inactive: a pen's tab's menu marks it inactive"
    return { tabs: viewTabs(tabs, view), collapsed, onToggle, empty }
  }, [view, tabs, collapsed, profile])
  // The same function while the view has the same pens, so collapsing a row doesn't let the picked tasks go.
  const laneKeys = lanes?.tabs.map((t) => t.pens.map((p) => `${p.host_id}:${p.id}`).join(",")).join(" ")
  const [laneTabs, setLaneTabs] = useState(() => ({ keys: laneKeys, tabs: lanes?.tabs }))
  if (laneTabs.keys !== laneKeys) setLaneTabs({ keys: laneKeys, tabs: lanes?.tabs })
  const only = useMemo(
    () => (tab ? (t: Task) => inTab(tab, t) : laneTabs.tabs ? (t: Task) => (laneTabs.tabs ?? []).some((l) => inTab(l, t)) : undefined),
    [tab, laneTabs],
  )
  // A task made on a pen's tab goes in the pen (the board shows why, if it can't: it isn't on the tab).
  const onCreated = useCallback(
    async (made: ReadonlyArray<Task>) => {
      if (!tab) return
      await moveToPen(made, tab.name)
      const left = made.filter((t) => !canPen(t))
      if (left.length) throw new Error(`${left.map((t) => t.title).join(", ")} isn't on this tab: its host has no pens`)
    },
    [tab],
  )
  // What each tab has: the tasks on the board, not counting archived ones.
  const boardTasks = useBoard(
    useShallow((s) =>
      Object.values(s.tasks).filter(
        (t) =>
          t.kind === "task" && !isAssistants(t) && !isPenThreads(t) && !t.parent_id && ids.has(`${t.host_id}:${t.profile_id}`) && !isArchived(t, Date.now()),
      ),
    ),
  )
  const counts = useMemo(() => tabCounts(tabs, boardTasks), [tabs, boardTasks])
  if (!ids.size) return <div className="p-8 text-muted">{loaded ? "Profile not found." : "Loading…"}</div>
  const on = hosts.filter((h) => profiles.some((p) => p.host_id === h.id && p.name === profile))
  return (
    <TaskBoard
      key={`profile:${profile}`}
      boardKey={`profile:${profile}`}
      projects={projects}
      profiles={ids}
      targets={targets}
      scratch={scratch}
      ready={loaded}
      only={only}
      penLabels={!tab && !lanes}
      lanes={lanes}
      onOpenPen={pickTab}
      onCreated={onCreated}
      renderHeader={({ controls, newTask }) => (
        <>
          <header className="drag flex h-12 shrink-0 items-center gap-3 border-b border-line px-5 narrow:gap-2 narrow:px-3">
            <MenuButton />
            <ProfileAvatar name={profile} />
            <div className="flex min-w-0 items-baseline gap-2">
              <h1 className="shrink-0 text-[14px] font-semibold narrow:min-w-0 narrow:truncate">{profile}</h1>
              <span className="min-w-0 truncate text-[11.5px] text-faint narrow:hidden">
                {hosts.length > 1 && <span className="mr-1.5 text-muted">{on.map((h) => h.name).join(", ")} ·</span>}
                {projects.length ? `${projects.length} project${projects.length === 1 ? "" : "s"}` : "No projects yet"}
              </span>
            </div>
            <div className="no-drag ml-auto flex items-center gap-1.5">
              {controls}
              {(targets.length > 0 || scratch) && <NewTaskButton onClick={newTask} />}
            </div>
          </header>
          <PenTabs profile={profile} profiles={ids} tabs={tabs} selected={tab ? tab.key : (view ?? "")} onSelect={pickTab} counts={counts} />
        </>
      )}
    />
  )
}

/** A profile's initial, as its rows and its board show it. */
/** A profile's initial; `muted` greys it out (the sidebar's profiles other than the one it lists the projects of). */
export function ProfileAvatar({ name, className, muted }: { name: string; className?: string | undefined; muted?: boolean | undefined }) {
  return (
    <span
      className={clsx(
        "flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded text-[10px] font-bold uppercase",
        muted ? "bg-white/[0.06] text-muted" : "bg-accent/20 text-accent",
        className,
      )}
    >
      {name[0] ?? "?"}
    </span>
  )
}
