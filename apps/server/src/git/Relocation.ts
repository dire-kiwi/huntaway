import { Context, Deferred, Effect, FileSystem, Layer, Option, Path, Ref } from "effect"
import type { PlatformError } from "effect"
import { Conflict, Invalid } from "@huntaway/contracts"
import type { Project, ProjectId, ProjectPatch, Task } from "@huntaway/contracts"
import { Actor } from "../platform/Changes.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { AgentConfigRepo } from "../profiles/AgentConfigRepo.ts"
import { ProjectRepo } from "../projects/ProjectRepo.ts"
import { isHistory, Projects } from "../projects/Projects.ts"
import type { ProjectNotFound, Relocated } from "../projects/Projects.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { Tasks } from "../tasks/Tasks.ts"
import { Git } from "./Git.ts"
import { expandHome, lines, pathStartsWith, samePath, stripPathPrefix } from "./paths.ts"
import { RelocationRepo } from "./RelocationRepo.ts"
import { relink } from "./worktree/files.ts"
import { folderName } from "./worktree/folder.ts"

// Changing a project's repository folder (docs/plan/inventory/04-git-review.md §2.20; huntaway's git/relocate.ts):
// pointing the project at where its folder is now (after it was moved or renamed outside the board), or moving the
// folder there. Either way the paths stored inside the folder (worktrees kept in it, the worktrees folder) move along,
// the task worktrees are reconnected to the repository (`git worktree repair`, and by hand where an older git leaves a
// link), and Claude conversations that ran in the old folders are copied to where Claude looks for them in the new
// ones, so those tasks can still be resumed. It is in the git area (not projects/, where the plan put it): it needs the
// tasks' rows, git and the worktrees' linked folders, and `Worktrees` holds the folder through it during a setup.

/** The name of the folder Claude Code keeps the conversations run in `cwd` in. */
export const claudeProjectDir = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/gu, "-")

/** Where the paths inside the old folder (by the path stored or the one it really was at) are now. */
const mapping =
  (from: ReadonlyArray<string>, to: string) =>
  (p: string): string | null => {
    for (const f of from) {
      const rest = stripPathPrefix(p, f)
      if (rest !== null) return rest === "" ? to : `${to}/${rest}`
    }
    return null
  }
type Mapping = ReturnType<typeof mapping>

const repoPath = (reason: string) => new Invalid({ field: "repo_path", reason })

/** `m` with `project`'s count changed by `by` (gone at 0). */
const bump = (m: ReadonlyMap<ProjectId, number>, project: ProjectId, by: number) => {
  const out = new Map(m)
  const n = (out.get(project) ?? 0) + by
  if (n <= 0) out.delete(project)
  else out.set(project, n)
  return out
}

interface Moves {
  /** The projects whose folders are moving, and what their moves' ends are awaited by. */
  readonly moving: ReadonlyMap<ProjectId, Deferred.Deferred<void>>
  /** How many worktree setups hold each project's folder where it is. */
  readonly holds: ReadonlyMap<ProjectId, number>
}

export interface RelocationShape {
  /**
   * `Projects.update`, and with a new `repo_path` the project's folder changes: with `move_repo` the folder is moved
   * there (refused while a worktree setup holds it, its agents run, another project is on it…), else it is checked to be
   * the project's repository where it is now. Either way its worktrees, links and conversations follow.
   */
  readonly update: (id: ProjectId, patch: ProjectPatch) => Effect.Effect<Project, ProjectNotFound | Invalid | Conflict>
  /** Whether the project's folder can change to `to` (see `update`), changing nothing. */
  readonly check: (project: Project, to: string, moveFolder: boolean) => Effect.Effect<void, Invalid | Conflict>
  /** Run `effect` (a worktree setup) holding the project's folder where it is, once a move under way is done. */
  readonly hold: (project: ProjectId) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  /** Wait while the project's folder is moving, so what's read of the project afterwards says where it is. */
  readonly settled: (project: ProjectId) => Effect.Effect<void>
  /** Whether the project's folder is moving now. */
  readonly isMoving: (project: ProjectId) => Effect.Effect<boolean>
  /** The worktrees registered in `repo`, by their real paths. */
  readonly worktreeList: (repo: string) => Effect.Effect<ReadonlySet<string>>
}

