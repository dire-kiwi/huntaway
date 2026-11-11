import { Context, Effect, Layer, Redacted, Schema } from "effect"
import type { Option } from "effect"
import { SqlSchema } from "effect/sql"
import { AgentConfigId, LinkId, ProfileId, Reviewer, Timestamp } from "@huntaway/contracts"
import type { Profile, ProjectId, TaskId } from "@huntaway/contracts"
import { Db } from "../platform/Db.ts"
import { Bit, encodeColumns, JsonColumn } from "../settings/columns.ts"

/** A `profiles` row as the wire's `Profile`. The Asana token and the approval rules are not selected. */
export const ProfileRow = Schema.Struct({
  id: ProfileId,
  name: Schema.String,
  claude_config_ids: JsonColumn(Schema.Array(AgentConfigId), []),
  default_model: Schema.NullOr(Schema.String),
  agent_access: JsonColumn(Schema.Array(Schema.String), []),
  github_account: Schema.NullOr(Schema.String),
  clone_dir: Schema.NullOr(Schema.String),
  asana_user: Schema.NullOr(Schema.String),
  asana_enabled: Bit,
  limit_wait: Bit,
  limit_switch: Bit,
  reviewers: JsonColumn(Schema.Array(Reviewer), []),
  summarizers: JsonColumn(Schema.Array(Reviewer), []),
  merge_approval: Bit,
  require_pr_approval: Bit,
  assistant_host: Schema.NullOr(LinkId),
  assistant_config_id: Schema.NullOr(AgentConfigId),
  threads_config_id: Schema.NullOr(AgentConfigId),
  telemetry: Bit,
  telemetry_titles: Bit,
  tint: Schema.NullOr(Schema.String),
  created_at: Timestamp,
})

const ids = <A>(rows: ReadonlyArray<{ readonly id: A }>) => rows.map((r) => r.id)

const COLUMNS = Object.keys(ProfileRow.fields).join(", ")

type Writable = Omit<Profile, "id" | "created_at" | "reviewers" | "summarizers"> & {
  readonly reviewers: ReadonlyArray<Reviewer> | null
  readonly summarizers: ReadonlyArray<Reviewer> | null
  readonly asana_token: string | null
}

/** The columns a write may set; one left out or undefined is left as it is. Lists are written as JSON, booleans as 0/1. */
export type ProfileColumns = { readonly [K in keyof Writable]?: Writable[K] | undefined }

/** What deleting a profile took with it. */
export interface DeletedProfile {
  readonly projects: ReadonlyArray<ProjectId>
  /** Its tasks in no project (scratch, group, assistant, pens and pen threads), review threads aside. */
  readonly tasks: ReadonlyArray<TaskId>
}

export interface ProfileRepoShape {
  /** Oldest first, those made in the same millisecond in the order they were added. */
  readonly list: Effect.Effect<ReadonlyArray<Profile>>
  readonly get: (id: ProfileId) => Effect.Effect<Option.Option<Profile>>
  readonly insert: (id: ProfileId, createdAt: Timestamp, columns: ProfileColumns) => Effect.Effect<void>
  readonly update: (id: ProfileId, columns: ProfileColumns) => Effect.Effect<void>
  /** The one read of the profile's Asana token. */
  readonly asanaToken: (id: ProfileId) => Effect.Effect<Redacted.Redacted | null>
  /** How many of the profile's tasks have an agent running. */
  readonly running: (id: ProfileId) => Effect.Effect<number>
  /**
   * Delete the profile and what hangs off it, by hand and in order: review threads, its other tasks, its projects,
   * the row. (The foreign keys would cascade; the order is the old `delete_profile`'s, for the steps later milestones
   * put between.)
   */
  readonly delete: (id: ProfileId) => Effect.Effect<DeletedProfile>
  /** Every folder a project or task on this host points at: what keeps a data-folder folder from being removed. */
  readonly usedPaths: Effect.Effect<ReadonlyArray<string>>
}

/** The `profiles` table. */
export class ProfileRepo extends Context.Service<ProfileRepo, ProfileRepoShape>()("huntaway-server/profiles/ProfileRepo") {
  static readonly layer = Layer.effect(
    ProfileRepo,
    Effect.gen(function* () {
      const { sql } = yield* Db
      const findAll = SqlSchema.findAll({
        Request: Schema.Void,
        Result: ProfileRow,
        execute: () => sql.unsafe(`SELECT ${COLUMNS} FROM profiles ORDER BY created_at, rowid`),
      })
      const findOne = SqlSchema.findOneOption({
        Request: ProfileId,
        Result: ProfileRow,
        execute: (id) => sql.unsafe(`SELECT ${COLUMNS} FROM profiles WHERE id = ?`, [id]),
      })

      const insert = (id: ProfileId, createdAt: Timestamp, columns: ProfileColumns) =>
        Effect.gen(function* () {
          const row = yield* encodeColumns({ ...columns, id, created_at: createdAt })
          yield* sql`INSERT INTO profiles ${sql.insert(row)}`
        }).pipe(Effect.orDie)

      const update = (id: ProfileId, columns: ProfileColumns) =>
        Effect.gen(function* () {
          const row = yield* encodeColumns(columns)
          if (Object.keys(row).length === 0) return
          yield* sql`UPDATE profiles SET ${sql.update(row)} WHERE id = ${id}`
        }).pipe(Effect.orDie)

      const asanaToken = (id: ProfileId) =>
        sql<{ readonly asana_token: string | null }>`SELECT asana_token FROM profiles WHERE id = ${id}`.pipe(
          Effect.map((rows) => {
            const token = rows[0]?.asana_token ?? null
            return token === null ? null : Redacted.make(token)
          }),
          Effect.orDie,
        )

      const running = (id: ProfileId) =>
        sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM tasks WHERE profile_id = ${id} AND running = 1`.pipe(
          Effect.map((rows) => rows[0]?.n ?? 0),
          Effect.orDie,
        )

      const remove = (id: ProfileId) =>
        Effect.gen(function* () {
          const projects = ids(yield* sql<{ readonly id: ProjectId }>`SELECT id FROM projects WHERE profile_id = ${id}`)
          const tasks = ids(yield* sql<{ readonly id: TaskId }>`SELECT id FROM tasks WHERE profile_id = ${id} AND project_id IS NULL AND kind = 'task'`)
          yield* sql`DELETE FROM tasks WHERE profile_id = ${id} AND kind = 'review'`
          yield* sql`DELETE FROM tasks WHERE profile_id = ${id}`
          yield* sql`DELETE FROM projects WHERE profile_id = ${id}`
          yield* sql`DELETE FROM profiles WHERE id = ${id}`
          return { projects, tasks }
        }).pipe(Effect.orDie)

      const usedPaths = sql<{ readonly p: string }>`
        SELECT repo_path AS p FROM projects UNION SELECT scratch_path FROM projects UNION SELECT worktrees_root FROM projects
        UNION SELECT worktree_path FROM tasks WHERE worktree_path IS NOT NULL UNION SELECT work_dir FROM tasks WHERE work_dir IS NOT NULL`.pipe(
        Effect.map((rows) => rows.map((r) => r.p)),
        Effect.orDie,
      )

      return ProfileRepo.of({
        list: findAll(undefined).pipe(Effect.orDie),
        get: (id) => findOne(id).pipe(Effect.orDie),
        insert,
        update,
        asanaToken,
        running,
        delete: remove,
        usedPaths,
      })
    }),
  )
}
