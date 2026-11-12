import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Conflict, Invalid, NotFound, Unavailable } from "../errors.ts"
import { ProfileId, ProjectId, TaskId } from "../ids.ts"
import { NewProject, Project, ProjectPatch, SystemPromptOptions, SystemPromptPreview } from "../project.ts"
import { Auth, RequiredScope } from "../session.ts"
import { Task } from "../task.ts"

/** A branch a task can start from: `feature` for a local one, `origin/feature` (`remote`) for one only on a remote. */
export const Branch = Schema.Struct({ name: Schema.String, remote: Schema.Boolean })
export interface Branch extends Schema.Schema.Type<typeof Branch> {}

/** What removing merged worktrees did with a done task's worktree: removed, or kept and why (`detail`). */
export const MergedWorktreeResult = Schema.Struct({
  task_id: TaskId,
  number: Schema.Int,
  title: Schema.String,
  removed: Schema.Boolean,
  detail: Schema.String,
})
export interface MergedWorktreeResult extends Schema.Schema.Type<typeof MergedWorktreeResult> {}

/** Projects (the old `/profiles/{id}/projects` and `/projects/{id}`). Changes emit `project` or `project_deleted`. */
export class ProjectRpcs extends RpcGroup.make(
  /** A profile's projects; `archived: true` lists its archived ones instead. */
  Rpc.make("projects.list", {
    payload: { profile_id: ProfileId, archived: Schema.optional(Schema.Boolean) },
    success: Schema.Array(Project),
    error: NotFound,
  }).annotate(RequiredScope, "read"),
  Rpc.make("projects.get", { payload: { id: ProjectId }, success: Project, error: NotFound }).annotate(RequiredScope, "read"),
  /** A project on a folder of this host (made if missing). */
  Rpc.make("projects.create", { payload: { project: NewProject }, success: Project, error: Schema.Union([NotFound, Invalid, Conflict]) }).annotate(
    RequiredScope,
    "settings",
  ),
  Rpc.make("projects.update", {
    payload: { id: ProjectId, patch: ProjectPatch },
    success: Project,
    error: Schema.Union([NotFound, Invalid, Conflict]),
  }).annotate(RequiredScope, "settings"),
  /** Deletes the project and its tasks; its repository folder is left alone. */
  Rpc.make("projects.delete", { payload: { id: ProjectId }, error: Schema.Union([NotFound, Conflict]) }).annotate(RequiredScope, "settings"),
  /** The repository's branches, newest commit first, at most 200 (the old `GET /projects/{id}/branches`). */
  /**
   * What the agent of a new thread in the project would be told, for its settings (the old `GET /projects/{id}/system-prompt`):
   * a task numbered as the project's next, with `options` and the project's settings as they are now. 6.12.
   */
  Rpc.make("projects.systemPrompt", {
    payload: { id: ProjectId, options: SystemPromptOptions },
    success: SystemPromptPreview,
    error: NotFound,
  }).annotate(RequiredScope, "read"),
  Rpc.make("projects.branches", { payload: { id: ProjectId }, success: Schema.Array(Branch), error: NotFound }).annotate(RequiredScope, "read"),
  /**
   * Remove the worktrees of the project's done tasks whose work is merged and that have nothing uncommitted, one at a
   * time, each base branch fetched once first: one result for each done task that had a worktree.
   */
  Rpc.make("projects.removeMergedWorktrees", { payload: { id: ProjectId }, success: Schema.Array(MergedWorktreeResult), error: NotFound }).annotate(
    RequiredScope,
    "git",
  ),
  /**
   * The project's setup thread, whose agent helps make its folder a git repository with a commit, started with `message`
   * after its instructions; the one it has already is returned as it is. `Conflict` (`worktree_made`) when the folder is
   * ready for worktrees already.
   */
  Rpc.make("projects.setupThread", {
    payload: { id: ProjectId, message: Schema.optional(Schema.String) },
    success: Task,
    error: Schema.Union([NotFound, Conflict, Invalid, Unavailable]),
  }).annotate(RequiredScope, "git"),
).middleware(Auth) {}
