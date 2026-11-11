import { Context, Effect, FiberSet, Layer, Option, Ref, Result, Schema } from "effect"
import { SqlClient } from "effect/sql"
import type { Task, TaskId } from "@huntaway/contracts"
import { Actor } from "../platform/Changes.ts"
import { Db } from "../platform/Db.ts"
import { titleFromDescription, titleInput, titleRefresh } from "../prompts/titles.ts"
import { AgentConfigRepo } from "../profiles/AgentConfigRepo.ts"
import type { AgentConfigRow } from "../profiles/AgentConfigRepo.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { Tasks } from "../tasks/Tasks.ts"
import { ThreadReaders } from "../threads/ThreadReaders.ts"
import { SideCalls } from "./SideCalls.ts"
import { TitleModel } from "./TitleModel.ts"
import { beginRefresh, clean, endRefresh, isKeep, MESSAGES, newTitle, noRefreshes, refreshInput } from "./titles/text.ts"
import type { Refreshes } from "./titles/text.ts"

// Task titles (docs/plan/07-agents.md, Titles; huntaway's agent/title.ts), written with the task's agent and login. A
// task created from a description alone starts with a placeholder (`tasks/checks.ts` `placeholderTitle`) while a title
// is written (`generate`), and each prompt the user sends it after that re-titles it for what it's about by then
// (`refresh`), unless its title was renamed by hand (`title_pinned`). Stack titles are the stacks' (4.x).

/** A title could not be written: the model call failed or gave nothing. Logged, never shown. */
export class TitleFailed extends Schema.TaggedError<TitleFailed, { readonly brand: unique symbol }>()("TitleFailed", { reason: Schema.String }) {}

export interface TitlesShape {
  /**
   * Write `task`'s title from its description, over the title it has as this is asked (the placeholder): kept if the
   * user renames it meanwhile, never written over a pinned one. Waits for the model; a failure is logged and leaves
   * the title as it is.
   */
  readonly generate: (task: TaskId) => Effect.Effect<void>
  /**
   * `generate` in the background, then `then`: a new task's start, which waits for its title because the title names
   * its branch and opens its agent's prompt (the caller's `then` sends it unless the task was started by hand meanwhile).
   * Returns at once.
   */
  readonly generateLater: (task: TaskId, then?: Effect.Effect<void>) => Effect.Effect<void>
  /**
   * Re-title the task for what it is about now, from its description and the messages the user has sent it: not a
   * pinned title, and not a thread other than a code task. Of two refreshes of a task, only the latest asked is
   * applied. Waits for the model; a failure is logged.
   */
  readonly refresh: (task: TaskId) => Effect.Effect<void>
  /** `refresh` in the background (numbered as it is asked, so the latest asked still wins). Returns at once. */
  readonly refreshLater: (task: TaskId) => Effect.Effect<void>
}

