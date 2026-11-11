import { Context, Effect, Fiber, FileSystem, Layer, Option, Schema } from "effect"
import { ChildProcessSpawner } from "effect/process"
import type { Conflict, MergedWorktreeResult, Project, ProjectId, Task, TaskId } from "@huntaway/contracts"
import { Actor } from "../platform/Changes.ts"
import { DataDir } from "../platform/DataDir.ts"
import { KeyedLock } from "../platform/KeyedLock.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { ProfileRepo } from "../profiles/ProfileRepo.ts"
import { ProjectRepo } from "../projects/ProjectRepo.ts"
import { ProjectNotFound, Projects } from "../projects/Projects.ts"
import { refuseWhileRunning } from "../profiles/checks.ts"
import type { TaskColumns } from "../tasks/decide.ts"
import { Leftovers } from "../tasks/Leftovers.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { TaskNotFound, Tasks } from "../tasks/Tasks.ts"
import { TaskTmp } from "../tasks/TaskTmp.ts"
import { Threads } from "../threads/Threads.ts"
import { Git } from "./Git.ts"
import { GitHubAccess } from "./GitHubAccess.ts"
import { expandHome, slugify, truncate } from "./paths.ts"
import { startRef, TaskBase } from "./TaskBase.ts"
import type { WorktreeFailed } from "./worktree/failed.ts"
import { fail, fromGit, orFail, within } from "./worktree/failed.ts"
import { bringIn, reportEvent } from "./worktree/files.ts"
import { noStrays, removableByHand, uncommitted } from "./worktree/remove.ts"
import { runScript, SCRIPT_LIMIT, scriptEnv } from "./worktree/scripts.ts"
import type { Picked } from "./worktree/start.ts"
import { setMergeBase } from "./worktree/start.ts"
import { upstreamName } from "./worktree/upstream.ts"

export { WorktreeFailed } from "./worktree/failed.ts"

/** Asked by hand (`idle`), while an agent works in the worktree: its task's own, or a reviewer's. */
export class AgentInWorktree extends Schema.TaggedError<AgentInWorktree, { readonly brand: unique symbol }>()("AgentInWorktree", {}) {
  override get message(): string {
    return "an agent is working in the worktree (the task's or a reviewer's); wait for it to finish or stop it"
  }
}

/** For a setup or teardown asked for by hand: refused while an agent works in the worktree. */
export interface ByHand {
  readonly idle?: boolean
}

/** What `removeIfMerged` did with a done task's worktree: removed (its work is merged into `into`), or kept and why. */
export type Removal = { readonly _tag: "Removed"; readonly into: string } | { readonly _tag: "Kept"; readonly why: string }

