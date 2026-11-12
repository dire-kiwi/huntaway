import { Context, type Duration, Effect, FileSystem, Layer, Option, Path, Schedule, Schema } from "effect"
import { SecureRandom } from "effect/crypto"
import { Invalid, Project, ProjectId } from "@huntaway/contracts"
import type { Conflict, NewProject, ProfileId, ProjectPatch, Timestamp } from "@huntaway/contracts"
import { Changes } from "../platform/Changes.ts"
import { DataDir } from "../platform/DataDir.ts"
import { Db } from "../platform/Db.ts"
import { Events } from "../platform/Events.ts"
import { KeyedLock } from "../platform/KeyedLock.ts"
import { Proc } from "../platform/Proc.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { AgentConfigRepo } from "../profiles/AgentConfigRepo.ts"
import { blank, checkConfigIds, checkGithubAccount, ifGiven, refuseWhileRunning, reviewersValue } from "../profiles/checks.ts"
import { removeUnusedDir } from "../profiles/dataFolders.ts"
import { ProfileRepo } from "../profiles/ProfileRepo.ts"
import { ProfileNotFound } from "../profiles/Profiles.ts"
import { nowTimestamp } from "../platform/columns.ts"
import { expandTilde } from "../settings/Folders.ts"
import { checkFileList, checkGroupName, checkName, checkPreviewUrl, checkReviewRounds, tidyStatusScripts } from "./checks.ts"
import { checkKey, formerKeysAfter, newProjectKey, normalizeKey } from "./keys.ts"
import { ProjectRepo } from "./ProjectRepo.ts"
import type { ProjectColumns } from "./ProjectRepo.ts"

/** A script field as stored: null is none (""). */
const script = (v: string | null | undefined) => (v === undefined ? undefined : (v ?? ""))
/** A text field as stored: blank is null (the default). */
const text = (v: string | null | undefined) => (v === undefined ? undefined : blank(v))

export class ProjectNotFound extends Schema.TaggedError<ProjectNotFound, { readonly brand: unique symbol }>()("ProjectNotFound", { id: Schema.String }) {}

/**
 * 6.11: a project's paths after its folder moved (`Relocation`), to store with the change that moved it. The worktrees and
 * scratch folders are given when they were inside the repository folder and moved with it.
 */
export interface Relocated {
  readonly repo_path: string
  readonly worktrees_root: string | null
  readonly scratch_path: string | null
  /** The new folder's fingerprint (`Projects.fingerprint`). */
  readonly repo_root: string
}

/**
 * Whether a fingerprint is the commits a repository's history started from, which tell it apart from others (unlike
 * `git`, a repository without commits yet, or "", a folder that wasn't one when it was looked at but may be one now).
 */
export const isHistory = (fingerprint: string | null): fingerprint is string => fingerprint !== null && fingerprint !== "" && fingerprint !== "git"

/** A preview's way out of its transaction, which rolls it back. */
class Previewed extends Schema.TaggedError<Previewed, { readonly brand: unique symbol }>()("Previewed", { after: Project }) {}

/** What git says of a project's folder: cached on the row, refreshed on create and update. */
interface GitFacts {
  /** The folder is a repository's top (it has `.git`). */
  readonly is_git: boolean
  /** It has a commit checked out, which a worktree branches from. */
  readonly has_commits: boolean
}

