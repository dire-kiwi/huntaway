import { Context, Effect, Layer, Schema } from "effect"
import { Timestamp } from "@huntaway/contracts"
import type { TaskId, DocumentVersion } from "@huntaway/contracts"
import { rowsOf } from "../platform/columns.ts"
import { Db } from "../platform/Db.ts"

// The `documents` rows (docs/plan/04-database.md; inventory 02, section 2.7): each version of a task's document for a
// label, `open` while the agent's turn that writes it goes on. Statements only, so any of them may run in a transaction.
// `label` is text: a task's labels' documents, and the assistant's brief (`brief`, `brief_items`, 6.7).

const Flag = Schema.Literals([0, 1])

/** The latest version of a document, as `keep` decides on it. */
const Latest = Schema.Struct({ version: Schema.Int, content: Schema.String, open: Flag, created_at: Timestamp })
export interface LatestVersion {
  readonly version: number
  readonly content: string
  readonly open: boolean
  readonly created_at: Timestamp
}

const VersionRow = Schema.Struct({ version: Schema.Int, open: Flag, created_at: Timestamp, updated_at: Timestamp, size: Schema.Int })
const Content = Schema.Struct({ content: Schema.String })

const readLatest = rowsOf(Latest)
const readVersions = rowsOf(VersionRow)
const readContent = rowsOf(Content)

export interface TaskDocumentRepoShape {
  readonly latest: (task: TaskId, label: string) => Effect.Effect<LatestVersion | null>
  /** A new version (`open` while its turn goes on). */
  readonly insert: (task: TaskId, label: string, version: number, content: string, open: boolean, at: Timestamp) => Effect.Effect<void>
  /** The version's content, as the file has it now. */
  readonly update: (task: TaskId, label: string, version: number, content: string, open: boolean, at: Timestamp) => Effect.Effect<void>
  /** Close the task's open versions (`label`'s only, if given). */
  readonly close: (task: TaskId, label?: string) => Effect.Effect<void>
  /** The versions of a document, oldest first. */
  readonly versions: (task: TaskId, label: string) => Effect.Effect<ReadonlyArray<DocumentVersion>>
  readonly content: (task: TaskId, label: string, version: number) => Effect.Effect<string | null>
}

export class TaskDocumentRepo extends Context.Service<TaskDocumentRepo, TaskDocumentRepoShape>()("huntaway-server/docs/TaskDocumentRepo") {
  static readonly layer = Layer.effect(
    TaskDocumentRepo,
    Effect.gen(function* () {
      const { sql } = yield* Db
      return TaskDocumentRepo.of({
        latest: (task, label) =>
          Effect.map(
            readLatest(
              sql`SELECT version, content, open, created_at FROM documents WHERE task_id = ${task} AND label = ${label} ORDER BY version DESC LIMIT 1`,
            ),
            (rows) => {
              const row = rows[0]
              return row === undefined ? null : { version: row.version, content: row.content, open: row.open === 1, created_at: row.created_at }
            },
          ),
        insert: (task, label, version, content, open, at) =>
          sql`INSERT INTO documents (task_id, label, version, content, open, created_at, updated_at)
            VALUES (${task}, ${label}, ${version}, ${content}, ${open ? 1 : 0}, ${at}, ${at})`.pipe(Effect.asVoid, Effect.orDie),
        update: (task, label, version, content, open, at) =>
          sql`UPDATE documents SET content = ${content}, open = ${open ? 1 : 0}, updated_at = ${at}
            WHERE task_id = ${task} AND label = ${label} AND version = ${version}`.pipe(Effect.asVoid, Effect.orDie),
        close: (task, label) =>
          (label === undefined
            ? sql`UPDATE documents SET open = 0 WHERE task_id = ${task} AND open = 1`
            : sql`UPDATE documents SET open = 0 WHERE task_id = ${task} AND label = ${label} AND open = 1`
          ).pipe(Effect.asVoid, Effect.orDie),
        versions: (task, label) =>
          Effect.map(
            readVersions(
              sql`SELECT version, open, created_at, updated_at, length(content) AS size FROM documents WHERE task_id = ${task} AND label = ${label} ORDER BY version`,
            ),
            (rows) =>
              rows.map((r): DocumentVersion => ({ version: r.version, open: r.open === 1, created_at: r.created_at, updated_at: r.updated_at, size: r.size })),
          ),
        content: (task, label, version) =>
          Effect.map(
            readContent(sql`SELECT content FROM documents WHERE task_id = ${task} AND label = ${label} AND version = ${version}`),
            (rows) => rows[0]?.content ?? null,
          ),
      })
    }),
  )
}
