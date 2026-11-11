import { Context, Effect, Layer, Option } from "effect"
import { DocumentLabel, threadKindOf } from "@huntaway/contracts"
import { TaskId } from "@huntaway/contracts"
import type { Agent, PermissionMode, ProjectId, Task, ThreadKind, ThreadKindFields } from "@huntaway/contracts"
import { GithubRemote } from "../github/GithubRemote.ts"
import { Git } from "../git/Git.ts"
import { taskBase } from "../git/worktree/stacks.ts"
import { isMerged } from "../tasks/checks.ts"
import { DataDir } from "../platform/DataDir.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import type { DocumentFile } from "../prompts/documentGuide.ts"
import type { LostWork } from "../prompts/lostBackground.ts"
import { penBrief } from "../prompts/penBrief.ts"
import { AgentConfigs } from "../profiles/AgentConfigs.ts"
import { Profiles } from "../profiles/Profiles.ts"
import { ProjectRepo } from "../projects/ProjectRepo.ts"
import { Projects } from "../projects/Projects.ts"
import type { ProjectNotFound } from "../projects/Projects.ts"
import { HostSettings } from "../settings/HostSettings.ts"
import { PenRepo } from "../tasks/PenRepo.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { Tasks } from "../tasks/Tasks.ts"
import type { TaskNotFound } from "../tasks/Tasks.ts"
import type { PromptContext, PromptProject, PromptTask } from "./prompts/context.ts"
import { mentionKeys, mentionsNote } from "./prompts/mentions.ts"
import type { MentionTask } from "./prompts/mentions.ts"
import { mentionsScanned, planRest, runPrompt } from "./prompts/start.ts"
import { planCommand } from "../prompts/planCommand.ts"
import { systemPrompt } from "./prompts/system.ts"

// What a run is told (docs/plan/07-agents.md, Prompts): the facts the prompt builders read (`PromptContext`), gathered
// from the services, and the builders called on them. The texts are in `prompts/`; the builders in `agents/prompts/`.

/** What decides what a run is told besides its thread: the agent it runs on and its permission mode. */
export interface RunTold {
  readonly codex: boolean
  readonly permission_mode: PermissionMode
  /** The task's temp folder (its `TMPDIR`), which it is told of; none by default. */
  readonly tmp?: string | null | undefined
}

/** The options of a new thread that change what it is told (the old `GET /projects/{id}/system-prompt`'s query). */
export interface PreviewOptions {
  /** A task (the default) or a scratch task. */
  readonly type?: "task" | "scratch" | undefined
  readonly labels?: ReadonlyArray<DocumentLabel> | undefined
  /** For a task: whether it has its own worktree (by default, as the project's new tasks do). */
  readonly worktree?: boolean | undefined
  /** By default, what a new task in the project runs on. */
  readonly runtime?: Agent | undefined
  /** By default, the project's, else the host's. */
  readonly permission_mode?: PermissionMode | undefined
}

/** What a new thread would be told, what it runs on, and its permission mode (the one given, or the one it inherits). */
export interface PromptPreview {
  readonly text: string
  readonly runtime: Agent
  readonly permission_mode: PermissionMode
}

export interface PromptsShape {
  /** What a run of `task` is told on top of its agent's own system prompt. */
  readonly system: (task: TaskId, run: RunTold) => Effect.Effect<string, TaskNotFound>
  /**
   * What a prompt run (not a `/compact`) of `task` is sent for `text`: a task's first prompt when its agent has no
   * session yet, `/plan` rewritten (once the task has the plan label), and the note on what the keys in it name.
   */
  readonly start: (task: TaskId, text: string, lost?: ReadonlyArray<LostWork>) => Effect.Effect<string, TaskNotFound>
  /**
   * What a message steered into `task`'s running agent is sent as (huntaway's write_steers): a `/plan` says how to write
   * the plan (the run may have started without the plan label, so its system prompt may not), and the note on what the
   * keys in it name follows.
   */
  readonly steer: (task: TaskId, text: string) => Effect.Effect<string, TaskNotFound>
  /**
   * What the agent of a new thread in `project` would be told, for the project's settings: a task numbered as the
   * project's next, with the options given and the project's settings as they are now. Its title and id are
   * placeholders.
   */
  readonly preview: (project: ProjectId, options: PreviewOptions) => Effect.Effect<PromptPreview, ProjectNotFound>
}