export interface ProjectsShape {
  /** A profile's projects, or with `archived` its archived ones instead, by name. */
  readonly list: (profileId: ProfileId, archived: boolean) => Effect.Effect<ReadonlyArray<Project>, ProfileNotFound>
  readonly get: (id: ProjectId) => Effect.Effect<Project, ProjectNotFound>
  /**
   * A project on a folder of this host, made if missing (an absolute path only). Its key is the one given or derived
   * from its name; its base branch the one given or the branch checked out. Emits `project`.
   */
  readonly create: (input: NewProject) => Effect.Effect<Project, ProfileNotFound | Invalid | Conflict>
  /** Changes its settings under its lock. `archived` archives it (refused while one of its agents runs) or brings it back. Emits `project`. */
  readonly update: (id: ProjectId, patch: ProjectPatch) => Effect.Effect<Project, ProjectNotFound | Invalid | Conflict>
  /** Deletes it with its tasks and its folders in the data folder; never its repository. Emits `project_deleted`. */
  /**
   * What `update` would make of it, checked as `update` checks it, without changing it (written and rolled back): how
   * each setting would be stored. What an agent's `update_project` shows the user (`Approvals`).
   */
  readonly preview: (id: ProjectId, patch: ProjectPatch) => Effect.Effect<Project, ProjectNotFound | Invalid | Conflict>
  readonly delete: (id: ProjectId) => Effect.Effect<void, ProjectNotFound | Conflict>
  /** Read `is_git` and `has_commits` from its folder again; emits `project` when they changed. */
  readonly refreshGit: (id: ProjectId) => Effect.Effect<Project, ProjectNotFound>
  /**
   * `refreshGit` for every project (`all`), or only those that want worktrees and weren't ready for them (`unready`): what
   * the old board read from the folder on every read of a project. The `gitSweeper` loop runs it.
   */
  readonly refreshGits: (which: "all" | "unready") => Effect.Effect<void>
  // 6.11: relocation (`git/Relocation`) and the fingerprint recorder.
  /**
   * `update` with a new folder: under the project's lock, the rest of the patch is checked (written and rolled back),
   * then `move` moves the folder (or checks it moved), then the change is stored with where everything is now. A change
   * that can't be stored after the folder moved still stores the new paths, so the project says where its folder is.
   */
  readonly relocate: <E>(
    id: ProjectId,
    patch: ProjectPatch,
    move: (before: Project) => Effect.Effect<Relocated, E>,
  ) => Effect.Effect<Project, ProjectNotFound | Invalid | Conflict | E>
  /** What the folder is: its sorted root commits, `git` for a repository without commits, "" for a folder that isn't one. */
  readonly fingerprint: (dir: string) => Effect.Effect<string>
  /** The project's `repo_root` (not on the wire). */
  readonly repoRoot: (id: ProjectId) => Effect.Effect<string | null>
  /** Record the project's fingerprint if its history isn't known yet (it has become a repository, or has its first commit). */
  readonly recordFingerprint: (id: ProjectId) => Effect.Effect<void>
  /** `recordFingerprint` for every project, while their folders are where the board expects them: the recorder's pass. */
  readonly recordFingerprints: Effect.Effect<void>
}

/** How `write` is writing: a change, a preview (rolled back), or a change with a folder that moved. */
type Writing = "update" | "preview" | "relocated"

