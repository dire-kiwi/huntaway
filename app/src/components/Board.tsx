import clsx from "clsx";
import { ChevronLeft, ChevronRight, Folder, FolderGit2, GitBranch, Layers, MessagesSquare, Settings2 } from "lucide-react";
import { useMemo } from "react";
import { needsWorktreeSetup, type Project, type Task } from "../api";
import { groupProjects, groupTasks } from "../projectGroups";
import { navigate, openTask } from "../router";
import { scratchHost, useHost, useStore } from "../store";
import { WorktreeSetup } from "./WorktreeSetup";
import { Button, IconButton, MenuButton, RunningDot } from "./ui";
import { NewTaskButton, TaskBoard } from "./TaskBoard";

/** A subproject's own board: its tasks, beside a link to its agent's thread. */
export function SubprojectBoard({ taskId }: { taskId: string }) {
  const task = useStore((s) => s.tasks[taskId]);
  if (!task) return <div className="p-8 text-muted">Loading subproject…</div>;
  if (!task.project_id || !task.subproject) return <div className="p-8 text-muted">This task isn't a subproject.</div>;
  return <Board projectId={task.project_id} subproject={task} />;
}

/** A project's board, or with `subproject`, that subproject's board. */
export function Board({ projectId, subproject }: { projectId: string; subproject?: Task }) {
  const project = useStore((s) => s.projects.find((p) => p.id === projectId));
  const hostCount = useStore((s) => s.hosts.length);
  const host = useStore((s) => s.hosts.find((h) => h.id === project?.host_id));
  const archived = useStore((s) => (project ? undefined : s.archived.find((p) => p.id === projectId)));
  const projects = useMemo(() => (project ? [project] : []), [project]);
  if (archived)
    return (
      <div className="p-8 text-muted">
        {archived.name} is archived.{" "}
        <button className="text-accent hover:underline" onClick={() => navigate({ name: "settings" })}>
          Unarchive it in Settings
        </button>{" "}
        to see its board.
      </div>
    );
  if (!project) return <div className="p-8 text-muted">Project not found.</div>;
  // Its tasks wait for worktrees, so the board shows the thread that helps get the folder ready instead.
  if (!subproject && needsWorktreeSetup(project, host)) return <WorktreeSetup project={project} hostName={hostCount > 1 ? host?.name : undefined} />;
  const boardKey = subproject ? `subproject:${project.host_id}:${subproject.id}` : `project:${project.host_id}:${project.id}`;
  return (
    <TaskBoard
      key={boardKey}
      boardKey={boardKey}
      hostId={project.host_id}
      projects={projects}
      subproject={subproject}
      header={({ controls, newTask }) =>
        subproject ? (
          <header className="drag flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
            <MenuButton />
            <IconButton className="no-drag" title={`Back to ${project.name}`} onClick={() => navigate({ name: "board", projectId })}>
              <ChevronLeft size={16} />
            </IconButton>
            <button className="no-drag text-[12.5px] text-muted hover:text-fg narrow:hidden" onClick={() => navigate({ name: "board", projectId })}>
              {project.name}
            </button>
            <ChevronRight size={12} className="text-faint narrow:hidden" />
            <Layers size={14} className="shrink-0 text-accent" />
            <span className="font-mono text-[12px] text-faint">
              {project.key}-{subproject.number}
            </span>
            <h1 className="min-w-0 truncate text-[13.5px] font-medium">{subproject.title}</h1>
            {subproject.branch && (
              <span className="hidden min-w-0 items-center gap-1 text-[11.5px] text-faint md:flex" title="Its tasks branch from and merge into this branch">
                <GitBranch size={11} className="shrink-0" />
                <span className="truncate font-mono">{subproject.branch}</span>
              </span>
            )}
            <div className="no-drag ml-auto flex items-center gap-1.5">
              {controls}
              <Button size="sm" variant="ghost" onClick={() => openTask(subproject.id)} title="The subproject's own agent, which plans and coordinates its tasks">
                {subproject.running ? <RunningDot /> : <MessagesSquare size={14} />} <span className="narrow:hidden">Thread</span>
              </Button>
              <NewTaskButton onClick={newTask} />
            </div>
          </header>
        ) : (
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
        )
      }
    />
  );
}

/** A group's board: the tasks of all its projects together. */
export function GroupBoard({ hostId, group }: { hostId: string; group: string }) {
  const all = useStore((s) => s.projects);
  const hostCount = useStore((s) => s.hosts.length);
  const host = useHost(hostId);
  const projects = useMemo(() => groupProjects(all, hostId, group), [all, hostId, group]);
  // Ungrouping or deleting its last project leaves its group tasks, which keep the board.
  const hasTasks = useStore((s) => groupTasks(Object.values(s.tasks), hostId, group).length > 0);
  if (!projects.length && !hasTasks) return <div className="p-8 text-muted">Group not found.</div>;
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
      header={({ controls, newTask }) => (
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
  );
}

/** Projects a new task can go in: those on a connected host. */
function useTaskProjects(projects: Project[]) {
  const hosts = useStore((s) => s.hosts);
  return useMemo(() => projects.filter((p) => hosts.some((h) => h.id === p.host_id && h.connected)), [projects, hosts]);
}

/** A profile's board: the tasks of all its projects on every host, its group tasks and its scratch tasks. */
export function ProfileBoard({ profile }: { profile: string }) {
  const all = useStore((s) => s.projects);
  const profiles = useStore((s) => s.profiles);
  const hosts = useStore((s) => s.hosts);
  const loaded = useStore((s) => s.loaded);
  // The profile on each host that has it, by `<host>:<profile id>`.
  const ids = useMemo(() => new Set(profiles.filter((p) => p.name === profile).map((p) => `${p.host_id}:${p.id}`)), [profiles, profile]);
  const projects = useMemo(() => all.filter((p) => ids.has(`${p.host_id}:${p.profile_id}`)), [all, ids]);
  const targets = useTaskProjects(projects);
  // Recomputed with the hosts and their settings, which pick where scratch tasks go.
  const hostSettings = useStore((s) => s.hostSettings);
  const scratch = useMemo(() => scratchHost(profile), [profile, profiles, hosts, hostSettings]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!ids.size) return <div className="p-8 text-muted">{loaded ? "Profile not found." : "Loading…"}</div>;
  const on = hosts.filter((h) => profiles.some((p) => p.host_id === h.id && p.name === profile));
  return (
    <TaskBoard
      boardKey={`profile:${profile}`}
      projects={projects}
      profiles={ids}
      targets={targets}
      scratch={scratch}
      header={({ controls, newTask }) => (
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
      )}
    />
  );
}

/** A profile's initial, as its rows and its board show it. */
/** A profile's initial; `muted` greys it out (the sidebar's profiles other than the one it lists the projects of). */
export function ProfileAvatar({ name, className, muted }: { name: string; className?: string; muted?: boolean }) {
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
  );
}
