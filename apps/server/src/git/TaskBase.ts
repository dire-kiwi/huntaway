import { Context, Effect, FileSystem, Layer, Option, Ref } from "effect"
import type { Branch, DiffResult, Project, StartFrom, Task, TaskId } from "@huntaway/contracts"
import { Proc } from "../platform/Proc.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { ProfileRepo } from "../profiles/ProfileRepo.ts"
import { ProjectRepo } from "../projects/ProjectRepo.ts"
import { Actor } from "../platform/Changes.ts"
import { isMerged, isScratch } from "../tasks/checks.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { TaskNotFound, Tasks } from "../tasks/Tasks.ts"
import { Threads } from "../threads/Threads.ts"
import { Git } from "./Git.ts"
import { GitHubAccess } from "./GitHubAccess.ts"
import { expandHome, lines } from "./paths.ts"
import { branchDiff, changesBase, dirDiff, forgetStart, keepStart, startRef, workScope } from "./worktree/changes.ts"
import type { ChangesBase, WorkScope } from "./worktree/changes.ts"
import type { WorktreeFailed } from "./worktree/failed.ts"
import { github, pushRemote, pushRepo } from "./worktree/remote.ts"
import type { Github } from "./worktree/remote.ts"
import { uncommitted } from "./worktree/remove.ts"
import { branches, pickStart, setMergeBase } from "./worktree/start.ts"
import type { Picked } from "./worktree/start.ts"
import { stackedBase, taskBase } from "./worktree/stacks.ts"
import { compareRef, fetchBase, fetchUpstream, startPoint, upstream } from "./worktree/upstream.ts"
import type { Start, Upstream } from "./worktree/upstream.ts"

export { startRef } from "./worktree/changes.ts"
export type { ChangesBase, WorkScope } from "./worktree/changes.ts"
export type { Github } from "./worktree/remote.ts"
export type { Picked } from "./worktree/start.ts"
export type { Start, Upstream } from "./worktree/upstream.ts"

/** Trimmed, or null when blank. */
const nonBlank = (s: string | null | undefined) => (s === null || s === undefined || s.trim() === "" ? null : s.trim())

/** Where a task's changes are, with the task and its project as they were read. */
export interface ChangesDir {
  /** Its worktree once it's ready, else its project's repository. */
  readonly dir: string
  readonly task: Task
  readonly project: Project
}

