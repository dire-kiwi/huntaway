import { Context, Effect, Layer, Schema } from "effect"
import type { Option } from "effect"
import { SqlSchema } from "effect/sql"
import { AgentConfigId, PermissionMode, ProfileId, ProjectId, Reviewer, StatusScripts, TaskId, Timestamp, WatchPullRequests } from "@huntaway/contracts"
import type { Project } from "@huntaway/contracts"
import { Db } from "../platform/Db.ts"
import { Bit, encodeColumns, JsonColumn, NullableBit, NullableJsonColumn } from "../platform/columns.ts"

/** A `projects` row as the wire's `Project`. `repo_root` and `next_number` are not selected. */
export const ProjectRow = Schema.Struct({
  id: ProjectId,
  profile_id: ProfileId,
  name: Schema.String,
  key: Schema.String,
  former_keys: JsonColumn(Schema.Array(Schema.String), []),
  repo_path: Schema.String,
  scratch_path: Schema.String,
  worktrees_root: Schema.String,
  base_branch: Schema.NullOr(Schema.String),
  setup_script: Schema.String,
  teardown_script: Schema.String,
  copy_files: Schema.String,
  link_folders: Schema.String,
  status_script: Schema.String,
  status_scripts: JsonColumn(StatusScripts, {}),
  use_worktrees: Bit,
  is_git: Bit,
  has_commits: Bit,
  setup_task_id: Schema.NullOr(TaskId),
  permission_mode: Schema.NullOr(PermissionMode),
  model: Schema.NullOr(Schema.String),
  claude_config_ids: NullableJsonColumn(Schema.Array(AgentConfigId)),
  auto_review: Bit,
  done_when_merged: Bit,
  use_workflows: Bit,
  pull_requests: Bit,
  review_rounds: Schema.Int,
  reviewers: JsonColumn(Schema.Array(Reviewer), []),
  auto_summary: Bit,
  summarizers: JsonColumn(Schema.Array(Reviewer), []),
  merge_approval: NullableBit,
  require_pr_approval: NullableBit,
  start_prompt: Schema.NullOr(Schema.String),
  review_prompt: Schema.NullOr(Schema.String),
  merge_prompt: Schema.NullOr(Schema.String),
  group_name: Schema.NullOr(Schema.String),
  archived_at: Schema.NullOr(Timestamp),
  github_account: Schema.NullOr(Schema.String),
  watch_pull_requests: WatchPullRequests,
  pr_preview_url: Schema.NullOr(Schema.String),
  created_at: Timestamp,
})

const COLUMNS = Object.keys(ProjectRow.fields).join(", ")

type Writable = Omit<Project, "id" | "created_at" | "reviewers" | "summarizers" | "claude_config_ids"> & {
  readonly reviewers: ReadonlyArray<Reviewer> | null
  readonly summarizers: ReadonlyArray<Reviewer> | null
  readonly claude_config_ids: ReadonlyArray<AgentConfigId> | null
  /** What the repository was when last seen (its root commits, `git`, or ""), to recognise it after a move. */
  readonly repo_root: string | null
}

/** The columns a write may set; one left out or undefined is left as it is. */
export type ProjectColumns = { readonly [K in keyof Writable]?: Writable[K] | undefined }

export interface ProjectRepoShape {
  /** A profile's projects, archived ones too, by name whatever its case. */
  readonly list: (profileId: ProfileId) => Effect.Effect<ReadonlyArray<Project>>
  readonly get: (id: ProjectId) => Effect.Effect<Option.Option<Project>>
  readonly insert: (id: ProjectId, createdAt: Timestamp, columns: ProjectColumns) => Effect.Effect<void>
  readonly update: (id: ProjectId, columns: ProjectColumns) => Effect.Effect<void>
  /** How many of its tasks have an agent running. */
  readonly running: (id: ProjectId) => Effect.Effect<number>
  /** The number its next task gets (for the system prompt's preview, which takes none). */
  readonly nextNumber: (id: ProjectId) => Effect.Effect<number>
  /** Delete the project and its tasks, review threads first, then the row. */
  readonly delete: (id: ProjectId) => Effect.Effect<void>
  // 6.11: what `Relocation` and the fingerprint recorder read and write.
  /** What its repository was when last seen (`repo_root`): its root commits, `git`, "" or null. */
  readonly repoRoot: (id: ProjectId) => Effect.Effect<string | null>
  /** Every project's folder, in every profile: what a folder move must not take from under another project. */
  readonly folders: Effect.Effect<ReadonlyArray<{ readonly id: ProjectId; readonly name: string; readonly repo_path: string }>>
  /** The projects whose `repo_root` isn't a history yet (null, "" or `git`). */
  readonly unrecorded: Effect.Effect<ReadonlyArray<{ readonly id: ProjectId; readonly repo_path: string; readonly repo_root: string | null }>>
  /** Records `root` as what the project's folder is, unless the project has moved to another folder meanwhile. */
  readonly recordRoot: (id: ProjectId, repoPath: string, root: string) => Effect.Effect<void>
}