export class Relocation extends Context.Service<Relocation, RelocationShape>()("huntaway-server/git/Relocation") {
  static readonly layer = Layer.effect(
    Relocation,
    Effect.gen(function* () {
      const g = yield* Git
      const projects = yield* Projects
      const projectRepo = yield* ProjectRepo
      const tasks = yield* Tasks
      const taskRepo = yield* TaskRepo
      const configs = yield* AgentConfigRepo
      const rows = yield* RelocationRepo
      const config = yield* ServerConfig
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const state = yield* Ref.make<Moves>({ moving: new Map(), holds: new Map() })

      const home = (p: string) => expandHome(p, config.home)
      const exists = (p: string) => fs.exists(p).pipe(Effect.orElseSucceed(() => false))
      const kind = (p: string) =>
        fs.stat(p).pipe(
          Effect.map((i) => i.type),
          Effect.orElseSucceed(() => null),
        )
      const isDir = (p: string) => Effect.map(kind(p), (k) => k === "Directory")
      const isFile = (p: string) => Effect.map(kind(p), (k) => k === "File")
      const isGitRoot = (p: string) => exists(`${p}/.git`)
      const realPath = (p: string) => fs.realPath(p).pipe(Effect.orElseSucceed(() => null))
      const canonical = (p: string) => Effect.map(realPath(p), (r) => r ?? p)
      const readText = (p: string) => fs.readFileString(p).pipe(Effect.orElseSucceed(() => null))
      const readDir = (dir: string) =>
        fs.readDirectory(dir).pipe(
          Effect.orElseSucceed((): ReadonlyArray<string> => []),
          Effect.map((names) => names.toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((n) => path.join(dir, n))),
        )
      const gitQuiet = (dir: string, args: ReadonlyArray<string>) => g.run(dir, args).pipe(Effect.orElseSucceed(() => null))
      /** `path` without its `.` and `..` parts, worked out from the path alone. */
      const normalize = (p: string) => {
        const n = path.normalize(p)
        return n.length > 1 && n.endsWith("/") ? n.slice(0, -1) : n
      }

      // ---- moving and holding ----

      const settled = (project: ProjectId) =>
        Effect.flatMap(Ref.get(state), (s) => {
          const d = s.moving.get(project)
          return d === undefined ? Effect.void : Deferred.await(d)
        })

      /** Takes a hold once no move is under way, waiting for one that is. */
      const takeHold = (project: ProjectId): Effect.Effect<void> =>
        Effect.flatMap(
          Ref.modify(state, (s): readonly [Deferred.Deferred<void> | null, Moves] => {
            const d = s.moving.get(project)
            return d !== undefined ? [d, s] : [null, { ...s, holds: bump(s.holds, project, 1) }]
          }),
          (d) => (d === null ? Effect.void : Effect.andThen(Deferred.await(d), takeHold(project))),
        )

      const hold =
        (project: ProjectId) =>
        <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
          Effect.uninterruptibleMask((restore) =>
            Effect.andThen(
              restore(takeHold(project)),
              restore(effect).pipe(Effect.ensuring(Ref.update(state, (s) => ({ ...s, holds: bump(s.holds, project, -1) })))),
            ),
          )

      /** Marks the project's folder as moving around `effect`: refused while a setup holds it; after a move under way. */
      const moving =
        (project: ProjectId) =>
        <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | Conflict, R> =>
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const done = yield* Deferred.make<void>()
              const take: Effect.Effect<void, Conflict> = Effect.flatMap(
                Ref.modify(state, (s): readonly [Deferred.Deferred<void> | "held" | null, Moves] => {
                  if ((s.holds.get(project) ?? 0) > 0) return ["held", s]
                  const d = s.moving.get(project)
                  return d !== undefined ? [d, s] : [null, { ...s, moving: new Map(s.moving).set(project, done) }]
                }),
                (d) =>
                  d === "held"
                    ? Effect.fail(
                        new Conflict({ reason: "in_use", detail: "one of the project's task worktrees is being set up; move its folder once that's done" }),
                      )
                    : d === null
                      ? Effect.void
                      : Effect.andThen(Deferred.await(d), take),
              )
              yield* restore(take)
              return yield* restore(effect).pipe(
                Effect.ensuring(
                  Effect.andThen(
                    Ref.update(state, (s) => {
                      const m = new Map(s.moving)
                      m.delete(project)
                      return { ...s, moving: m }
                    }),
                    Deferred.succeed(done, undefined),
                  ),
                ),
              )
            }),
          )