/** The task's documents by label, in the order the task shows them, in its own folder. */
const documentsOf = (folder: string, task: Pick<Task, "kind" | "labels">): ReadonlyArray<DocumentFile> =>
  task.kind !== "task" ? [] : DocumentLabel.literals.filter((l) => task.labels.includes(l)).map((l): DocumentFile => [l, `${folder}/${documentFile[l]}`])

const documentFile: { readonly [L in DocumentLabel]: string } = { plan: "plan.html", artifact: "artifact.html", diagram: "diagram.mmd" }

/** A thread as its prompts read it. */
type ContextTask = PromptTask & ThreadKindFields & Pick<Task, "profile_id">

/** Trimmed, or null when blank. */
const set = (s: string | null | undefined) => {
  const t = s?.trim()
  return t === undefined || t === "" ? null : t
}

/** What the later areas give when their feature is off (see `PromptContext`). */
const OFF = { github: null, ghTools: false, boardPr: false, workflowStart: null, docsTools: false, desktopHost: null, tmp: null, memory: "" } as const

export class Prompts extends Context.Service<Prompts, PromptsShape>()("huntaway-server/agents/Prompts") {
  static readonly layer = Layer.effect(
    Prompts,
    Effect.gen(function* () {
      const tasks = yield* Tasks
      const taskRepo = yield* TaskRepo
      const projects = yield* Projects
      const projectRepo = yield* ProjectRepo
      const profiles = yield* Profiles
      const configs = yield* AgentConfigs
      const settings = yield* HostSettings
      const penRepo = yield* PenRepo
      const dataDir = yield* DataDir
      const remote = yield* GithubRemote
      const config = yield* ServerConfig

      const expand = (path: string) => (path === "~" ? config.home : path.startsWith("~/") ? `${config.home}${path.slice(1)}` : path)

      /**
       * Where a task with its own branch opens its pull request, if its repository is on GitHub (huntaway's
       * runner/launch.ts): the remote a branch from its base is pushed to. 4.1's `TaskBase` gives the base a stacked
       * task's branch is pushed from (the old `remote_base`); until then the task's own base, else its project's.
       */
      const githubOf = (task: ContextTask, project: PromptProject | null) =>
        task.kind === "task" && project !== null && task.branch !== null
          ? remote.github(expand(project.repo_path), task.base_branch ?? set(project.base_branch))
          : Effect.succeed(null)
      const git = yield* Git

      const projectOf = (id: ProjectId | null) => (id === null ? Effect.succeed(null) : projectRepo.get(id).pipe(Effect.map(Option.getOrNull)))

      /** A pen's thread's pen as it is now, with its tasks (`penBrief`). */
      const penOf = Effect.fnUntraced(function* (task: ContextTask, kind: Extract<ThreadKind, { readonly _tag: "Pen" }>) {
        const pens = yield* penRepo.list(task.profile_id)
        const pen = pens.find((p) => p.id === kind.pen || p.thread_id === task.id)
        if (pen === undefined) return penBrief(null)
        const names = new Map((yield* projectRepo.list(pen.profile_id)).map((p) => [p.id, p.name]))
        const inPen = (yield* taskRepo.list({ _tag: "ByProfile", profile_id: pen.profile_id })).filter((t) => t.pen_id === pen.id)
        return penBrief({
          name: pen.name,
          id: pen.id,
          active: pen.active,
          tasks: inPen.map((t) => ({
            key: t.key,
            status: t.status,
            running: t.running,
            project: t.project_id !== null ? (names.get(t.project_id) ?? "another project") : "no project",
            title: t.title,
          })),
        })
      })

      /** The facts every thread's prompts read. */
      const contextOf = Effect.fnUntraced(function* (task: ContextTask, kind: ThreadKind, run: RunTold) {
        const project = yield* projectOf(task.project_id)
        const profile = yield* profiles.get(task.profile_id).pipe(Effect.orDie)
        const parent = task.kind === "review" && task.parent_id !== null ? yield* taskRepo.get(task.parent_id) : null
        const target = task.merges_into !== null ? yield* taskRepo.get(task.merges_into) : null
        const group =
          task.kind === "task" && project === null && task.group_name !== null
            ? (yield* projectRepo.list(task.profile_id)).filter((p) => p.group_name === task.group_name && p.archived_at === null)
            : []
        const context: PromptContext = {
          ...OFF,
          tmp: run.tmp ?? null,
          task,
          project,
          parent:
            parent === null
              ? null
              : {
                  number: parent.number,
                  title: parent.title,
                  worktree_path: parent.worktree_path,
                  branch: parent.branch,
                  worktree_ready: parent.worktree_state === "ready",
                },
          group,
          docs: documentsOf(dataDir.documents(task.id), task),
          target: target !== null && target.status !== "done" ? target : null,
          codex: run.codex,
          plan: run.permission_mode === "plan",
          profile,
          profiles: yield* profiles.list,
          githubAccount: set(project?.github_account) ?? set(profile.github_account),
          pen: kind._tag === "Pen" ? yield* penOf(task, kind) : "",
          github: yield* githubOf(task, project),
          // The board serves gh (4.4); a project that has its own `gh` server or turns it off is 6.4's (`AgentTools`).
          ghTools: true,
        }
        return context
      })

      /**
       * 4.8: the task as its agent is told of it (huntaway's runner/merge.ts `as_told`): one stacked on (or merging into)
       * a task that's merged by now goes, and opens its pull request, where that one went, and isn't stacked any more,
       * also once the board has restacked it there (its base branch is that already).
       */
      const asTold = Effect.fnUntraced(function* (task: Task) {
        if ((task.start_from?.type !== "task" && task.merges_into === null) || task.branch === null) return task
        const project = yield* projectOf(task.project_id)
        const base = yield* taskBase((id) => taskRepo.get(id), task, project)
        const below = task.start_from?.type === "task" ? yield* taskRepo.get(task.start_from.task_id) : null
        return base !== task.base_branch || (below !== null && isMerged(below)) ? Object.assign({}, task, { base_branch: base, start_from: null }) : task
      })

      const system = Effect.fn("Prompts.system")(function* (id: TaskId, run: RunTold) {
        const task = yield* asTold(yield* tasks.get(id))
        const kind = threadKindOf(task)
        return systemPrompt(kind, yield* contextOf(task, kind, run))
      })

      /** The projects and tasks the keys in `text` may name, for `mentionsNote`. */
      const mentionBoard = Effect.fnUntraced(function* (text: string) {
        const keys = mentionKeys(text)
        if (keys.length === 0) return { profiles: [], projects: [], tasks: [] }
        const all = yield* profiles.list
        const allProjects = (yield* Effect.forEach(all, (p) => projectRepo.list(p.id), { concurrency: 1 })).flat()
        const found: Array<MentionTask> = []
        for (const key of keys) {
          if (key.number === null) continue
          const n = key.number
          for (const p of allProjects.filter((x) => x.key === key.key)) {
            const t = yield* taskRepo.byNumber(p.id, n)
            if (t !== null) found.push(t)
          }
          if (key.key !== "S") continue
          for (const p of all) {
            const t = yield* taskRepo.projectlessByNumber(p.id, "scratch", n)
            if (t !== null) found.push(t)
          }
        }
        return { profiles: all, projects: allProjects, tasks: found }
      })

      const start = Effect.fn("Prompts.start")(function* (id: TaskId, text: string, lost: ReadonlyArray<LostWork> = []) {
        const task = yield* tasks.get(id)
        const kind = threadKindOf(task)
        const project = yield* projectOf(task.project_id)
        const c = { ...OFF, task, project, docs: documentsOf(dataDir.documents(task.id), task) }
        const board = task.kind === "task" ? yield* mentionBoard(mentionsScanned(c, text)) : { profiles: [], projects: [], tasks: [] }
        // The background work its last run stopped is plan task 2.8's (`BackgroundWork`); the routines' reports 6.5's.
        return runPrompt(kind, c, { text, lost, mentions: (scanned) => mentionsNote(task, scanned, board) })
      })

      const steer = Effect.fn("Prompts.steer")(function* (id: TaskId, text: string) {
        const task = yield* tasks.get(id)
        const planFile = documentsOf(dataDir.documents(task.id), task).find(([label]) => label === "plan")
        const plan = task.kind === "task" ? planRest(text) : null
        const sent = plan !== null && planFile !== undefined ? planCommand(planFile[1], plan, false) : text
        if (task.kind !== "task") return sent
        const note = mentionsNote(task, text, yield* mentionBoard(text))
        return note === "" ? sent : sent.trimEnd() + note
      })

      /** What a new task in `project` runs on: the first of its configs (or its profile's), else Claude's default. */
      const runtimeOf = Effect.fnUntraced(function* (
        project: PromptProject & { readonly claude_config_ids: ReadonlyArray<string> | null },
        ids: ReadonlyArray<string>,
      ) {
        const own = project.claude_config_ids !== null && project.claude_config_ids.length > 0 ? project.claude_config_ids : ids
        const known = yield* configs.list
        const first = own.flatMap((id) => known.filter((c) => c.id === id))[0]
        return first?.agent ?? "claude"
      })

      const preview = Effect.fn("Prompts.preview")(function* (id: ProjectId, o: PreviewOptions) {
        const project = yield* projects.get(id)
        const profile = yield* profiles.get(project.profile_id).pipe(Effect.orDie)
        const scratchTask = o.type === "scratch"
        const number = yield* projectRepo.nextNumber(project.id)
        const useWorktree = (scratchTask ? false : (o.worktree ?? project.use_worktrees)) && project.is_git
        // Where worktree setup would put it (its folder is `<number>-<the title's slug>`), from the branch the project
        // names, else the one checked out in its repository, as setup does (`Worktrees`).
        const name = `${number}-task-title`
        const baseBranch = useWorktree ? (set(project.base_branch) ?? (yield* git.currentBranch(project.repo_path))) : null
        const task: ContextTask = {
          id: TaskId.make("<task id>"),
          profile_id: profile.id,
          project_id: project.id,
          kind: "task",
          parent_id: null,
          task_type: scratchTask ? "scratch" : null,
          labels: DocumentLabel.literals.filter((l) => o.labels?.includes(l) === true),
          group_name: null,
          pen_id: null,
          work_dir: null,
          number,
          title: "Task title",
          description: "",
          external_links: [],
          session_id: null,
          use_worktree: useWorktree,
          worktree_path: useWorktree ? `${project.worktrees_root}/${name}` : null,
          branch: useWorktree ? `ia/${project.key.toLowerCase()}-${name}` : null,
          base_branch: baseBranch,
          start_from: null,
          merges_into: null,
          github_stack: null,
        }
        const runtime = o.runtime ?? (yield* runtimeOf(project, profile.claude_config_ids))
        const permission_mode = o.permission_mode ?? project.permission_mode ?? (yield* settings.get).default_permission_mode ?? "default"
        const kind = threadKindOf(task)
        const context = yield* contextOf(task, kind, { codex: runtime === "codex", permission_mode })
        return { text: systemPrompt(kind, context), runtime, permission_mode }
      })

      return Prompts.of({ system, start, steer, preview })
    }),
  )
}
