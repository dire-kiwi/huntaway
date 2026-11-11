import { Context, Effect, Layer } from "effect"
import type { Task, TaskId } from "@huntaway/contracts"
import { Db } from "../platform/Db.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"

// 6.11: what `Relocation` reads of the rows besides the projects' (`ProjectRepo`): a project's threads, the tasks working
// in a folder, and the config folder a conversation started in (the runs table's, as the old `session_config_dir`).

export interface RelocationRepoShape {
  /** The project's tasks and their review threads. */
  readonly threads: (project: string) => Effect.Effect<ReadonlyArray<Task>>
  /** The tasks that work in the folder `dir` (`work_dir`): the scratch chats that were the project's. */
  readonly inWorkDir: (dir: string) => Effect.Effect<ReadonlyArray<Task>>
  /** The config folder the thread's conversation `session` started in, as its first run recorded it ("" for the default). */
  readonly sessionConfigDir: (task: TaskId, session: string) => Effect.Effect<string | null>
}

export class RelocationRepo extends Context.Service<RelocationRepo, RelocationRepoShape>()("huntaway-server/git/RelocationRepo") {
  static readonly layer = Layer.effect(
    RelocationRepo,
    Effect.gen(function* () {
      const { sql } = yield* Db
      const tasks = yield* TaskRepo
      const ids = (rows: ReadonlyArray<{ readonly id: string }>) => tasks.getMany(rows.map((r) => r.id))
      return RelocationRepo.of({
        threads: (project) =>
          sql<{ readonly id: string }>`SELECT id FROM tasks WHERE project_id = ${project} AND kind IN ('task', 'review') ORDER BY rowid`.pipe(
            Effect.orDie,
            Effect.flatMap(ids),
          ),
        inWorkDir: (dir) => sql<{ readonly id: string }>`SELECT id FROM tasks WHERE work_dir = ${dir} ORDER BY rowid`.pipe(Effect.orDie, Effect.flatMap(ids)),
        sessionConfigDir: (task, session) =>
          sql<{ readonly config_dir: string | null }>`
            SELECT config_dir FROM runs WHERE task_id = ${task} AND session_id = ${session} ORDER BY seq LIMIT 1`.pipe(
            Effect.map((rows) => rows[0]?.config_dir ?? null),
            Effect.orDie,
          ),
      })
    }),
  )
}