/** The `projects` table. */
export class ProjectRepo extends Context.Service<ProjectRepo, ProjectRepoShape>()("huntaway-server/projects/ProjectRepo") {
  static readonly layer = Layer.effect(
    ProjectRepo,
    Effect.gen(function* () {
      const { sql } = yield* Db
      const findAll = SqlSchema.findAll({
        Request: ProfileId,
        Result: ProjectRow,
        execute: (profileId) => sql.unsafe(`SELECT ${COLUMNS} FROM projects WHERE profile_id = ? ORDER BY name COLLATE NOCASE, rowid`, [profileId]),
      })
      const findOne = SqlSchema.findOneOption({
        Request: ProjectId,
        Result: ProjectRow,
        execute: (id) => sql.unsafe(`SELECT ${COLUMNS} FROM projects WHERE id = ?`, [id]),
      })

      const insert = (id: ProjectId, createdAt: Timestamp, columns: ProjectColumns) =>
        Effect.gen(function* () {
          const row = yield* encodeColumns({ ...columns, id, created_at: createdAt })
          yield* sql`INSERT INTO projects ${sql.insert(row)}`
        }).pipe(Effect.orDie)

      const update = (id: ProjectId, columns: ProjectColumns) =>
        Effect.gen(function* () {
          const row = yield* encodeColumns(columns)
          if (Object.keys(row).length === 0) return
          yield* sql`UPDATE projects SET ${sql.update(row)} WHERE id = ${id}`
        }).pipe(Effect.orDie)

      const remove = (id: ProjectId) =>
        Effect.gen(function* () {
          yield* sql`DELETE FROM tasks WHERE project_id = ${id} AND kind = 'review'`
          yield* sql`DELETE FROM tasks WHERE project_id = ${id}`
          yield* sql`DELETE FROM projects WHERE id = ${id}`
        }).pipe(Effect.orDie)

      return ProjectRepo.of({
        list: (profileId) => findAll(profileId).pipe(Effect.orDie),
        get: (id) => findOne(id).pipe(Effect.orDie),
        insert,
        update,
        running: (id) =>
          sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM tasks WHERE project_id = ${id} AND running = 1`.pipe(
            Effect.map((rows) => rows[0]?.n ?? 0),
            Effect.orDie,
          ),
        nextNumber: (id) =>
          sql<{ readonly n: number }>`SELECT next_number AS n FROM projects WHERE id = ${id}`.pipe(
            Effect.map((rows) => rows[0]?.n ?? 1),
            Effect.orDie,
          ),
        delete: remove,
        repoRoot: (id) =>
          sql<{ readonly repo_root: string | null }>`SELECT repo_root FROM projects WHERE id = ${id}`.pipe(
            Effect.map((rows) => rows[0]?.repo_root ?? null),
            Effect.orDie,
          ),
        folders: sql<{ readonly id: ProjectId; readonly name: string; readonly repo_path: string }>`SELECT id, name, repo_path FROM projects`.pipe(
          Effect.orDie,
        ),
        unrecorded: sql<{ readonly id: ProjectId; readonly repo_path: string; readonly repo_root: string | null }>`
          SELECT id, repo_path, repo_root FROM projects WHERE repo_root IS NULL OR repo_root IN ('', 'git')`.pipe(Effect.orDie),
        recordRoot: (id, repoPath, root) =>
          sql`UPDATE projects SET repo_root = ${root} WHERE id = ${id} AND repo_path = ${repoPath}`.pipe(Effect.asVoid, Effect.orDie),
      })
    }),
  )
}
