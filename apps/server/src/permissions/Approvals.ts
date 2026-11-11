import { Context, Effect, FileSystem, Layer, Option, Predicate, Result, Schema, Stream } from "effect"
import { Invalid, ProfileId, ProjectId, ProjectPatch, TaskId } from "@huntaway/contracts"
import type { Conflict, Profile, Project, Task } from "@huntaway/contracts"
import { Events } from "../platform/Events.ts"
import { Identity } from "../platform/Identity.ts"
import { Proc } from "../platform/Proc.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import type { ProfileNotFound } from "../profiles/Profiles.ts"
import { newProjectKey } from "../projects/keys.ts"
import { ProjectRepo } from "../projects/ProjectRepo.ts"
import { Projects } from "../projects/Projects.ts"
import type { ProjectNotFound } from "../projects/Projects.ts"
import { Runs } from "../runs/Runs.ts"
import { expandTilde } from "../settings/Folders.ts"
import { HostSettings } from "../settings/HostSettings.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { Tasks } from "../tasks/Tasks.ts"
import { Permissions } from "./Permissions.ts"
import type { Asker } from "./Permissions.ts"

// The board's changes that always ask the user (docs/plan/07-agents.md, Board changes that always ask; docs/plan/
// inventory/03-mcp.md 2.6; the old mcp/tools/approvals.ts and projects.ts): adding a project, a project's risky
// settings, deleting a task. Each works out what would change, asks in the agent's thread through
// `Permissions.approve` (whatever its mode, never "always"; the card shows the input), and once approved makes exactly
// what the input it showed says, through the services. A call that was asking when the server stopped carries on with
// the input it asked about (`Permissions.asked`), whatever changed since. The automations' and workflows' approvals are
// M6's (6.5, 6.6).

/** The user didn't approve (or the request expired): nothing was changed. `message` is what the agent is told. */
export class NotApproved extends Schema.TaggedError<NotApproved, { readonly brand: unique symbol }>()("NotApproved", { message: Schema.String }) {}

/**
 * The settings `update_project` changes without asking: how the project's agents are prompted and reviewed, and what
 * it's called and where on the board it is.
 */
export const AGENT_FIELDS: ReadonlyArray<string> = [
  "name",
  "key",
  "base_branch",
  "model",
  "start_prompt",
  "review_prompt",
  "merge_prompt",
  "auto_review",
  "review_rounds",
  "reviewers",
  "auto_summary",
  "summarizers",
  "use_workflows",
  "group_name",
]

/**
 * The settings it only changes once the user approves: they run commands on the host, decide what agents may do without
 * asking, move where the work happens, or bring the repository's ignored files (secrets, say) into worktrees.
 * (`move_repo` is not a setting: it goes with `repo_path`, and says to move the folder there.)
 */
export const APPROVAL_FIELDS: ReadonlyArray<string> = [
  "permission_mode",
  "setup_script",
  "teardown_script",
  "copy_files",
  "link_folders",
  "status_script",
  "status_scripts",
  "repo_path",
  "move_repo",
  "use_worktrees",
  "worktrees_root",
]

/** The order changes are shown and listed in: the old API's order of a project's fields. */
const FIELD_ORDER: ReadonlyArray<keyof Project> = [
  "name",
  "key",
  "repo_path",
  "base_branch",
  "setup_script",
  "teardown_script",
  "status_script",
  "status_scripts",
  "use_worktrees",
  "permission_mode",
  "model",
  "worktrees_root",
  "auto_review",
  "review_rounds",
  "reviewers",
  "auto_summary",
  "summarizers",
  "start_prompt",
  "review_prompt",
  "merge_prompt",
  "group_name",
  "use_workflows",
  "copy_files",
  "link_folders",
]

/** What `create_project` asks for: folder `repo_path` as a project named `name` (blank: the folder's) on `board`. */
export interface CreationRequest {
  readonly board: Profile
  readonly name: string | null
  readonly repo_path: string
  readonly reason: string | null
}

/** What `update_project` asks for: `patch` (only the agent's fields and the risky ones) to `project`. */
export interface ChangeRequest {
  readonly project: Project
  readonly patch: ProjectPatch
  readonly reason: string | null
}

/** What `delete_task` asks for. */
export interface DeletionRequest {
  readonly task: Task
  readonly deleteBranch: boolean
  readonly reason: string | null
}

/** What became of a deletion: made, or the task was deleted meanwhile (not by this call). */
export type Deleted =
  | { readonly deleted: true; readonly key: string; readonly title: string }
  | { readonly deleted: false; readonly key: string; readonly note: string }