      // ---- checks ----

      /** The paths `old` goes by: as stored, and where the folder really is (where Claude kept the conversations run in it). */
      const oldFolders = (old: string) =>
        Effect.map(realPath(old), (real): ReadonlyArray<string> => (real !== null && !samePath(real, old) ? [old, real] : [old]))

      const worktreeList = Effect.fn("Relocation.worktreeList")(function* (repo: string) {
        const o = yield* gitQuiet(repo, ["worktree", "list", "--porcelain"])
        if (o === null) return new Set<string>()
        const out = new Set<string>()
        for (const l of lines(o.stdout)) if (l.startsWith("worktree ")) out.add(yield* canonical(l.slice("worktree ".length)))
        return out
      })

      const checkMove = Effect.fnUntraced(function* (project: Project, to: string, threads: ReadonlyArray<Task>) {
        const old = project.repo_path
        // Only this project's paths follow the folder: another project's (in any profile) on it, or on a folder inside it,
        // would be left pointing where it was, with its agents' folder gone from under them.
        const others = (yield* projectRepo.folders).filter((p) => p.id !== project.id && pathStartsWith(home(p.repo_path), home(old)))
        if (others.length > 0) {
          const names = others.map((p) => p.name).join(", ")
          return yield* new Conflict({
            reason: "in_use",
            detail: `${old} is also the folder of ${others.length === 1 ? "project" : "projects"} ${names}; move it there, or set each project's new path without moving`,
          })
        }
        if (Option.isSome(yield* Effect.option(fs.readLink(old)))) {
          const target = (yield* realPath(old)) ?? "a missing folder"
          return yield* repoPath(`${old} is a link to ${target}; set the repository path to the folder itself instead of moving the link`)
        }
        if (!(yield* isDir(old)))
          return yield* repoPath(`${old} doesn't exist, so there's nothing to move; if the folder has already moved, set its new path without moving`)
        if (yield* exists(to)) return yield* repoPath(`${to} already exists`)
        const parent = path.dirname(to)
        if (!(yield* isDir(parent)) || samePath(parent, to)) return yield* repoPath(`${to}'s parent folder doesn't exist`)
        if (pathStartsWith(to, old)) return yield* repoPath(`${to} is inside ${old}`)
        // Their agents are in the folder, or run git in it.
        const n = threads.filter((t) => t.running).length
        if (n > 0) {
          return yield* new Conflict({
            reason: "agent_running",
            detail: `${n} of the project's agents ${n === 1 ? "is" : "are"} running; stop ${n === 1 ? "it" : "them"} before moving its folder`,
          })
        }
        return yield* Effect.void
      })