export class Titles extends Context.Service<Titles, TitlesShape>()("huntaway-server/agents/Titles") {
  static readonly layer = Layer.effect(
    Titles,
    Effect.gen(function* () {
      const tasks = yield* Tasks
      const repo = yield* TaskRepo
      const configs = yield* AgentConfigRepo
      const readers = yield* ThreadReaders
      const model = yield* TitleModel
      const sideCalls = yield* SideCalls
      const db = yield* Db
      const sql = yield* SqlClient.SqlClient
      const refreshes = yield* Ref.make<Refreshes>(noRefreshes)
      const background = yield* FiberSet.make()

      /** The config the task's agent runs with (the old `task_claude_config`): its own, else its project's or profile's first. */
      const configOf = Effect.fnUntraced(function* (task: Task) {
        if (task.claude_config_id !== null) {
          const own = yield* configs.get(task.claude_config_id)
          if (Option.isSome(own)) return own.value
        } else if (task.session_id !== null) {
          // A thread is given a config when it starts, so one with a session and none started in Claude's default.
          return null
        }
        const project = task.project_id === null ? null : yield* repo.project(task.project_id)
        const [first] = yield* repo.configs(task.profile_id, project)
        if (first === undefined) return null
        return Option.getOrNull(yield* configs.get(first))
      })

      /** Ask for a title with the task's agent and login, and keep the tokens it took (failed or not). */
      const ask = Effect.fnUntraced(function* (task: Task, system: string, input: string) {
        const config: AgentConfigRow | null = yield* configOf(task)
        const answer = yield* model.ask(config, system, input)
        if (answer.spent !== null) yield* sideCalls.record("title", task.id, config?.id ?? null, answer.spent)
        if (Result.isFailure(answer.reply)) return yield* new TitleFailed({ reason: answer.reply.failure })
        const title = clean(answer.reply.success)
        if (title === "") return yield* new TitleFailed({ reason: `${config?.agent ?? "claude"} returned no title` })
        return title
      })

      /** Save a title written for the task, unless it's pinned, or its title has changed from `old` (if given) since it was asked for. */
      const save = (id: TaskId, old: string | null, title: string) =>
        tasks
          .change(id, (t) => (t.title_pinned || (old !== null && t.title !== old) || t.title === title ? null : { title }), Actor.board)
          .pipe(
            Effect.asVoid,
            Effect.catchTag("TaskNotFound", () => Effect.void),
          )

      const generate = Effect.fn("Titles.generate")(function* (id: TaskId) {
        const task = yield* repo.get(id)
        if (task === null) return
        const title = yield* ask(task, titleFromDescription, titleInput(task.description)).pipe(
          Effect.catchTag("TitleFailed", (e) => Effect.as(Effect.logWarning(`task ${id}: title generation failed: ${e.reason}`), null)),
        )
        // Keeps a title the user edited in the meantime.
        if (title !== null) yield* save(id, task.title, title)
      })

      /** The user's parts of what is queued for the task's next run (the old `queued_user_text`). */
      const queuedUserText = (id: TaskId) =>
        sql<{ readonly text: string }>`SELECT text FROM task_queue WHERE task_id = ${id} AND source = 'user' ORDER BY seq`.pipe(
          Effect.map((rows) => (rows.length === 0 ? null : rows.map((r) => r.text).join("\n\n"))),
          Effect.orDie,
        )

      /** What a refresh finds: the task's new title, if it has one. */
      const reconsider = Effect.fnUntraced(function* (id: TaskId) {
        // Read together, so a message the agent takes in meanwhile isn't counted twice.
        const read = yield* db.tx(
          Effect.gen(function* () {
            const task = yield* repo.get(id)
            if (task === null || task.kind !== "task" || task.title_pinned) return null
            return { task, replies: yield* readers.userReplies(id, MESSAGES), queued: yield* queuedUserText(id) }
          }),
        )
        if (read === null) return null
        const { task, replies, queued } = read
        const pending = task.steering.some((s) => !s.from_agent) || queued !== null
        if (task.description.trim() === "" && replies.replies.length === 0 && !pending) return null
        const input = refreshInput(
          { title: task.title, description: task.description, steering: task.steering, queued_user_text: queued },
          replies.replies,
          replies.since,
          replies.earlier,
        )
        let reply = yield* ask(task, titleRefresh, input)
        // The model now and then explains itself instead; asked again, it answers.
        if (newTitle(reply, task.title) === null && !isKeep(reply, task.title)) reply = yield* ask(task, titleRefresh, input)
        const title = newTitle(reply, task.title)
        return title === null || title === task.title ? null : title
      })

      /** Refresh number `n` of the task (see `beginRefresh`). */
      const refreshNumbered = (id: TaskId, n: number) =>
        Effect.gen(function* () {
          const found = yield* Effect.result(reconsider(id))
          const latest = yield* Ref.modify(refreshes, (s) => endRefresh(s, id, n))
          if (Result.isFailure(found)) {
            yield* Effect.logWarning(`task ${id}: title refresh failed: ${found.failure.reason}`)
            return
          }
          // Over a title the board wrote meanwhile (the one generated as the task was created, say), since this one has
          // seen the newest message; a rename by hand is pinned, so it's kept.
          if (found.success !== null && latest) yield* save(id, null, found.success)
        })

      const begin = (id: TaskId) => Ref.modify(refreshes, (s) => beginRefresh(s, id))

      const refresh = Effect.fn("Titles.refresh")(function* (id: TaskId) {
        yield* refreshNumbered(id, yield* begin(id))
      })

      const refreshLater = Effect.fn("Titles.refreshLater")(function* (id: TaskId) {
        const n = yield* begin(id)
        yield* FiberSet.run(background, refreshNumbered(id, n).pipe(Effect.withSpan("Titles.refresh")))
      })

      const generateLater = Effect.fn("Titles.generateLater")(function* (id: TaskId, then: Effect.Effect<void> = Effect.void) {
        yield* FiberSet.run(background, generate(id).pipe(Effect.andThen(then)))
      })

      return Titles.of({ generate, generateLater, refresh, refreshLater })
    }),
  )
}