export interface ApprovalsShape {
  /**
   * `create_project`: asks to add the folder `request` names (checked first: absolute, symlinks resolved, `..` refused
   * in the part that doesn't exist yet), and adds it once approved (made if missing). `request` is only read when this
   * call hasn't asked before.
   */
  readonly createProject: <E>(
    asker: Asker,
    request: Effect.Effect<CreationRequest, E>,
  ) => Effect.Effect<Project, E | NotApproved | Invalid | ProfileNotFound | Conflict>
  /**
   * `update_project`: the settings that differ from the project's, as `Projects` would store them; asked about if any
   * is risky, else made at once. Only the fields that differ are written, so a setting left as it was can't overwrite a
   * change made meanwhile; with approval, exactly what the user saw.
   */
  readonly updateProject: <E>(
    asker: Asker,
    request: Effect.Effect<ChangeRequest, E>,
  ) => Effect.Effect<Project, E | NotApproved | Invalid | ProjectNotFound | Conflict>
  /** `delete_task`: asks to delete the task (not the asker's own, nor the assistant), then stops its agent and deletes it. */
  readonly deleteTask: <E>(asker: Asker, request: Effect.Effect<DeletionRequest, E>) => Effect.Effect<Deleted, E | NotApproved | Invalid | Conflict>
}

const isRecord = Predicate.isObject

const field = (v: unknown, key: string): unknown => (isRecord(v) && !Array.isArray(v) ? v[key] : undefined)
const text = (v: unknown, key: string, fallback: string): string => {
  const s = field(v, key)
  return typeof s === "string" ? s : fallback
}

/** Two JSON values alike (object keys in any order). */
export const sameJson = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameJson(x, b[i]))
  }
  if (!isRecord(a) || !isRecord(b)) return (a ?? null) === (b ?? null)
  const keys = new Set([...Object.keys(a), ...Object.keys(b)].filter((k) => a[k] !== undefined || b[k] !== undefined))
  return [...keys].every((k) => sameJson(a[k], b[k]))
}

/** What an approval asks for, for the agent: "changing setup_script", "deleting KIW-2", "adding /x as a project". */
export const approvalWhat = (tool: string, input: unknown): string => {
  if (tool === "create_project") return `adding ${text(input, "repo_path", "the folder")} as a project`
  if (tool === "delete_task") return `deleting ${text(field(input, "delete"), "key", "the task")}`
  const changes = field(input, "changes")
  const fields = (Array.isArray(changes) ? changes : []).filter((c) => field(c, "needs_approval") === true).map((c) => text(c, "field", ""))
  return `changing ${fields.join(", ")}`
}

const NOTHING: Readonly<Record<string, string>> = { create_project: "added", delete_task: "deleted", update_project: "changed" }

/** What a project change's approval reads back. */
const SavedChange = Schema.Struct({ project: Schema.Struct({ id: ProjectId }), apply: ProjectPatch })
/** What a creation's approval reads back. */
const SavedCreation = Schema.Struct({ apply: Schema.Struct({ profile_id: ProfileId, name: Schema.String, repo_path: Schema.String }) })
/** What a deletion's approval reads back. */
const SavedDeletion = Schema.Struct({ delete: Schema.Struct({ id: TaskId, key: Schema.String }), delete_branch: Schema.optional(Schema.Boolean) })

const read = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, input: unknown) =>
  Effect.fromOption(Schema.decodeUnknownOption(schema)(input)).pipe(
    Effect.mapError(() => new Invalid({ field: "input", reason: "the approved change doesn't read: call it again" })),
  )

/** A folder `create_project` can't add. */
const badFolder = (reason: string) => new Invalid({ field: "repo_path", reason })
/** The absolute path of `parts`. */
const asPath = (parts: ReadonlyArray<string>) => `/${parts.join("/")}`