export interface WorktreesShape {
  /**
   * Set up the task's worktree (nothing if it's ready and there): branch it from where it starts, copy and link the
   * project's ignored files, run its setup script. One at a time per task; it carries on to its end if the caller goes
   * (a stopped launch), as the old one did. A failure is recorded on the task (`worktree_state` `error`) and in its thread.
   */
  readonly setup: (task: TaskId, options?: ByHand) => Effect.Effect<Task, WorktreeFailed | TaskNotFound | AgentInWorktree>
  /**
   * Run the teardown script and remove the worktree, keeping the branch unless `deleteBranch`. Refuses, unless `force`,
   * when anything in it isn't committed or its HEAD has commits on no branch, and again after the script; git's own
   * check has the last word. Forced, a folder git won't remove goes by hand only inside the project's worktrees folder.
   */
  readonly teardown: (
    task: TaskId,
    options: ByHand & { readonly force: boolean; readonly deleteBranch: boolean },
  ) => Effect.Effect<Task, WorktreeFailed | TaskNotFound | AgentInWorktree>
  /**
   * Remove a done task's worktree if its work is merged (its HEAD is in its base branch, here or upstream, or is the head
   * of its merged pull request) and nothing in it would be lost. The task and its branch are kept. With `fetch`, the base
   * branch's upstream is fetched first.
   */
  readonly removeIfMerged: (task: TaskId, fetch: boolean) => Effect.Effect<Removal, WorktreeFailed | TaskNotFound>
  /** `removeIfMerged` for each of the project's done tasks with a worktree, by number, each base fetched once first. */
  readonly removeMerged: (project: ProjectId) => Effect.Effect<ReadonlyArray<MergedWorktreeResult>, ProjectNotFound>
  /** Whether an agent works in the task's worktree: its own, or one of its reviewers', whose threads run there too. */
  readonly agentInWorktree: (task: TaskId) => Effect.Effect<boolean>
  /**
   * Before a task is deleted (its runs stopped): its worktree, as it is once a setup under way is done, is torn down
   * forced (its branch deleted with `deleteBranch`), the tasks stacked on it keep going where it went, and its start ref
   * goes. Failures are logged: the deletion goes on.
   */
  readonly forDeletion: (task: Task, deleteBranch: boolean) => Effect.Effect<void>
  /**
   * Delete a project (refused while one of its agents runs): its tasks' worktrees go first, forced, each once a setup
   * under way is done, their branches kept so no committed work is lost; then `Projects.delete`.
   */
  readonly deleteProject: (project: ProjectId) => Effect.Effect<void, ProjectNotFound | Conflict>
  /**
   * At startup: a worktree left `setting_up` by a server that stopped is marked failed (set up again by the next run or
   * the button), one left `tearing_down` is `ready` if its folder is still there, else gone.
   */
  readonly recover: Effect.Effect<void>
  /** Hold the task's worktree lock (`["worktree", task]`) around `effect`: what 4.8's restack takes too. */
  readonly withLock: (task: TaskId) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

const kept = (why: string): Removal => ({ _tag: "Kept", why })

/**
 * The name of a task's worktree folder in the project's worktrees folder. A task that had a worktree before (removed once
 * merged, say) gets its folder back, named after its branch (even if the project's key has changed since), so its
 * agent's conversation, which is kept by folder, carries on even if the task was renamed.
 */
export const folderName = (project: Pick<Project, "key" | "former_keys">, task: Pick<Task, "branch" | "title" | "number">): string => {
  let fromBranch: string | null = null
  if (task.branch !== null) {
    for (const k of [project.key, ...project.former_keys]) {
      const prefix = `ia/${k.toLowerCase()}-`
      if (task.branch.startsWith(prefix)) {
        fromBranch = task.branch.slice(prefix.length)
        break
      }
    }
  }
  if (fromBranch !== null && fromBranch !== "" && !fromBranch.includes("/")) return fromBranch
  const slug = slugify(task.title, 40)
  return slug === "" ? `${task.number}` : `${task.number}-${slug}`
}

/**
 * A task's worktree (docs/plan/06-server.md, Git; inventory 04, sections 2.2, 2.4–2.6): setting it up, tearing it down
 * and removing it once merged, one at a time per task under its worktree lock.
 */
export class Worktrees extends Context.Service<Worktrees, WorktreesShape>()("huntaway-server/git/Worktrees") {
  static readonly layer = Layer.effect(
    Worktrees,
    Effect.gen(function* () {
      const g = yield* Git
      const gh = yield* GitHubAccess
      const base = yield* TaskBase
      const repo = yield* TaskRepo
      const projects = yield* ProjectRepo
      const profiles = yield* ProfileRepo
      const tasks = yield* Tasks
      const projectsService = yield* Projects
      const threads = yield* Threads
      const locks = yield* KeyedLock
      const leftovers = yield* Leftovers
      const taskTmp = yield* TaskTmp
      const dataDir = yield* DataDir
      const config = yield* ServerConfig
      const fs = yield* FileSystem.FileSystem
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const scope = yield* Effect.scope
      const scripts = { spawner, agentEnv: config.agentEnv }

      const withLock = (task: TaskId) => locks.withLock(["worktree", task])
      const exists = (path: string) => fs.exists(path).pipe(Effect.orElseSucceed(() => false))
      const isDir = (path: string) =>
        fs.stat(path).pipe(
          Effect.map((i) => i.type === "Directory"),
          Effect.orElseSucceed(() => false),
        )
      const home = (path: string) => expandHome(path, config.home)
      const note = (task: TaskId, level: "info" | "warn" | "error", text: string, detail?: string | null) =>
        threads.notice(task, level === "warn" ? "warning" : level, text, detail ?? undefined).pipe(Effect.ignore)
      const write = (task: TaskId, columns: TaskColumns) => tasks.change(task, () => columns, Actor.board)

      const load = Effect.fnUntraced(function* (id: TaskId) {
        const task = yield* repo.get(id)
        if (task === null) return yield* new TaskNotFound({ id })
        if (task.project_id === null) return yield* fail("task has no project")
        const project = Option.getOrNull(yield* projects.get(task.project_id))
        if (project === null) return yield* fail("project not found")
        return { task, project } as const
      })

      const agentInWorktree = Effect.fn("Worktrees.agentInWorktree")(function* (id: TaskId) {
        const task = yield* repo.get(id)
        if (task?.running === true) return true
        return (yield* repo.reviewThreads(id)).some((r) => r.running)
      })

      // ---- setup ----

      /** Record that a task's worktree couldn't be set up, returning the error. */
      const setupFailed = Effect.fnUntraced(function* (id: TaskId, e: WorktreeFailed) {
        yield* write(id, { worktree_state: "error", worktree_error: e.reason }).pipe(
          Effect.catch(() => Effect.logWarning(`task ${id}: couldn't record the failed worktree setup: it's gone`)),
        )
        yield* note(id, "error", "Worktree setup failed", e.reason)
        return e
      })

      /**
       * `setup`, for a task whose worktree the setups of `inside` (outermost first) need first: a task's for one stacked
       * on it. One of those can't need its own (it would wait for its own lock), which the start checks should prevent.
       */
      const setupWithin = (id: TaskId, inside: ReadonlyArray<TaskId>): Effect.Effect<Task, WorktreeFailed | TaskNotFound> =>
        inside.includes(id)
          ? fail("its worktree can't be set up: the tasks it starts from start from it")
          : withLock(id)(Effect.suspend(() => setupLocked(id, [...inside, id])))

      /** `setup` while holding the task's worktree lock: whatever another setup did before is seen here. */
      const setupLocked = Effect.fnUntraced(function* (id: TaskId, inside: ReadonlyArray<TaskId>) {
        const { task, project } = yield* load(id)
        if (task.worktree_state === "ready" && task.worktree_path !== null && (yield* exists(task.worktree_path))) return task
        const dir = home(project.repo_path)
        if (!(yield* g.isRepo(dir))) return yield* fail(`${project.repo_path} is not a git repository`)
        const root = home(project.worktrees_root)
        yield* g.run(dir, ["worktree", "prune"]).pipe(Effect.ignore)
        const hasBranch = (b: string) => Effect.map(g.run(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`]), (o) => o.ok)
        const key = project.key.toLowerCase()
        let name = folderName(project, task)
        // A task with no branch yet whose name is taken by a branch with no worktree here isn't given it: that's another
        // task's (a project deleted with its branches kept, then added again with its numbers starting over, or another
        // profile's project with the same key), with its commits. Its own from a setup cut short has its worktree.
        if (task.branch === null) {
          const first = name
          for (let n = 2; (yield* hasBranch(`ia/${key}-${name}`).pipe(Effect.mapError(fromGit))) && !(yield* exists(`${root}/${name}`)); n++)
            name = `${first}-${n}`
        }
        const branch = task.branch ?? `ia/${key}-${name}`
        const wt = `${root}/${name}`
        const branchExists = yield* hasBranch(branch).pipe(Effect.mapError(fromGit))
        yield* write(id, { worktree_state: "setting_up", worktree_error: null })
        // What it was asked to start from counts until its branch exists: that's where it started. Its base branch is
        // saved with the branch (see below), but one made before that was (a setup cut short) is worked out again.
        const fresh = !branchExists && !(yield* exists(wt))
        let picked: Picked | null = null
        if (task.start_from !== null && (fresh || (task.branch === null && task.base_branch === null))) {
          const sf = task.start_from
          const pickedNow = yield* Effect.result(
            base.pickStart(task, project, sf, (other) =>
              setupWithin(other.id, inside).pipe(Effect.catchTag("TaskNotFound", () => fail("the task this one starts from was deleted"))),
            ),
          )
          if (pickedNow._tag === "Failure") return yield* Effect.flip(setupFailed(id, pickedNow.failure))
          picked = pickedNow.success
        }

        const made = yield* Effect.result(
          Effect.gen(function* () {
            const given = picked?.base ?? task.base_branch
            const baseBranch =
              given ?? (project.base_branch !== null && project.base_branch !== "" ? project.base_branch : ((yield* g.currentBranch(dir)) ?? "HEAD"))
            yield* fs.makeDirectory(root, { recursive: true }).pipe(Effect.catch((e) => fail(`creating ${root}: ${e.message}`)))
            let from = baseBranch
            // A folder there already is the task's worktree from before (a setup that didn't finish, say); anything else is
            // in the way, not something to take over and later remove. That includes another task's worktree of the
            // repository: one of another project on it with the same number and title, when their worktrees share a folder.
            if (yield* exists(wt)) {
              if (!(yield* g.isWorktreeOf(dir, wt))) return yield* fail(`${wt} is in the way: it isn't a worktree of ${dir}`)
              const real = (p: string) => Effect.map(g.canonicalize(p), (c) => c ?? p)
              const at = yield* g.checkedOutIn(dir, `refs/heads/${branch}`)
              const ours =
                (at !== null && (yield* real(at)) === (yield* real(wt))) ||
                (task.worktree_path !== null && (yield* real(task.worktree_path)) === (yield* real(wt)))
              if (!ours) return yield* fail(`${wt} is in the way: it's a worktree of ${dir} on another branch than ${branch}`)
            } else if (branchExists) {
              yield* orFail(g.ok(dir, ["worktree", "add", wt, branch]))
            } else {
              for (const [level, text] of picked?.notes ?? []) yield* note(id, level, text)
              const start =
                picked !== null && picked.commit !== null
                  ? { rev: picked.commit[0], from: picked.commit[1], notes: [] }
                  : yield* base.startPoint(dir, baseBranch, yield* base.account(task))
              for (const [level, text, detail] of start.notes) yield* note(id, level, text, detail)
              // Not tracking the branch it starts from (git would for a remote-tracking one).
              yield* orFail(g.ok(dir, ["worktree", "add", "--no-track", "-b", branch, wt, start.rev]))
              from = start.from
              if (task.start_from !== null) yield* orFail(g.ok(dir, ["update-ref", startRef(id), `refs/heads/${branch}`]))
            }
            // Saved as soon as git has them, so a setup script that fails (or a restart meanwhile) doesn't lose where the
            // branch started: setting up again keeps it, and so do the task's checks, which only let what it starts from
            // change before there's a branch.
            yield* write(id, { worktree_path: wt, branch, base_branch: baseBranch })
            yield* note(id, "info", `Worktree ready at ${wt} on branch ${branch} (from ${from})`)
            // Its pull request goes to another task's branch (see `taskBase`): `gh pr create` reads it from there.
            if (!branchExists && given !== null) yield* setMergeBase(g, dir, branch, baseBranch, project.base_branch)
            // Before the setup script, which can rely on them. Nothing already there is overwritten, so a setup that didn't
            // finish can do it again.
            const report = yield* Effect.result(
              bringIn({ git: g, fs }, { repo_path: dir, worktrees_root: root, copy_files: project.copy_files, link_folders: project.link_folders }, wt),
            )
            if (report._tag === "Failure") yield* note(id, "warn", "Couldn't copy or link the project's files into the worktree", report.failure.reason)
            else {
              const ev = reportEvent(report.success)
              if (ev !== null) yield* note(id, ev[0], ev[1], ev[2])
            }
            if (project.setup_script.trim() !== "") {
              yield* note(id, "info", "Running setup script…")
              const log = yield* runScript(scripts, project.setup_script, wt, scriptEnv(project, task, wt, branch), SCRIPT_LIMIT)
              yield* note(id, "info", "Setup script finished", truncate(log, 20000))
            }
            return baseBranch
          }),
        )
        if (made._tag === "Failure") {
          if (made.failure._tag === "TaskNotFound") return yield* made.failure
          return yield* Effect.flip(setupFailed(id, made.failure))
        }
        return yield* write(id, { worktree_state: "ready", worktree_path: wt, branch, base_branch: made.success })
      })

      // The setup goes on to its end in the layer's scope if the caller goes (a launch stopped meanwhile), as the old
      // one did: one cut short half way would leave git's worktree half made.
      const setup = Effect.fn("Worktrees.setup")(function* (id: TaskId, options: ByHand = {}) {
        // Reviewers work in the worktree too.
        if (options.idle === true && (yield* agentInWorktree(id))) return yield* new AgentInWorktree()
        const fiber = yield* Effect.forkIn(setupWithin(id, []), scope)
        return yield* Fiber.join(fiber)
      })

      // ---- teardown ----

      /** `teardown` while holding the task's worktree lock. */
      const teardownLocked = Effect.fnUntraced(function* (id: TaskId, force: boolean, deleteBranch: boolean) {
        const { task, project } = yield* load(id)
        const dir = home(project.repo_path)
        const wt = task.worktree_path
        if (wt === null) return yield* fail("task has no worktree")
        const branch = task.branch ?? ""
        // The tasks stacked on it keep where they took its branch up to before it's gone.
        yield* base.keepStarts(id)
        const checkUncommitted = uncommitted(g, fs, wt).pipe(within("checking the worktree for uncommitted changes"))
        if (yield* exists(wt)) {
          if (!force) {
            const status = yield* checkUncommitted
            if (status !== "") return yield* fail(`worktree has uncommitted changes:\n${truncate(status.trim(), 2000)}`)
            yield* noStrays(g, wt)
          }
          yield* write(id, { worktree_state: "tearing_down" })
          // M6: its terminals are killed here (`Terminals.killAll`), as they'd be left in a deleted folder.
          // And the test servers its agents started from it, which would run on with their build gone.
          yield* leftovers
            .stopTask({ tmp: [taskTmp.dir(task)], worktrees: [wt], data_dir: dataDir.root, tmp_root: taskTmp.root }, `task ${id}`)
            .pipe(Effect.catchCause((cause) => note(id, "warn", "Couldn't stop what the task left running", String(cause))))
          const keep = (e: WorktreeFailed) => Effect.andThen(write(id, { worktree_state: "ready" }), Effect.fail(e))
          if (project.teardown_script.trim() !== "") {
            const ran = yield* Effect.result(runScript(scripts, project.teardown_script, wt, scriptEnv(project, task, wt, branch), SCRIPT_LIMIT))
            if (ran._tag === "Success") yield* note(id, "info", "Teardown script finished", truncate(ran.success, 20000))
            else if (force) yield* note(id, "warn", "Teardown script failed (continuing)", ran.failure.reason)
            else return yield* keep(ran.failure)
          }
          if (force) {
            const o = yield* orFail(g.run(dir, ["worktree", "remove", "--force", wt]))
            if (!o.ok && (yield* exists(wt))) {
              if (yield* removableByHand(g, { worktrees_root: home(project.worktrees_root) }, dir, wt)) {
                yield* fs.remove(wt, { recursive: true }).pipe(Effect.ignore)
              } else {
                const text = `Left ${wt} in place: git won't remove it as a worktree (${o.stderr.trim()}) and it isn't in the project's worktrees folder`
                yield* note(id, "warn", text)
              }
            }
          } else {
            // What the teardown script left would be lost too, so it's checked again, and git's own check (without
            // --force) has the last word.
            const removed = yield* Effect.result(
              Effect.gen(function* () {
                const left = yield* checkUncommitted
                if (left !== "") return yield* fail(`the teardown script left uncommitted changes:\n${truncate(left, 2000)}`)
                yield* noStrays(g, wt)
                const o = yield* orFail(g.run(dir, ["worktree", "remove", wt]))
                return !o.ok && (yield* exists(wt)) ? yield* fail(`git worktree remove failed: ${o.stderr.trim()}`) : undefined
              }),
            )
            if (removed._tag === "Failure") return yield* keep(removed.failure)
          }
        }
        yield* g.run(dir, ["worktree", "prune"]).pipe(Effect.ignore)
        // 4.3: its checkpoints are of files that are gone now, and the next run takes a new baseline
        // (`Checkpoints.forget(task)`). Not before: a teardown that keeps the worktree keeps them too.
        const columns: TaskColumns = { worktree_state: "none", worktree_path: null, worktree_error: null }
        if (deleteBranch && branch !== "") {
          const o = yield* g.run(dir, ["branch", "-D", branch]).pipe(Effect.orElseSucceed(() => ({ ok: false, stderr: "git could not run" })))
          if (o.ok) {
            columns.branch = null
            yield* note(id, "info", `Deleted branch ${branch}`)
          } else yield* note(id, "warn", `Could not delete branch ${branch}`, o.stderr)
        }
        yield* note(id, "info", "Worktree removed")
        return yield* write(id, columns)
      })

      const teardown = Effect.fn("Worktrees.teardown")(function* (id: TaskId, options: ByHand & { readonly force: boolean; readonly deleteBranch: boolean }) {
        if (options.idle === true && (yield* agentInWorktree(id))) return yield* new AgentInWorktree()
        return yield* withLock(id)(teardownLocked(id, options.force, options.deleteBranch))
      })

      // ---- removing merged worktrees ----

      /**
       * Where `head` (the HEAD of a task's worktree `wt`) has been merged: `into`, its upstream (fetched first with
       * `fetch`), or the base of `branch`'s merged pull request (squashed or rebased) whose head it is, read as `account`
       * (not at all when gh can't be asked, rather than as another account).
       */
      const mergedInto = Effect.fnUntraced(function* (
        dir: string,
        wt: string,
        into: string,
        branch: string | null,
        head: string,
        fetch: boolean,
        account: string | null,
      ) {
        const contains = (rev: string) => g.isAncestor(dir, head, rev)
        if (yield* contains(`refs/heads/${into}`)) return into
        const up = yield* base.upstream(dir, into)
        if (up !== null) {
          if (fetch) yield* base.fetch(dir, up, account).pipe(Effect.ignore)
          if (yield* contains(up.tracking)) return upstreamName(up)
        }
        if (branch === null) return null
        const pr = yield* gh.pullRequest(wt, account, branch, null).pipe(Effect.orElseSucceed(() => null))
        if (pr === null || !(pr.state === "MERGED" && pr.headRefOid === head)) return null
        return `${pr.baseRefName} (${pr.url})`
      })

      const removeIfMerged = Effect.fn("Worktrees.removeIfMerged")(function* (id: TaskId, fetch: boolean) {
        return yield* withLock(id)(
          Effect.gen(function* () {
            const { task, project } = yield* load(id)
            const busy = agentInWorktree(id)
            if (task.kind !== "task" || task.status !== "done") return kept("it isn't done")
            const wt = task.worktree_path
            if (wt === null || task.worktree_state !== "ready" || !(yield* isDir(wt))) return kept("it has no worktree")
            if (task.running || (yield* busy)) return kept("an agent is working in it")
            const dir = home(project.repo_path)
            const into = yield* base.taskBase(task, project)
            if (into === null) return kept("it has no base branch to be merged into")
            const status = yield* uncommitted(g, fs, wt)
            if (status !== "") {
              const n = status.split("\n").length
              return kept(`it has ${n} uncommitted or untracked file${n === 1 ? "" : "s"}`)
            }
            const head = (yield* orFail(g.ok(wt, ["rev-parse", "--verify", "HEAD"]))).trim()
            const account = yield* base.account(task)
            let found = yield* mergedInto(dir, wt, into, task.branch, head, fetch, account)
            // One stacked on another task's branch may have gone into the project's base branch with it, or after it (its
            // pull request retargeted there); its own pull request was asked about already.
            const stacked = task.start_from?.type === "task" || task.start_from?.type === "pull_request"
            const main = project.base_branch
            if (found === null && stacked && main !== null && main !== "" && main !== into) found = yield* mergedInto(dir, wt, main, null, head, fetch, account)
            if (found === null) return kept(`its work isn't merged into ${into}`)
            // Started meanwhile (fetching takes a while)?
            if (yield* busy) return kept("an agent is working in it")
            const what = task.branch !== null ? `The task and branch ${task.branch} are` : "The task is"
            yield* note(
              id,
              "info",
              `Removing the worktree: its work is merged into ${found} and nothing in it is uncommitted. ${what} kept; the worktree is set up again if the agent runs again.`,
            )
            // Not forced, so teardown checks again just before removing it.
            yield* teardownLocked(id, false, false)
            const removed: Removal = { _tag: "Removed", into: found }
            return removed
          }),
        )
      })

      const removeMerged = Effect.fn("Worktrees.removeMerged")(function* (projectId: ProjectId) {
        const project = Option.getOrNull(yield* projects.get(projectId))
        if (project === null) return yield* new ProjectNotFound({ id: projectId })
        const dir = home(project.repo_path)
        const done = (yield* repo.projectTasks(projectId))
          .filter((t) => t.kind === "task" && t.status === "done" && t.worktree_state === "ready")
          .toSorted((a, b) => a.number - b.number)
        const bases = new Set<string>()
        for (const t of done) {
          const b = yield* base.taskBase(t, project)
          if (b !== null) bases.add(b)
        }
        const own = project.github_account?.trim() ?? ""
        const account = own !== "" ? own : (Option.getOrNull(yield* profiles.get(project.profile_id))?.github_account?.trim() ?? null)
        for (const b of [...bases].toSorted()) {
          yield* base
            .fetchBase(dir, b, account === "" ? null : account)
            .pipe(Effect.catch((e) => Effect.logWarning(`project ${projectId}: couldn't fetch ${b}'s upstream: ${e.reason}`)))
        }
        const results: Array<MergedWorktreeResult> = []
        for (const t of done) {
          const r = yield* Effect.result(removeIfMerged(t.id, false))
          const [removed, detail] =
            r._tag === "Failure"
              ? [false, r.failure._tag === "TaskNotFound" ? "the task was deleted" : r.failure.reason]
              : r.success._tag === "Removed"
                ? [true, `merged into ${r.success.into}`]
                : [false, r.success.why]
          results.push({ task_id: t.id, number: t.number, title: t.title, removed, detail })
        }
        return results
      })

      // ---- deletion and recovery ----

      const forDeletion = Effect.fn("Worktrees.forDeletion")(function* (task: Task, deleteBranch: boolean) {
        // Read again once a setup under way is done: it may have made the worktree since.
        yield* withLock(task.id)(
          Effect.gen(function* () {
            const now = yield* repo.get(task.id)
            if (now === null || now.worktree_path === null) return
            yield* teardownLocked(task.id, true, deleteBranch).pipe(
              Effect.catch((e) => Effect.logWarning(`teardown during delete failed: ${e._tag === "WorktreeFailed" ? e.reason : "the task is gone"}`)),
            )
          }),
        )
        const now = (yield* repo.get(task.id)) ?? task
        // The tasks stacked on it keep going where it went.
        yield* base.unstack(now)
        if (now.start_from !== null && now.project_id !== null) {
          const project = Option.getOrNull(yield* projects.get(now.project_id))
          if (project !== null) yield* base.forgetStart(home(project.repo_path), now.id)
        }
      })

      const deleteProject = Effect.fn("Worktrees.deleteProject")(function* (projectId: ProjectId) {
        const project = Option.getOrNull(yield* projects.get(projectId))
        if (project === null) return yield* new ProjectNotFound({ id: projectId })
        yield* refuseWhileRunning(yield* projects.running(projectId), (n) => `${n} of the project's agents ${n === 1 ? "is" : "are"} running; stop them first`)
        const dir = home(project.repo_path)
        let removed = false
        // All its threads: tasks, review threads and any other kind.
        for (const t of yield* repo.projectTasks(projectId)) {
          if (t.start_from !== null) yield* base.forgetStart(dir, t.id)
          // Read again once a setup under way is done: it may have made the worktree since, which would be left behind
          // with no project to show it.
          const wt = yield* withLock(t.id)(Effect.map(repo.get(t.id), (now) => now?.worktree_path ?? null))
          if (wt === null) continue
          removed = true
          // 4.3: its checkpoints go too (`Checkpoints.forget`).
          yield* g.run(dir, ["worktree", "remove", "--force", wt]).pipe(Effect.ignore)
        }
        if (removed) yield* g.run(dir, ["worktree", "prune"]).pipe(Effect.ignore)
        return yield* projectsService.delete(projectId)
      })

      const recover = Effect.fn("Worktrees.recover")(function* () {
        for (const t of yield* repo.all) {
          if (t.worktree_state === "setting_up") {
            yield* write(t.id, { worktree_state: "error", worktree_error: "the server stopped while the worktree was being set up" }).pipe(Effect.ignore)
          } else if (t.worktree_state === "tearing_down") {
            const there = t.worktree_path !== null && (yield* exists(t.worktree_path))
            yield* write(t.id, there ? { worktree_state: "ready" } : { worktree_state: "none", worktree_path: null, worktree_error: null }).pipe(Effect.ignore)
          }
        }
      })

      return Worktrees.of({
        setup,
        teardown,
        removeIfMerged,
        removeMerged,
        agentInWorktree,
        forDeletion,
        deleteProject,
        recover: recover(),
        withLock: (task) => withLock(task),
      })
    }),
  )
}