export interface TaskBaseShape {
  /** The GitHub account a task's fetches and gh calls go as: its project's, else its profile's. */
  readonly account: (task: Task) => Effect.Effect<string | null>
  /** The branch base branch `base` follows in `repo` (its upstream, or the same name on `origin`), if any. */
  readonly upstream: (repo: string, base: string) => Effect.Effect<Upstream | null>
  /** Fetch an upstream (not one in the repository itself), as `account`, within a minute. */
  readonly fetch: (repo: string, up: Upstream, account: string | null) => Effect.Effect<void, WorktreeFailed>
  /** Fetch base branch `base`'s upstream: its name (`origin/main`), or null when it has none. */
  readonly fetchBase: (repo: string, base: string, account: string | null) => Effect.Effect<string | null, WorktreeFailed>
  /** Where a new branch from `base` starts: the newer of it and its upstream (fetched first), fast-forwarding it when it can. */
  readonly startPoint: (repo: string, base: string, account: string | null) => Effect.Effect<Start>
  /** What a task branched from `base` is compared with, without fetching: `base` or its upstream as last fetched. */
  readonly compareRef: (repo: string, base: string) => Effect.Effect<string>
  /**
   * Where `task` starts from `sf` (the four kinds), as its worktree is first made. A task it's stacked on that has no
   * branch yet is set up first with `setUp`.
   */
  readonly pickStart: (
    task: Task,
    project: Project,
    sf: StartFrom,
    setUp: (other: Task) => Effect.Effect<Task, WorktreeFailed>,
  ) => Effect.Effect<Picked, WorktreeFailed>
  /** The repository's branches, newest first, at most 200 (remote-only ones as `origin/x`). */
  readonly branches: (repo: string) => Effect.Effect<ReadonlyArray<Branch>>
  /** Where a task branched from `base` opens its pull request, if that's on GitHub: the remote and `OWNER/REPO`. */
  readonly github: (repo: string, base: string | null) => Effect.Effect<Github | null>
  /** The remote a task branched from `base` pushes to, and its push URL. */
  readonly pushRemote: (repo: string, base: string | null) => Effect.Effect<readonly [string, string] | null>
  /** The host (an SSH alias resolved) and `OWNER/REPO` a task branched from `base` pushes to, on any host. */
  readonly pushRepo: (repo: string, base: string | null) => Effect.Effect<readonly [string, string] | null>
  /**
   * The base branch a task's work goes to (the old `task_base`): the branch of the task it merges into while that's
   * open, where that went once it's merged, the same for one it's stacked on, else its own base branch or its project's.
   */
  readonly taskBase: (task: Task, project: Pick<Project, "base_branch"> | null) => Effect.Effect<string | null>
  /** The open task whose branch `taskBase` has `task` go to, if it goes to another task's branch. */
  readonly stackedBase: (task: Task) => Effect.Effect<Task | null>
  /** The branch whose remote decides where `task`'s pull request goes: its base, or past stacked tasks not pushed yet. */
  readonly remoteBase: (task: Task, project: Project) => Effect.Effect<string | null>
  /**
   * Before merged task `gone` is deleted: the tasks stacked on it keep going where it went: onto the open task it was
   * itself stacked on, or from the commit where their own work starts. Nothing for one that isn't merged.
   */
  readonly unstack: (gone: Task) => Effect.Effect<void>
  /** Where a task's changes are: its worktree once it's ready, else its project's repository. */
  readonly changesDir: (task: TaskId) => Effect.Effect<ChangesDir, TaskNotFound>
  /** A task's base branch and where its own work starts in `dir` (known only in its ready worktree). */
  readonly changesBase: (dir: string, task: Task, project: Project | null) => Effect.Effect<ChangesBase>
  /** What a review or a summary compares a task's work in `dir` with (4.6). */
  readonly workScope: (dir: string, task: Task, project: Project | null) => Effect.Effect<WorkScope>
  /**
   * Move the start refs of `task` and of the tasks stacked on it on to as much of the branch each is stacked on as it
   * has taken in (only forward). Called as a run ends, when a task is done, before a teardown, on restack.
   */
  readonly keepStarts: (task: TaskId) => Effect.Effect<void>
  /** The task's own work against where it starts (`git.taskDiff`). */
  readonly diff: (task: TaskId) => Effect.Effect<DiffResult, TaskNotFound>
  /**
   * Whether the task has work to merge: commits its base branch (or its upstream) doesn't have, uncommitted changes
   * where its agent works, or tasks merging into it. When it can't tell, yes, so its agent sorts the merge out.
   */
  readonly hasWorkToMerge: (task: Task) => Effect.Effect<boolean>
  /** Drop a deleted task's start ref from `repo`. */
  readonly forgetStart: (repo: string, task: TaskId) => Effect.Effect<void>
  /**
   * 4.8: have `task`'s branch record where its pull request goes now (`branch.<b>.gh-merge-base`, so `gh pr create`
   * targets it): its `taskBase`, unless that's its project's base branch.
   */
  readonly followBase: (task: Task) => Effect.Effect<void>
}

export interface TaskBaseOptions {
  /** The SSH config `ssh -G` reads to resolve a host alias (tests give `/dev/null`); none: the user's. */
  readonly sshConfig?: string
  /** For a test: runs as a diff starts reading a folder's changes, once. */
  readonly onDiffRead?: Effect.Effect<void>
}

/**
 * Where a task's branch starts and what its own work is (docs/plan/06-server.md, Git; inventory 04, sections 2.3 and
 * 2.7): upstreams, start points, `start_from`, stacks, start refs, diffs. The bodies are in `git/worktree/*`.
 */