      /**
       * Checks that `to` is the project's repository (after it was moved there, or by another path to it), so its tasks'
       * worktrees and branches are still there and its agents work on it.
       */
      const checkSameRepo = Effect.fnUntraced(function* (project: Project, to: string, threads: ReadonlyArray<Task>, map: Mapping) {
        const old = project.repo_path
        const a = yield* realPath(old)
        if (a !== null && a === (yield* realPath(to))) return yield* Effect.void
        const notIt = (why: string) => repoPath(`${to} doesn't look like the project's repository: ${why}`)
        if ((yield* exists(old)) && (yield* isGitRoot(old))) {
          // The folder is still there, so it hasn't moved, and `to` (which isn't it, or a link to it) is another folder,
          // even if it's a checkout of the same repository.
          return yield* repoPath(`${to} isn't the project's repository folder, which is still at ${project.repo_path}`)
        }
        // The folder has moved: the repository there has the project's worktrees (those kept inside it moved along, and
        // it still knows them by their old paths)…
        const worktrees: Array<string> = []
        for (const t of threads) {
          const wt = t.worktree_path
          if (wt === null) continue
          const moved = map(wt)
          if ((yield* exists(wt)) || (moved !== null && (yield* exists(moved)))) worktrees.push(wt)
        }
        if (worktrees.length > 0) {
          if (!(yield* isGitRoot(to))) return yield* notIt("it isn't a git repository")
          const listed = yield* worktreeList(to)
          const missing: Array<string> = []
          for (const wt of worktrees) {
            // By its old path, or its new one if it has been repaired already.
            const moved = map(wt)
            const known = listed.has(yield* canonical(wt)) || listed.has(wt) || (moved !== null && listed.has(yield* canonical(moved)))
            if (!known) missing.push(wt)
          }
          if (missing.length === 0) return yield* Effect.void
          return yield* notIt(`it doesn't have the task worktree${missing.length === 1 ? "" : "s"} ${missing.join(", ")}`)
        }
        // …or the history it started from…
        const roots = yield* projects.repoRoot(project.id)
        if (isHistory(roots)) {
          if (!(yield* isGitRoot(to))) return yield* notIt("it isn't a git repository, and the project's was")
          const theirs = yield* projects.fingerprint(to)
          if (!isHistory(theirs)) return yield* notIt("it has no commits, and the project's repository had")
          const ours = theirs.split(" ")
          if (roots.split(" ").some((r) => ours.includes(r))) return yield* Effect.void
          // A shallow clone's history starts where it was cut off, which is no root once the rest is fetched (HA-42): the
          // commit is in the history all the same.
          for (const r of roots.split(" ")) if ((yield* gitQuiet(to, ["merge-base", "--is-ancestor", r, "HEAD"]))?.ok === true) return yield* Effect.void
          return yield* notIt("it has none of the commits the project's history started from")
        }
        // …or, when the board doesn't know its history, its tasks' branches.
        const branches = [...new Set(threads.flatMap((t) => (t.branch === null ? [] : [t.branch])))]
        if (branches.length === 0) {
          const fix = (yield* exists(old))
            ? "To move the project's folder, move it with the board to a path that doesn't exist yet; to use that folder, add it as a new project"
            : "Move the folder back and move it with the board instead, or add it as a new project"
          return yield* repoPath(
            `can't tell whether ${to} is the same folder as the project's (${project.repo_path}): the board has no record of its git history. ${fix}`,
          )
        }
        for (const b of branches) if ((yield* gitQuiet(to, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`]))?.ok === true) return yield* Effect.void
        return yield* notIt("it has none of its tasks' branches")
      })

      const check = Effect.fn("Relocation.check")(function* (project: Project, given: string, moveFolder: boolean) {
        const to = home(given)
        if (!path.isAbsolute(to)) return yield* repoPath(`the repository path must be absolute (got ${given})`)
        const threads = yield* rows.threads(project.id)
        if (moveFolder) return yield* checkMove(project, to, threads)
        if (!(yield* isDir(to))) return yield* repoPath(`${to} isn't a folder`)
        const n = yield* canonical(to)
        return yield* checkSameRepo(project, n, threads, mapping(yield* oldFolders(project.repo_path), n))
      })

      // ---- the change ----

      /** The git folder `repo` and its worktrees share: its .git, or for a linked checkout, its main checkout's. */
      const commonDir = (repo: string) =>
        Effect.map(gitQuiet(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), (o) => (o?.ok === true ? o.stdout.trim() : null))

      /**
       * Points git's links between the worktrees and their git folder `common` at where they are now when they still name
       * an old folder: older versions of `git worktree repair` leave a link alone while its old path still leads to the
       * right place (through a symlink, say).
       */
      const relinkGit = Effect.fnUntraced(function* (common: string, map: Mapping, worktrees: ReadonlyArray<string>) {
        const fix = Effect.fnUntraced(function* (file: string, prefix: string) {
          const text = yield* readText(file)
          if (text === null) return
          const t = text.trimEnd()
          if (!t.startsWith(prefix)) return
          const old = t.slice(prefix.length)
          const n = map(old)
          if (n === null || samePath(n, old)) return
          yield* fs.writeFileString(file, `${prefix}${n}\n`).pipe(Effect.catch((e) => Effect.logWarning(`pointing ${file} at ${n}: ${e.message}`)))
        })
        // Each worktree's .git file names its folder in the git folder's worktrees, and that folder's gitdir file names the
        // worktree's .git file (the project's own too, when it's a linked checkout).
        for (const wt of worktrees) yield* fix(`${wt}/.git`, "gitdir: ")
        for (const d of yield* readDir(`${common}/worktrees`)) yield* fix(`${d}/gitdir`, "")
      })

      /** The submodules' git folders in `dir` (a .git/modules), theirs included: a name may have slashes in it. */
      const findModules = (dir: string): Effect.Effect<ReadonlyArray<string>> =>
        Effect.gen(function* () {
          const out: Array<string> = []
          for (const e of yield* readDir(dir)) {
            if (!(yield* isDir(e))) continue
            if ((yield* isFile(`${e}/HEAD`)) && (yield* isFile(`${e}/config`))) {
              out.push(...(yield* findModules(`${e}/modules`)), e)
            } else out.push(...(yield* findModules(e)))
          }
          return out
        })

      /**
       * Reconnects the submodules checked out in the moved repository folder `repo` and its worktrees with their git
       * folders in `common`. Git links the two with paths relative to each other, which no longer lead there once only one
       * of them has moved. Links that still lead to the right place are left as they are.
       */
      const relinkSubmodules = Effect.fnUntraced(function* (repo: string, common: string, map: Mapping, from: ReadonlyArray<string>) {
        const modules = [...(yield* findModules(`${common}/modules`))]
        for (const d of yield* readDir(`${common}/worktrees`)) modules.push(...(yield* findModules(`${d}/modules`)))
        // Where the repository was, as git saw it.
        const old = from[from.length - 1]
        if (old === undefined) return
        for (const module of modules) {
          const configFile = `${module}/config`
          const o = yield* gitQuiet(repo, ["config", "-f", configFile, "--get", "core.worktree"])
          if (o === null || !o.ok) continue
          const wtree = o.stdout.trim()
          // The checkout, from where the module's folder was (moved along if it's in the folder), and where it is now.
          const inside = stripPathPrefix(module, repo)
          const was = inside !== null ? path.join(old, inside) : module
          const at = normalize(path.join(was, wtree))
          const checkout = map(at) ?? at
          const gitfile = `${checkout}/.git`
          const text = yield* readText(gitfile)
          if (text === null || !text.trimEnd().startsWith("gitdir: ")) continue
          const linked = text.trimEnd().slice("gitdir: ".length)
          if (!samePath(normalize(path.isAbsolute(linked) ? linked : path.join(checkout, linked)), module)) {
            const rel = path.relative(checkout, module)
            yield* fs
              .writeFileString(gitfile, `gitdir: ${rel}\n`)
              .pipe(Effect.catch((e) => Effect.logWarning(`pointing ${gitfile} at ${module}: ${e.message}`)))
          }
          if (!samePath(normalize(path.isAbsolute(wtree) ? wtree : path.join(module, wtree)), checkout)) {
            const set = yield* gitQuiet(repo, ["config", "-f", configFile, "core.worktree", path.relative(module, checkout)])
            if (set !== null && !set.ok) yield* Effect.logWarning(`pointing ${module} at ${checkout}: ${set.stderr.trim()}`)
          }
        }
      })

      /**
       * Copies the files in `from` that `to` doesn't have, or has an older copy of. Copies keep their original's time, so
       * one that hasn't changed on either side since isn't copied again.
       */
      const copyNewer = (from: string, to: string): Effect.Effect<void, PlatformError.PlatformError> =>
        Effect.gen(function* () {
          const st = yield* fs.stat(from)
          if (st.type === "Directory") {
            yield* fs.makeDirectory(to, { recursive: true })
            for (const name of yield* fs.readDirectory(from)) yield* copyNewer(`${from}/${name}`, `${to}/${name}`)
            return
          }
          const mtime = Option.getOrNull(st.mtime)
          const there = yield* Effect.option(fs.stat(to))
          const theirs = Option.isSome(there) ? Option.getOrNull(there.value.mtime) : null
          if (theirs !== null && mtime !== null && theirs.getTime() >= mtime.getTime()) return
          yield* fs.makeDirectory(path.dirname(to), { recursive: true })
          yield* fs.copyFile(from, to)
          if (mtime !== null) yield* fs.utimes(to, mtime, mtime)
        })

      /** The Claude config folder a thread's conversation is in (the old `task_config_dir`); none for a Codex thread. */
      const conversationDir = Effect.fnUntraced(function* (t: Task, session: string) {
        let cfg = t.claude_config_id === null ? null : Option.getOrNull(yield* configs.get(t.claude_config_id))
        if (cfg === null && t.claude_config_id !== null) {
          // Its config is gone: the first it can use.
          const project = t.project_id === null ? null : yield* taskRepo.project(t.project_id)
          const [first] = yield* taskRepo.configs(t.profile_id, project)
          cfg = first === undefined ? null : Option.getOrNull(yield* configs.get(first))
        }
        if (cfg?.agent === "codex") return null
        const current = cfg === null || cfg.config_dir.trim() === "" ? null : cfg.config_dir.trim()
        const was = (yield* rows.sessionConfigDir(t.id, session))?.trim() ?? null
        let dir = current
        if (was !== null && was !== (current ?? "")) dir = was === "" ? null : (yield* exists(home(was))) ? was : current
        return home(dir ?? config.agentEnv["CLAUDE_CONFIG_DIR"] ?? "~/.claude")
      })

      /**
       * Claude Code keeps a conversation under its config's `projects/<folder>`, named after the folder it ran in, and only
       * resumes it from there. Copies the thread's, if it ran in one of `from`, to `to`'s, leaving the original.
       */
      const copySession = Effect.fnUntraced(function* (t: Task, from: ReadonlyArray<string>, to: string) {
        const sid = t.session_id
        if (sid === null) return
        const dir = yield* conversationDir(t, sid)
        if (dir === null) return
        const dest = `${dir}/projects/${claudeProjectDir(to)}`
        for (const f of from) {
          const src = `${dir}/projects/${claudeProjectDir(f)}`
          if (src === dest || !(yield* exists(`${src}/${sid}.jsonl`))) continue
          // The transcript, and its folder of subagents' transcripts and tool results.
          for (const name of [`${sid}.jsonl`, sid]) {
            if (!(yield* exists(`${src}/${name}`))) continue
            yield* copyNewer(`${src}/${name}`, `${dest}/${name}`).pipe(
              Effect.catchCause((cause) => Effect.logWarning(`copying ${src}/${name} to ${dest}/${name}`, cause)),
            )
          }
          return
        }
      })

      /** The folder a task's worktree is in, or was in before it was removed, which is where setting it up again puts it. */
      const worktreeFolder = (project: Project, task: Task): string | null =>
        task.worktree_path ?? (task.branch === null ? null : `${home(project.worktrees_root)}/${folderName(project, task)}`)

      /** Moves the folder `old` to `to` (see `checkMove`). */
      const moveDir = (old: string, to: string) =>
        fs.rename(old, to).pipe(
          Effect.mapError((e) => {
            const hint = e.message.includes("EXDEV") ? " (it's on another filesystem: move it yourself, then set the new path)" : ""
            return repoPath(`moving ${old} to ${to}: ${e.message}${hint}`)
          }),
        )

      /** Changes `project`'s folder to `given`, moving it there first when `moveFolder`: the project's paths to store. */
      const change = Effect.fnUntraced(function* (project: Project, given: string, moveFolder: boolean) {
        yield* check(project, given, moveFolder)
        const to = home(given)
        const old = project.repo_path
        const from = yield* oldFolders(old)
        const threads = yield* rows.threads(project.id)
        if (moveFolder) yield* moveDir(old, to)
        const n = yield* canonical(to)
        const map = mapping(from, n)
        // Worktrees kept inside the repository moved along with it.
        const moved: Array<string> = []
        for (const t of threads) {
          const wt = t.worktree_path
          if (wt === null) continue
          const dest = map(wt)
          if (dest === null || samePath(dest, wt)) continue
          yield* tasks.change(t.id, () => ({ worktree_path: dest }), Actor.board).pipe(Effect.ignore)
          moved.push(dest)
        }
        if (yield* isGitRoot(n)) {
          // Points the worktrees' .git files at the repository's new place, and the repository at the worktrees that moved.
          const repaired = yield* g.run(n, ["worktree", "repair", ...moved]).pipe(Effect.result)
          if (repaired._tag === "Failure") yield* Effect.logWarning(`git worktree repair in ${n}: ${repaired.failure.message}`)
          else if (!repaired.success.ok) yield* Effect.logWarning(`git worktree repair in ${n}: ${repaired.success.stderr.trim()}`)
          const worktrees = threads.flatMap((t) => (t.worktree_path === null ? [] : [map(t.worktree_path) ?? t.worktree_path]))
          const common = (yield* commonDir(n)) ?? `${n}/.git`
          yield* relinkGit(common, map, worktrees)
          // The folders linked into them lead into the old folder.
          for (const wt of worktrees) {
            yield* relink({ git: g, fs }, wt, project.link_folders, map).pipe(
              Effect.catchCause((cause) => Effect.logWarning(`relinking the folders in ${wt}`, cause)),
            )
          }
          yield* relinkSubmodules(n, common, map, from)
        }
        const inside = (p: string): string | null => {
          const dest = map(p)
          return dest !== null && dest !== p ? dest : null
        }
        const scratch = inside(project.scratch_path)
        // Each thread's conversation, from the folder it ran in: the repository, or its worktree (a review thread's is the
        // task's it reviews).
        for (const t of threads) {
          yield* copySession(t, from, n)
          const ownerId = t.kind === "review" ? t.parent_id : t.id
          const owner = threads.find((o) => ownerId !== null && o.id === ownerId)
          const was = owner === undefined ? null : worktreeFolder(project, owner)
          if (was !== null) {
            const dest = map(was)
            if (dest !== null && !samePath(dest, was)) yield* copySession(t, [was], dest)
          }
        }
        // Scratch tasks that were the project's scratch chats work in its scratch folder.
        if (scratch !== null) {
          for (const t of yield* rows.inWorkDir(project.scratch_path)) {
            yield* copySession(t, [project.scratch_path], scratch)
            yield* tasks.change(t.id, () => ({ work_dir: scratch }), Actor.board).pipe(Effect.ignore)
          }
        }
        const out: Relocated = {
          repo_path: n,
          worktrees_root: inside(project.worktrees_root),
          scratch_path: scratch,
          repo_root: yield* projects.fingerprint(n),
        }
        return out
      })

      const update = Effect.fn("Relocation.update")(function* (id: ProjectId, patch: ProjectPatch) {
        const before = yield* projects.get(id)
        const given = patch.repo_path?.trim()
        const changes = given !== undefined && home(given) !== before.repo_path
        if (patch.move_repo === true && !changes)
          return yield* new Invalid({ field: "move_repo", reason: "move_repo needs a new repo_path to move the folder to" })
        if (!changes) {
          const { move_repo: _move, ...rest } = patch
          return yield* projects.update(id, rest)
        }
        // Agents of the project wait to start until the project says where it is now (`settled`).
        return yield* moving(id)(projects.relocate(id, patch, (p) => change(p, given, patch.move_repo === true)))
      })

      return Relocation.of({ update, check, hold, settled, worktreeList, isMoving: (project) => Effect.map(Ref.get(state), (s) => s.moving.has(project)) })
    }),
  )
}
