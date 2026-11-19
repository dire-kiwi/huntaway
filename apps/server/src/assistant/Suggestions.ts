import { Context, DateTime, Effect, Layer, Option, Schema } from "effect"
import { Invalid, SUGGESTIONS_CODE, TaskId, TaskSuggestions } from "@huntaway/contracts"
import type { Conflict, NotFound, Status, SuggestionChoice, SuggestionOutcome, TaskPatch, TaskSuggestion } from "@huntaway/contracts"
import type { Actor } from "../platform/Changes.ts"
import { nowTimestamp } from "../platform/columns.ts"
import { KeyedLock } from "../platform/KeyedLock.ts"
import { Runs } from "../runs/Runs.ts"
import type { SendRefused } from "../runs/Runs.ts"
import { TaskDeletion } from "../runs/TaskDeletion.ts"
import { reminderTime } from "../tasks/reminders.ts"
import type { TaskNotFound } from "../tasks/Tasks.ts"
import { Tasks } from "../tasks/Tasks.ts"
import { Threads } from "../threads/Threads.ts"
import { ThreadStore } from "../threads/ThreadStore.ts"
import { cardText, refusal, settled } from "./suggestionText.ts"

// The assistant's suggestions cards (HE-61; the plain parts are suggestionText.ts, the tool mcp/tools/suggestions.ts):
// `suggest_task_actions` puts a list of tasks in the thread, each with why and what the assistant suggests doing with it
// (move it to Done, merge it, remind me later…). The card is a notice (code `task_suggestions`, `metadata` the card),
// not a request: it doesn't hold the agent up, nothing settles it but the user, and its rows are settled one at a time,
// each from its own buttons (`act`), whenever the user gets to it. Picking one does what the board's own button does,
// as the user, and marks the row; the agent isn't told (the board shows the tasks as they are now).

/** The thread has no suggestions card by that id, or the card no row at that index. */
export class SuggestionNotFound extends Schema.TaggedError<SuggestionNotFound, { readonly brand: unique symbol }>()("SuggestionNotFound", {
  task_id: Schema.String,
  item_id: Schema.String,
  index: Schema.Finite,
}) {}

/** The row has been settled already. */
export class SuggestionClosed extends Schema.TaggedError<SuggestionClosed, { readonly brand: unique symbol }>()("SuggestionClosed", {
  detail: Schema.String,
}) {}

/** How each pick that moves its task moves it: the column, and for Done its resolution. */
const MOVES = {
  done: { status: "done", resolution: "done" },
  wont_fix: { status: "done", resolution: "wont_fix" },
  merge: { status: "ready_for_merge" },
  backlog: { status: "backlog" },
} as const satisfies Readonly<Record<string, TaskPatch & { readonly status: Status }>>

export interface SuggestionsShape {
  /** Puts `card` in `thread` as a suggestions card; its item's id. */
  readonly post: (thread: TaskId, card: TaskSuggestions) => Effect.Effect<string, TaskNotFound>
  /**
   * Row `index` of card `item` in `thread`: does `choice` with its task, as the user (`by`), and marks the row settled.
   * Only the first pick counts; one that fails leaves the row as it was. `beforeMove` is told the task and the column
   * first, when the pick moves it.
   */
  readonly act: (
    thread: TaskId,
    item: string,
    index: number,
    choice: SuggestionChoice,
    by: Actor,
    beforeMove?: (task: TaskId, status: Status) => Effect.Effect<void>,
  ) => Effect.Effect<void, TaskNotFound | SuggestionNotFound | SuggestionClosed | Invalid | Conflict | NotFound | SendRefused>
}

const decodeCard = Schema.decodeUnknownOption(TaskSuggestions)

export class Suggestions extends Context.Service<Suggestions, SuggestionsShape>()("huntaway-server/assistant/Suggestions") {
  static readonly layer = Layer.effect(
    Suggestions,
    Effect.gen(function* () {
      const threads = yield* Threads
      const store = yield* ThreadStore
      const tasks = yield* Tasks
      const runs = yield* Runs
      const deletion = yield* TaskDeletion
      const locks = yield* KeyedLock

      const post = Effect.fn("Suggestions.post")(function* (thread: TaskId, card: TaskSuggestions) {
        return yield* threads.card(thread, SUGGESTIONS_CODE, cardText(card), card)
      })

      /** Card `item` of `thread`, as its notice keeps it. */
      const cardOf = Effect.fnUntraced(function* (thread: TaskId, item: string, index: number) {
        const entry = yield* store.item(thread, item)
        const it = entry?.item
        const card = it?.type === "notice" && it.code === SUGGESTIONS_CODE ? decodeCard(it.metadata) : Option.none()
        if (Option.isNone(card)) return yield* new SuggestionNotFound({ task_id: thread, item_id: item, index })
        return card.value
      })

      /** Does `choice` with the row's task; the outcome to mark it with. */
      const apply = Effect.fnUntraced(function* (
        row: TaskSuggestion,
        choice: SuggestionChoice,
        by: Actor,
        beforeMove: (task: TaskId, status: Status) => Effect.Effect<void>,
      ) {
        const id = TaskId.make(row.task_id)
        const at = yield* nowTimestamp
        const outcome: SuggestionOutcome = { choice, at }
        switch (choice) {
          case "done":
          case "wont_fix":
          case "merge":
          case "backlog": {
            const move = MOVES[choice]
            yield* beforeMove(id, move.status)
            yield* tasks.update(id, move, by)
            return outcome
          }
          case "remind": {
            // A delay counts from now, when the user picked it.
            const when = reminderTime(row.remind_at ?? "", yield* DateTime.now, DateTime.zoneMakeLocal())
            if (when === null || when === "")
              return yield* new Invalid({ field: "remind_at", reason: `can't read the reminder's time "${row.remind_at ?? ""}"` })
            yield* tasks.update(id, { remind_at: when, reminder: row.reason }, by)
            return { ...outcome, remind_at: when }
          }
          case "start":
            yield* runs.send(id, { text: "", source: "user" })
            return outcome
          case "message":
            yield* runs.send(id, { text: row.message ?? "", source: "user" })
            return outcome
          case "delete":
            yield* deletion.delete(id, { deleteBranch: false }, by)
            return outcome
          case "keep":
            break
        }
        return outcome
      })

      const act = Effect.fn("Suggestions.act")(function* (
        thread: TaskId,
        item: string,
        index: number,
        choice: SuggestionChoice,
        by: Actor,
        beforeMove: (task: TaskId, status: Status) => Effect.Effect<void> = () => Effect.void,
      ) {
        // One pick on a thread's cards at a time, held while it's done: of two picks of a row, the second finds it settled.
        yield* locks.withLock(["suggestions", thread])(
          Effect.gen(function* () {
            const card = yield* cardOf(thread, item, index)
            const row = card.suggestions[index]
            if (row === undefined) return yield* new SuggestionNotFound({ task_id: thread, item_id: item, index })
            const refused = refusal(row, choice)
            if (refused !== null)
              return yield* refused.closed ? new SuggestionClosed({ detail: refused.reason }) : new Invalid({ field: "choice", reason: refused.reason })
            const outcome = yield* apply(row, choice, by, beforeMove)
            return yield* threads.updateItem(thread, item, { metadata: settled(card, index, outcome) })
          }),
        )
      })

      return Suggestions.of({ post, act })
    }),
  )
}