export class TaskBase extends Context.Service<TaskBase, TaskBaseShape>()("huntaway-server/git/TaskBase") {
  static readonly layerWith = (options: TaskBaseOptions = {}) =>
    Layer.effect(
      TaskBase,
      Effect.gen(function* () {
        const g = yield* Git
        const gh = yield* GitHubAccess
        const repo = yield* TaskRepo
        const projects = yield* ProjectRepo
        const profiles = yield* ProfileRepo
        const tasks = yield* Tasks
        const threads = yield* Threads
        const proc = yield* Proc
        const fs = yield* FileSystem.FileSystem
        const config = yield* ServerConfig
        const onDiffRead = yield* Ref.make(options.onDiffRead ?? null)

        const get = (id: string) => repo.get(id)
        const projectOf = (task: Task) =>
          task.project_id === null ? Effect.succeed(null) : Effect.map(projects.get(task.project_id), (p) => Option.getOrNull(p))
        const exists = (path: string) => fs.exists(path).pipe(Effect.orElseSucceed(() => false))
        const repoOf = (project: Project) => expandHome(project.repo_path, config.home)

        /** The host an SSH alias stands for, as `ssh -G` has it; the host as it is when ssh can't say. */
        const sshConfig = options.sshConfig ?? config.sshConfig
        const ssh = (host: string) =>
          proc
            .run("ssh", [...(sshConfig === null ? [] : ["-F", sshConfig]), "-G", "--", host], {
              timeout: "5 seconds",
            })
            .pipe(
              Effect.map((o) => {
                if (o.code !== 0) return host
                const name = lines(o.stdout)
                  .find((l) => l.startsWith("hostname "))
                  ?.slice("hostname ".length)
                  .trim()
                  .toLowerCase()
                return name === undefined || name === "" ? host : name
              }),
              Effect.orElseSucceed(() => host),
            )

        const account = Effect.fnUntraced(function* (task: Task) {
          const project = yield* projectOf(task)
          const own = nonBlank(project?.github_account)
          if (own !== null) return own
          return nonBlank(Option.getOrNull(yield* profiles.get(task.profile_id))?.github_account)
        })

        const remoteBase = Effect.fn("TaskBase.remoteBase")(function* (task: Task, project: Project) {
          const dir = repoOf(project)
          let t = task
          for (let i = 0; i < 16; i++) {
            const base = yield* taskBase(get, t, project)
            const on = yield* stackedBase(get, t)
            if (base === null || on === null) return base
            const own = yield* g.run(dir, ["config", `branch.${base}.remote`]).pipe(
              Effect.map((o) => o.stdout.trim() !== ""),
              Effect.orElseSucceed(() => false),
            )
            if (own) return base
            t = on
          }
          return null
        })

        const keepStarts = Effect.fn("TaskBase.keepStarts")(function* (id: TaskId) {
          const task = yield* get(id)
          if (task === null) return
          const stacked =
            task.project_id === null
              ? []
              : (yield* repo.projectTasks(task.project_id)).filter((t) => t.start_from?.type === "task" && t.start_from.task_id === id)
          for (const t of [...stacked, task]) {
            if (t.start_from === null || t.branch === null || t.branch === "") continue
            const project = yield* projectOf(t)
            if (project === null) continue
            yield* keepStart(g, repoOf(project), t, `refs/heads/${t.branch}`)
          }
        })

        const unstack = Effect.fn("TaskBase.unstack")(function* (gone: Task) {
          if (!isMerged(gone)) return
          yield* keepStarts(gone.id)
          const stacked =
            gone.project_id === null
              ? []
              : (yield* repo.projectTasks(gone.project_id)).filter((t) => t.start_from?.type === "task" && t.start_from.task_id === gone.id)
          const heir = yield* stackedBase(get, gone)
          for (const t of stacked) {
            const project = yield* projectOf(t)
            const base = yield* taskBase(get, t, project)
            let text: string
            let columns: Partial<Pick<Task, "start_from" | "base_branch">>
            if (heir !== null) {
              columns = { start_from: { type: "task", task_id: heir.id }, base_branch: t.branch !== null ? base : null }
              text = `${gone.key}, which this task landed after, was deleted: it's merged into ${heir.key}, so this task lands after that now`
            } else {
              const kept = project !== null && t.branch !== null ? yield* g.commit(repoOf(project), startRef(t.id)) : null
              const from: StartFrom | null = t.branch !== null ? (kept !== null ? { type: "commit", commit: kept } : t.start_from) : null
              columns = { base_branch: base, start_from: from }
              text = `${gone.key}, which this task landed after, was deleted: it's merged, so this task goes to ${base ?? "the base branch"}`
            }
            const changed = yield* Effect.result(tasks.change(t.id, () => columns, Actor.board))
            if (changed._tag === "Failure") {
              yield* Effect.logWarning(`task ${t.id}: keeping where it goes as ${gone.key} is deleted: it's gone`)
              continue
            }
            yield* threads.notice(t.id, "info", text).pipe(Effect.ignore)
          }
        })

        const start = Effect.fn("TaskBase.pickStart")(function* (
          task: Task,
          project: Project,
          sf: StartFrom,
          setUp: (other: Task) => Effect.Effect<Task, WorktreeFailed>,
        ) {
          const deps = {
            git: g,
            gh,
            get,
            ssh,
            account: yield* account(task),
            note: (text: string) => threads.notice(task.id, "info", text).pipe(Effect.ignore),
            setUp,
          }
          return yield* pickStart(deps, task, project, repoOf(project), sf)
        })

        const changesDir = Effect.fn("TaskBase.changesDir")(function* (id: TaskId) {
          const task = yield* get(id)
          if (task === null) return yield* new TaskNotFound({ id })
          const project = yield* projectOf(task)
          if (project === null) return yield* new TaskNotFound({ id })
          const dir = task.worktree_path !== null && task.worktree_state === "ready" ? task.worktree_path : repoOf(project)
          const out: ChangesDir = { dir, task, project }
          return out
        })

        const diff = Effect.fn("TaskBase.diff")(function* (id: TaskId) {
          const { dir, task, project } = yield* changesDir(id)
          // A task with a worktree of its own that isn't there (not set up yet, or removed, even since the task was
          // loaded, as a teardown does while it's read): what its branch has, if anything, rather than the project
          // folder's changes, which aren't its own.
          const repoDir = repoOf(project)
          const gone = Effect.map(exists(dir), (there) => task.use_worktree && (task.worktree_state !== "ready" || !there))
          const from = (yield* gone) ? repoDir : dir
          if (!(yield* g.isRepo(from))) return { available: false, reason: "not a git repository" } satisfies DiffResult
          if (yield* gone) return yield* branchDiff(g, get, repoDir, task, project).pipe(Effect.orDie)
          const hook = yield* Ref.getAndSet(onDiffRead, null)
          if (hook !== null) yield* hook
          return yield* dirDiff(g, get, dir, task, project).pipe(
            Effect.catch((e) => Effect.flatMap(gone, (now) => (now ? branchDiff(g, get, repoDir, task, project).pipe(Effect.orDie) : Effect.die(e)))),
          )
        })

        const hasWorkToMerge = Effect.fn("TaskBase.hasWorkToMerge")(function* (task: Task) {
          const project = yield* projectOf(task)
          if (project === null) return false
          const dir = repoOf(project)
          if (!(yield* g.isRepo(dir))) return false
          // The tasks merging into it: a task with none of its own commits gathers theirs (HA-295).
          const siblings = yield* repo.projectTasks(project.id)
          if (siblings.some((t) => t.merges_into === task.id && t.kind === "task" && !isScratch(t))) return true
          const base = yield* taskBase(get, task, project)
          // Whatever the repository's settings hide from git status.
          const dirty = (d: string) =>
            uncommitted(g, fs, d).pipe(
              Effect.map((s) => s !== ""),
              Effect.orElseSucceed(() => true),
            )
          const branch = task.branch
          if (branch === null) {
            // No worktree: the agent worked in the repository's own checkout, on its base branch unless it switched.
            if (task.use_worktree && task.worktree_state === "none") return false
            return base === null || (yield* g.currentBranch(dir)) !== base || (yield* dirty(dir))
          }
          if (base === null) return true
          // It may have started from the base branch's upstream, ahead of the local branch (or with no local branch).
          const bases = [`refs/heads/${base}`]
          const up = yield* upstream(g, dir, base)
          if (up !== null) bases.push(up.tracking)
          const args = ["rev-list", "--count", `refs/heads/${branch}`]
          for (const b of bases) if ((yield* g.commit(dir, b)) !== null) args.push(`^${b}`)
          if (args.length === 3) return true
          const o = yield* g.run(dir, args).pipe(Effect.orElseSucceed(() => null))
          if (o === null || !(o.ok && o.stdout.trim() === "0")) return true
          if (task.worktree_path !== null && task.worktree_state === "ready") return yield* dirty(task.worktree_path)
          return false
        })

        return TaskBase.of({
          account,
          upstream: (dir, base) => upstream(g, dir, base),
          fetch: (dir, up, acct) => fetchUpstream(g, gh, dir, up, acct),
          fetchBase: (dir, base, acct) => fetchBase(g, gh, dir, base, acct),
          startPoint: (dir, base, acct) => startPoint(g, gh, dir, base, acct),
          compareRef: (dir, base) => compareRef(g, dir, base),
          pickStart: start,
          branches: (dir) => branches(g, dir),
          github: (dir, base) => github(g, ssh, dir, base),
          pushRemote: (dir, base) => pushRemote(g, dir, base),
          pushRepo: (dir, base) => pushRepo(g, ssh, dir, base),
          taskBase: (task, project) => taskBase(get, task, project),
          stackedBase: (task) => stackedBase(get, task),
          remoteBase,
          unstack,
          changesDir,
          changesBase: (dir, task, project) => changesBase(g, get, dir, task, project),
          workScope: (dir, task, project) => workScope(g, get, dir, task, project),
          keepStarts,
          diff,
          hasWorkToMerge,
          forgetStart: (dir, task) => forgetStart(g, dir, task),
          followBase: Effect.fn("TaskBase.followBase")(function* (task: Task) {
            const project = yield* projectOf(task)
            if (project === null || task.branch === null) return
            const main = project.base_branch === "" ? null : project.base_branch
            yield* setMergeBase(g, repoOf(project), task.branch, yield* taskBase(get, task, project), main)
          }),
        })
      }),
    )

  static readonly layer = TaskBase.layerWith()
}