/** Projects: a folder on this host and the settings its tasks inherit. */
export class Projects extends Context.Service<Projects, ProjectsShape>()("huntaway-server/projects/Projects") {
  static readonly layer = Layer.effect(
    Projects,
    Effect.gen(function* () {
      const repo = yield* ProjectRepo
      const profiles = yield* ProfileRepo
      const configs = yield* AgentConfigRepo
      const db = yield* Db
      const events = yield* Events
      const changes = yield* Changes
      const locks = yield* KeyedLock
      const proc = yield* Proc
      const dataDir = yield* DataDir
      const config = yield* ServerConfig
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const random = yield* SecureRandom.SecureRandom

      const getProject = (id: ProjectId) =>
        Effect.flatMap(repo.get(id), Option.match({ onNone: () => Effect.fail(new ProjectNotFound({ id })), onSome: Effect.succeed }))
      const requireProfile = (id: ProfileId) =>
        Effect.flatMap(profiles.get(id), Option.match({ onNone: () => Effect.fail(new ProfileNotFound({ id })), onSome: Effect.succeed }))
      const configIds = Effect.map(configs.list, (list) => new Set<string>(list.map((c) => c.id)))

      /** Git in `dir`, with its output; a git that can't run is a failed command. */
      const git = (dir: string, args: ReadonlyArray<string>) =>
        proc.run("git", ["-C", dir, ...args], { timeout: "20 seconds" }).pipe(Effect.orElseSucceed(() => ({ code: -1, stdout: "", stderr: "" })))
      const isDir = (p: string) =>
        fs.stat(p).pipe(
          Effect.map((info) => info.type === "Directory"),
          Effect.orElseSucceed(() => false),
        )
      const exists = (p: string) => fs.exists(p).pipe(Effect.orElseSucceed(() => false))
      const canonical = (p: string) => fs.realPath(p).pipe(Effect.orElseSucceed(() => path.resolve(p)))

      const gitFacts = (dir: string): Effect.Effect<GitFacts> =>
        Effect.gen(function* () {
          if (!(yield* exists(path.join(dir, ".git")))) return { is_git: false, has_commits: false }
          const head = yield* git(dir, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])
          return { is_git: true, has_commits: head.code === 0 }
        })
      /** What tells the repository apart after a move: its root commits, `git` for one without commits, "" for a folder that isn't one. */
      const fingerprint = (dir: string, facts?: GitFacts) =>
        Effect.gen(function* () {
          if (!(facts ?? (yield* gitFacts(dir))).is_git) return ""
          const roots = yield* git(dir, ["rev-list", "--max-parents=0", "HEAD"])
          const list = roots.stdout.split(/\s+/).filter((r) => r !== "")
          return roots.code === 0 && list.length > 0 ? list.toSorted().join(" ") : "git"
        })
      /** A base branch as stored: null (or blank) for the default, else a name git takes for a branch. */
      const checkBaseBranch = (v: string | null | undefined) =>
        Effect.gen(function* () {
          const name = blank(v)
          if (name === null) return null
          const ok = !name.includes("@{") && (yield* proc.run("git", ["check-ref-format", "--branch", name], { cwd: "/" }).pipe(Effect.orDie)).code === 0
          if (!ok) return yield* new Invalid({ field: "base_branch", reason: `base_branch "${name}" isn't a valid branch name` })
          return name
        })
      const newId = Effect.map(random.uuidV4(), (id) => ProjectId.make(id)).pipe(Effect.orDie)

      const list = Effect.fn("Projects.list")(function* (profileId: ProfileId, archived: boolean) {
        yield* requireProfile(profileId)
        return (yield* repo.list(profileId)).filter((p) => (p.archived_at !== null) === archived)
      })

      const create = Effect.fn("Projects.create")(function* (input: NewProject) {
        yield* requireProfile(input.profile_id)
        let repoPath = expandTilde(input.repo_path, config.home)
        if (repoPath === "") return yield* new Invalid({ field: "repo_path", reason: "repo_path is required" })
        if (!(yield* exists(repoPath))) {
          // A new project folder: made, but only somewhere unambiguous.
          if (!path.isAbsolute(repoPath)) return yield* new Invalid({ field: "repo_path", reason: `${repoPath} does not exist` })
          yield* fs
            .makeDirectory(repoPath, { recursive: true })
            .pipe(Effect.mapError((e) => new Invalid({ field: "repo_path", reason: `creating ${repoPath}: ${e.message}` })))
        }
        if (!(yield* isDir(repoPath))) return yield* new Invalid({ field: "repo_path", reason: `${repoPath} is not a directory` })
        repoPath = yield* canonical(repoPath)
        const asked = yield* checkBaseBranch(input.base_branch)
        const facts = yield* gitFacts(repoPath)
        const current = yield* git(repoPath, ["symbolic-ref", "--short", "HEAD"])
        const baseBranch = asked ?? (current.code === 0 && current.stdout.trim() !== "" ? current.stdout.trim() : null)
        const name = blank(input.name) ?? (path.basename(repoPath) || "Project")
        const repoRoot = yield* fingerprint(repoPath, facts)
        const id = yield* newId
        const scratch = path.join(dataDir.projectDir(id), "scratch")
        const worktrees = path.join(dataDir.projectDir(id), "worktrees")
        yield* fs.makeDirectory(scratch, { recursive: true }).pipe(Effect.orDie)
        return yield* db.tx(
          Effect.gen(function* () {
            // The key is checked and stored in one transaction, so no other change takes it meanwhile.
            const others = yield* repo.list(input.profile_id)
            const given = blank(input.key)
            const key = given === null ? newProjectKey(others, name) : yield* checkKey(others, null, normalizeKey(given))
            yield* repo.insert(id, yield* nowTimestamp, {
              profile_id: input.profile_id,
              name,
              key,
              repo_path: repoPath,
              scratch_path: scratch,
              worktrees_root: worktrees,
              base_branch: baseBranch,
              // Kept for a folder that isn't a git repository yet, for when it becomes one.
              use_worktrees: input.use_worktrees ?? true,
              is_git: facts.is_git,
              has_commits: facts.has_commits,
              repo_root: repoRoot,
            })
            const project = yield* getProject(id).pipe(Effect.orDie)
            yield* events.emit({ type: "project", project })
            return project
          }),
        )
      })

      /** The patch's fields that need the file system or git, checked outside the transaction. */
      const checkOutside = (before: Project, patch: ProjectPatch, how: Writing) =>
        Effect.gen(function* () {
          const columns: { base_branch?: string | null; worktrees_root?: string; repo_path?: string } = {}
          if (patch.move_repo === true || (patch.repo_path !== undefined && expandTilde(patch.repo_path, config.home) !== before.repo_path)) {
            // 6.11: a new folder is `Relocation`'s (`relocate`); a preview shows it as given.
            if (how !== "preview") return yield* new Invalid({ field: "repo_path", reason: "a project's folder is changed by relocating it" })
            if (patch.repo_path !== undefined) columns.repo_path = expandTilde(patch.repo_path, config.home)
          }
          if (patch.base_branch !== undefined) columns.base_branch = yield* checkBaseBranch(patch.base_branch)
          if (patch.worktrees_root !== undefined) {
            const given = patch.worktrees_root.trim()
            if (given === "") return yield* new Invalid({ field: "worktrees_root", reason: "worktrees_root can't be empty" })
            const root = expandTilde(given, config.home)
            // A relative folder would be made against the server's folder but used by git from the repository's, which
            // puts worktrees in the main checkout; and it can't be the checkout.
            if (!path.isAbsolute(root))
              return yield* new Invalid({ field: "worktrees_root", reason: "worktrees_root must be an absolute path, or start with ~/" })
            if ((yield* canonical(root)) === (yield* canonical(before.repo_path))) {
              return yield* new Invalid({ field: "worktrees_root", reason: "worktrees_root can't be the repository folder: give it a folder of its own" })
            }
            columns.worktrees_root = root
          }
          return columns
        })

      /**
       * The patch checked and written: the project after it. Emits `project`. Not `keep`, it is rolled back (a preview).
       * `relocated`: the paths of a folder that moved, stored with it (6.11).
       */
      const write = (id: ProjectId, patch: ProjectPatch, keep: boolean, relocated?: Relocated) =>
        Effect.gen(function* () {
          const outside = yield* checkOutside(yield* getProject(id), patch, relocated !== undefined ? "relocated" : keep ? "update" : "preview")
          const facts = yield* gitFacts(relocated?.repo_path ?? (yield* getProject(id)).repo_path)
          return yield* db.tx(
            Effect.gen(function* () {
              const before = yield* getProject(id)
              const profile = yield* profiles.get(before.profile_id)
              // Configs deleted since they were saved, here or in the profile's (which a project's own start from), are kept.
              const saved = [
                ...before.reviewers,
                ...before.summarizers,
                ...Option.match(profile, { onNone: () => [], onSome: (p) => [...p.reviewers, ...p.summarizers] }),
              ]
              const known = yield* configIds
              const reviewers = { saved, configs: known, defaultsToo: false }
              const key = yield* ifGiven(patch.key, (k) => {
                const wanted = normalizeKey(k)
                return wanted === before.key ? Effect.succeed(wanted) : Effect.flatMap(repo.list(before.profile_id), (others) => checkKey(others, id, wanted))
              })
              let archivedAt: Timestamp | null | undefined
              if (patch.archived === true && before.archived_at === null) {
                // Not while one of its agents runs: their tasks would be off the board.
                yield* refuseWhileRunning(
                  yield* repo.running(id),
                  (n) => `${n} of the project's agents ${n === 1 ? "is" : "are"} running; stop ${n === 1 ? "it" : "them"} before archiving it`,
                )
                archivedAt = yield* nowTimestamp
              } else if (patch.archived === false) archivedAt = null
              const columns: ProjectColumns = {
                name: yield* ifGiven(patch.name, checkName),
                key,
                // The old key keeps naming the project's tasks (OS-2 after OS became OMS).
                former_keys: key === undefined || key === before.key ? undefined : formerKeysAfter(before, key),
                base_branch: outside.base_branch,
                worktrees_root: outside.worktrees_root,
                setup_script: script(patch.setup_script),
                teardown_script: script(patch.teardown_script),
                status_script: script(patch.status_script),
                status_scripts: patch.status_scripts === undefined ? undefined : tidyStatusScripts(patch.status_scripts),
                use_worktrees: patch.use_worktrees,
                permission_mode: patch.permission_mode,
                model: text(patch.model),
                auto_review: patch.auto_review,
                review_rounds: yield* ifGiven(patch.review_rounds, checkReviewRounds),
                reviewers: yield* ifGiven(patch.reviewers, (v) => reviewersValue(v, { ...reviewers, summarizers: false })),
                auto_summary: patch.auto_summary,
                summarizers: yield* ifGiven(patch.summarizers, (v) => reviewersValue(v, { ...reviewers, summarizers: true })),
                claude_config_ids: yield* ifGiven(patch.claude_config_ids, (v) =>
                  v === null ? Effect.succeed(null) : Effect.map(checkConfigIds(v, known), (ids) => (ids.length === 0 ? null : ids)),
                ),
                start_prompt: text(patch.start_prompt),
                review_prompt: text(patch.review_prompt),
                merge_prompt: text(patch.merge_prompt),
                group_name: yield* ifGiven(patch.group_name, checkGroupName),
                archived_at: archivedAt,
                merge_approval: patch.merge_approval,
                require_pr_approval: patch.require_pr_approval,
                github_account: yield* ifGiven(patch.github_account, checkGithubAccount),
                done_when_merged: patch.done_when_merged,
                use_workflows: patch.use_workflows,
                pull_requests: patch.pull_requests,
                watch_pull_requests: patch.watch_pull_requests,
                pr_preview_url: yield* ifGiven(patch.pr_preview_url, checkPreviewUrl),
                copy_files: yield* ifGiven(patch.copy_files, (v) => checkFileList("copy_files", v)),
                link_folders: yield* ifGiven(patch.link_folders, (v) => checkFileList("link_folders", v)),
                is_git: facts.is_git,
                has_commits: facts.has_commits,
                repo_path: outside.repo_path,
                // 6.11: where the folder and what moved with it are now. Folders set by the patch win.
                ...(relocated === undefined
                  ? {}
                  : {
                      repo_path: relocated.repo_path,
                      repo_root: relocated.repo_root,
                      ...(relocated.scratch_path === null ? {} : { scratch_path: relocated.scratch_path }),
                      ...(relocated.worktrees_root === null || outside.worktrees_root !== undefined ? {} : { worktrees_root: relocated.worktrees_root }),
                    }),
              }
              yield* repo.update(id, columns)
              const project = yield* getProject(id)
              yield* events.emit({ type: "project", project })
              // A preview fails its transaction, which rolls it back with its event.
              if (!keep) return yield* new Previewed({ after: project })
              return project
            }),
          )
        }).pipe(Effect.catchTag("Previewed", (e) => Effect.succeed(e.after)))

      const update = Effect.fn("Projects.update")(function* (id: ProjectId, patch: ProjectPatch) {
        return yield* locks.withLock(["project", id])(
          Effect.gen(function* () {
            const before = yield* getProject(id)
            const after = yield* write(id, patch, true)
            // What its tasks take from its settings follows them, by the reactor (4.5: previews of pull requests).
            // 6.6: and one that starts using workflows has its Review tab's reviews moved into one.
            if (after.pr_preview_url !== before.pr_preview_url || (after.use_workflows && !before.use_workflows)) {
              yield* changes.offer({ _tag: "ProjectChanged", before, after })
            }
            return after
          }),
        )
      })

      // The project as the change would leave it, however each setting is stored.
      const preview = Effect.fn("Projects.preview")(function* (id: ProjectId, patch: ProjectPatch) {
        return yield* write(id, patch, false)
      })

      const remove = Effect.fn("Projects.delete")(function* (id: ProjectId) {
        yield* locks.withLock(["project", id])(
          db.tx(
            Effect.gen(function* () {
              yield* getProject(id)
              yield* refuseWhileRunning(yield* repo.running(id), (n) => `${n} of the project's agents ${n === 1 ? "is" : "are"} running; stop them first`)
              yield* repo.delete(id)
              yield* events.emit({ type: "project_deleted", id })
            }),
          ),
        )
        yield* removeUnusedDir(fs, dataDir.projectDir(id), yield* profiles.usedPaths, "project")
      })

      const refreshGit = Effect.fn("Projects.refreshGit")(function* (id: ProjectId) {
        return yield* locks.withLock(["project", id])(
          Effect.gen(function* () {
            const facts = yield* gitFacts((yield* getProject(id)).repo_path)
            return yield* db.tx(
              Effect.gen(function* () {
                const before = yield* getProject(id)
                if (before.is_git === facts.is_git && before.has_commits === facts.has_commits) return before
                yield* repo.update(id, facts)
                const project = yield* getProject(id)
                yield* events.emit({ type: "project", project })
                return project
              }),
            )
          }),
        )
      })

      const refreshGits = Effect.fn("Projects.refreshGits")(function* (which: "all" | "unready") {
        const ids = which === "all" ? (yield* repo.folders).map((p) => p.id) : yield* repo.unready
        // One deleted meanwhile has nothing to refresh.
        yield* Effect.forEach(ids, (id) => Effect.ignore(refreshGit(id)), { concurrency: 1, discard: true })
      })

      // ---- 6.11: relocation and fingerprints ----

      const relocate = <E>(id: ProjectId, patch: ProjectPatch, move: (before: Project) => Effect.Effect<Relocated, E>) =>
        locks
          .withLock(["project", id])(
            Effect.gen(function* () {
              const before = yield* getProject(id)
              const { repo_path: _path, move_repo: _move, ...rest } = patch
              // Tried (and rolled back) before the folder moves, so a change that can't be stored doesn't leave the folder
              // somewhere the project doesn't say.
              yield* write(id, rest, false)
              // From the folder's move to the write that records where it went, one step a caller going away (an RPC's
              // client disconnecting) can't cut in two: cut after the rename, the folder would be at the new path while
              // the project and its worktrees still named the old one, which no longer exists to move again.
              const after = yield* Effect.uninterruptible(
                Effect.flatMap(move(before), (moved) =>
                  write(id, rest, true, moved).pipe(
                    Effect.tapError(() =>
                      // The folder has moved all the same, so the project says where it is now.
                      db
                        .tx(
                          Effect.gen(function* () {
                            yield* repo.update(id, {
                              repo_path: moved.repo_path,
                              repo_root: moved.repo_root,
                              ...(moved.scratch_path === null ? {} : { scratch_path: moved.scratch_path }),
                              ...(moved.worktrees_root === null ? {} : { worktrees_root: moved.worktrees_root }),
                            })
                            yield* events.emit({ type: "project", project: yield* getProject(id) })
                          }),
                        )
                        .pipe(Effect.ignore),
                    ),
                  ),
                ),
              )
              if (after.pr_preview_url !== before.pr_preview_url) yield* changes.offer({ _tag: "ProjectChanged", before, after })
              return after
            }),
          )
          .pipe(Effect.withSpan("Projects.relocate"))

      const recordAt = (id: ProjectId, repoPath: string, root: string | null) =>
        Effect.gen(function* () {
          if (isHistory(root) || !(yield* isDir(repoPath))) return
          const now = yield* fingerprint(repoPath)
          if (now !== root) yield* repo.recordRoot(id, repoPath, now)
        })

      const recordFingerprint = Effect.fn("Projects.recordFingerprint")(function* (id: ProjectId) {
        const p = Option.getOrNull(yield* repo.get(id))
        if (p !== null) yield* recordAt(id, p.repo_path, yield* repo.repoRoot(id))
      })

      const recordFingerprints = Effect.gen(function* () {
        for (const p of yield* repo.unrecorded) yield* recordAt(p.id, p.repo_path, p.repo_root)
      }).pipe(Effect.withSpan("Projects.recordFingerprints"))

      return Projects.of({
        list,
        get: getProject,
        create,
        update,
        preview,
        delete: remove,
        refreshGit,
        refreshGits,
        relocate,
        fingerprint: (dir) => fingerprint(dir),
        repoRoot: repo.repoRoot,
        recordFingerprint,
        recordFingerprints,
      })
    }),
  )

  /**
   * 6.11: the fingerprint recorder (the old `relocate.start_recording`): what each project's folder is, for those whose
   * history isn't known yet, now and every hour.
   */
  static readonly recorder = Layer.effectDiscard(
    Effect.gen(function* () {
      const projects = yield* Projects
      yield* projects.recordFingerprints.pipe(
        Effect.catchCause((cause) => Effect.logWarning("recording the projects' repositories", cause)),
        Effect.andThen(Effect.sleep("1 hour")),
        Effect.forever,
        Effect.forkScoped,
      )
    }),
  )

  /**
   * The git facts' sweep (docs/plan/04-database.md: `is_git` and `has_commits` are columns): a project that wants worktrees
   * and isn't ready for them every `UNREADY_SWEEP` (its board says so until it is, as the old setup view looked again
   * every 3 s), and every project every `GIT_SWEEP`. A change is a `project` event, so the board follows.
   */
  static readonly gitSweeper = Layer.effectDiscard(
    Effect.gen(function* () {
      const projects = yield* Projects
      const sweep = (which: "all" | "unready", every: Duration.Input) =>
        projects.refreshGits(which).pipe(
          Effect.catchCause((cause) => Effect.logWarning("refreshing the projects' git facts", cause)),
          Effect.repeat(Schedule.spaced(every)),
          Effect.forkScoped,
        )
      yield* sweep("unready", UNREADY_SWEEP)
      yield* sweep("all", GIT_SWEEP)
    }),
  )
}

/** How often a project waiting to be ready for worktrees is looked at again. */
export const UNREADY_SWEEP = "3 seconds"
/** How often every project's git facts are read again. */
export const GIT_SWEEP = "5 minutes"