export class Approvals extends Context.Service<Approvals, ApprovalsShape>()("huntaway-server/permissions/Approvals") {
  static readonly layer = Layer.effect(
    Approvals,
    Effect.gen(function* () {
      const permissions = yield* Permissions
      const projects = yield* Projects
      const projectRepo = yield* ProjectRepo
      const tasks = yield* Tasks
      const taskRepo = yield* TaskRepo
      const runs = yield* Runs
      const settings = yield* HostSettings
      const proc = yield* Proc
      const fs = yield* FileSystem.FileSystem
      const { hostName } = yield* Identity
      const config = yield* ServerConfig

      /** The project a change is to, as the approval shows it. */
      const projectRef = (p: Pick<Project, "id" | "key" | "name">) => ({ id: p.id, key: p.key, name: p.name, host: hostName })
      /** The thread asking, as the approval shows it. */
      const askedBy = Effect.fnUntraced(function* (asker: Asker) {
        const t = yield* taskRepo.get(asker.run.task_id)
        if (t === null) return null
        return { id: t.id, key: t.kind === "task" ? t.key : null, title: t.title }
      })

      /** Asks the user to approve `input` for `tool` in the asker's thread and waits: the input they approved. */
      const ask = Effect.fnUntraced(function* (asker: Asker, kind: "project" | "delete_task", tool: string, input: unknown) {
        const answer = yield* permissions.approve(asker, kind, tool, input)
        if (Result.isSuccess(answer)) return answer.success
        return yield* new NotApproved({
          message: `The user didn't approve ${approvalWhat(tool, input)}, so nothing was ${NOTHING[tool] ?? "changed"}: ${answer.failure}`,
        })
      })

      /** What this call asked before it was cut short, if it did. */
      const saved = (asker: Asker) => permissions.asked(asker.call_id)

      const exists = (p: string) => fs.exists(p).pipe(Effect.orElseSucceed(() => false))

      /** What `create_project` asks the user to approve (inventory 03 2.6). */
      const creation = Effect.fnUntraced(function* (asker: Asker, r: CreationRequest) {
        const given = expandTilde(r.repo_path.trim(), config.home)
        if (!given.startsWith("/")) return yield* badFolder("repo_path must be an absolute path, or start with ~/")
        // The folder as it would be added: symlinks resolved, as far as it exists.
        const missing: Array<string> = []
        const existing = given.split("/").filter((x) => x !== "" && x !== ".")
        while (!(yield* exists(asPath(existing)))) {
          const last = existing.at(-1)
          // `..` in the part that doesn't exist yet would hide where it ends up.
          if (last === undefined || last === "..") return yield* badFolder(`${given} isn't a folder that exists or can be created`)
          missing.push(last)
          existing.pop()
        }
        const base = yield* fs.realPath(asPath(existing)).pipe(Effect.mapError((e) => badFolder(`${asPath(existing)}: ${e.message}`)))
        const path = [base.replace(/\/+$/, ""), ...missing.toReversed()].join("/") || "/"
        if (missing.length === 0) {
          const dir = yield* fs.stat(path).pipe(
            Effect.map((s) => s.type === "Directory"),
            Effect.orElseSucceed(() => false),
          )
          if (!dir) return yield* badFolder(`${path} is not a directory`)
        }
        const trimmed = r.name?.trim() ?? ""
        const fileName = path.split("/").findLast((x) => x !== "")
        const name = trimmed !== "" ? trimmed : fileName !== undefined && fileName !== ".." ? fileName : "Project"
        const key = newProjectKey(yield* projectRepo.list(r.board.id), name)
        const git =
          missing.length === 0 &&
          (yield* proc.run("git", ["-C", path, "rev-parse", "--git-dir"], { timeout: "20 seconds" }).pipe(
            Effect.map((o) => o.code === 0),
            Effect.orElseSucceed(() => false),
          ))
        return {
          op: "create",
          project: { id: "", key, name, host: hostName },
          task: yield* askedBy(asker),
          board: r.board.name,
          repo_path: path,
          exists: missing.length === 0,
          git,
          permission_mode: (yield* settings.get).default_permission_mode ?? "default",
          // As a change from nothing, as the old cards read it.
          changes: [
            { field: "name", from: null, to: name, needs_approval: false },
            { field: "repo_path", from: null, to: path, needs_approval: true },
          ],
          apply: { profile_id: r.board.id, name, repo_path: path },
          reason: r.reason,
        }
      })

      const createProject = Effect.fn("Approvals.createProject")(function* <E>(asker: Asker, request: Effect.Effect<CreationRequest, E>) {
        // A call retried after a restart carries on with the approval it asked for.
        const before = yield* saved(asker)
        const input = Option.isSome(before) ? before.value : yield* creation(asker, yield* request)
        const approved = yield* read(SavedCreation, yield* ask(asker, "project", "create_project", input))
        return yield* projects.create({ profile_id: approved.apply.profile_id, name: approved.apply.name, repo_path: approved.apply.repo_path })
      })

      /** What a change to `p` would change, and whether any of it needs asking: `null` when it asks nothing. */
      const change = Effect.fnUntraced(function* (asker: Asker, r: ChangeRequest) {
        const { move_repo: moveRepo, ...patch } = r.patch
        if (Object.keys(patch).length === 0 && moveRepo === undefined) return yield* new Invalid({ field: "patch", reason: "nothing to change" })
        const p = r.project
        // What would change, found by making the change and rolling it back, so it's judged on what the project would
        // be, however each setting is stored. Checked before asking, so the user only sees changes that can be made.
        const after = yield* projects.preview(p.id, patch)
        const changed: Array<string> = FIELD_ORDER.filter((k) => Object.hasOwn(patch, k) && !sameJson(p[k], after[k]))
        // A new repository path has to be the project's folder, or where it can move to.
        if (moveRepo === true) {
          if (!changed.includes("repo_path")) return yield* new Invalid({ field: "move_repo", reason: "move_repo needs a new repo_path to move the folder to" })
          changed.push("move_repo")
        }
        // Only what differs, so a setting left as it was can't overwrite a change made meanwhile; with approval,
        // exactly what the user saw.
        const apply: Record<string, unknown> = {}
        for (const k of changed) apply[k] = k === "move_repo" ? true : (Object.entries(patch).find(([n]) => n === k)?.[1] ?? null)
        const asks = changed.some((k) => APPROVAL_FIELDS.includes(k))
        const changes = changed.map((k) =>
          k === "move_repo"
            ? { field: k, from: false, to: true, needs_approval: true }
            : { field: k, from: field(p, k) ?? null, to: field(after, k) ?? null, needs_approval: APPROVAL_FIELDS.includes(k) },
        )
        return { asks, input: { project: projectRef(p), task: yield* askedBy(asker), changes, apply, reason: r.reason } }
      })

      /** Makes `input`'s `apply` (only the fields that differ) to its project. */
      const applyChange = Effect.fnUntraced(function* (input: unknown) {
        const { project, apply } = yield* read(SavedChange, input)
        if (Object.keys(apply).length === 0) return yield* projects.get(project.id)
        return yield* projects.update(project.id, apply)
      })

      const updateProject = Effect.fn("Approvals.updateProject")(function* <E>(asker: Asker, request: Effect.Effect<ChangeRequest, E>) {
        // A call retried after a restart carries on with the approval it asked for, and the project it was for, whatever
        // has changed since.
        const before = yield* saved(asker)
        if (Option.isSome(before)) return yield* applyChange(yield* ask(asker, "project", "update_project", before.value))
        const { asks, input } = yield* change(asker, yield* request)
        return yield* applyChange(asks ? yield* ask(asker, "project", "update_project", input) : input)
      })

      /** What `delete_task` asks the user to confirm. */
      const deletion = Effect.fnUntraced(function* (asker: Asker, r: DeletionRequest) {
        const t = r.task
        if (t.kind === "task" && t.task_type === "assistant")
          return yield* new Invalid({ field: "task_id", reason: "the profile's assistant can't be deleted" })
        if (t.id === asker.run.task_id) return yield* new Invalid({ field: "task_id", reason: "you can't delete your own task" })
        const project = t.project_id === null ? null : yield* projectRepo.get(t.project_id)
        return {
          project: project === null || Option.isNone(project) ? null : projectRef(project.value),
          task: yield* askedBy(asker),
          delete: { id: t.id, key: t.key, title: t.title, status: t.status, branch: t.branch, running: yield* runs.isRunning(t.id) },
          delete_branch: r.deleteBranch,
          reason: r.reason,
        }
      })

      const deleteTask = Effect.fn("Approvals.deleteTask")(function* <E>(asker: Asker, request: Effect.Effect<DeletionRequest, E>) {
        // A call retried after a restart carries on with the deletion it asked about.
        const before = yield* saved(asker)
        const input = Option.isSome(before) ? before.value : yield* deletion(asker, yield* request)
        const { delete: doomed, delete_branch: deleteBranch } = yield* read(SavedDeletion, input)
        const gone = Effect.map(taskRepo.get(doomed.id), (t) => t === null)
        const already: Deleted = { deleted: false, key: doomed.key, note: "It was deleted meanwhile (not by this call)." }
        // Deleted while the user was asked, which settles the question.
        const asked = yield* Effect.result(ask(asker, "delete_task", "delete_task", input))
        if (Result.isFailure(asked)) return (yield* gone) ? already : yield* asked.failure
        const t = yield* taskRepo.get(doomed.id)
        if (t === null) return already
        // Its agent stops and its queue goes first, as when the user deletes it.
        yield* runs.abort(t.id)
        const done = yield* Effect.result(tasks.delete(t.id, { deleteBranch: deleteBranch === true }, { _tag: "Agent", task_id: asker.run.task_id }))
        if (Result.isFailure(done)) return done.failure._tag === "TaskNotFound" ? already : yield* done.failure
        const out: Deleted = { deleted: true, key: doomed.key, title: t.title }
        return out
      })

      return Approvals.of({ createProject, updateProject, deleteTask })
    }),
  )

  /** A deleted project's approvals expire: what they would change is gone (the old `expire_for_project`). */
  static readonly projectsDeleted = Layer.effectDiscard(
    Effect.gen(function* () {
      const permissions = yield* Permissions
      const watching = yield* (yield* Events).watch(undefined)
      yield* watching.live.pipe(
        Stream.runForEach((e) => (e.type === "project_deleted" ? permissions.expireFor({ _tag: "Project", project: e.id }) : Effect.void)),
        Effect.forkScoped,
      )
    }),
  )
}
