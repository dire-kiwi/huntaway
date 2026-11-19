import { DateTime, Effect, Result, Schema } from "effect"
import { Tool } from "effect/ai"
import { SuggestionAction } from "@huntaway/contracts"
import type { TaskSuggestion } from "@huntaway/contracts"
import { Suggestions } from "../../assistant/Suggestions.ts"
import { ACTION_MEANINGS, cardTitle, MAX_ACTIONS, MAX_SUGGESTIONS, suggestionRow } from "../../assistant/suggestionText.ts"
import { owner } from "../../assistant/trackedList.ts"
import { TaskRepo } from "../../tasks/TaskRepo.ts"
import { makeReach } from "../resolve.ts"
import { ToolError } from "../tool.ts"
import { threadTool } from "./common.ts"

// `suggest_task_actions` (HE-61): the assistant, or a routine's thread under it, helps the user tidy the board with a
// list of tasks and what it suggests doing with each, as a card in the assistant's thread (`assistant/Suggestions.ts`). The user
// picks on each row whenever they get to it, and the board does it; the agent doesn't wait for that.

export const NOT_THE_ASSISTANT = "suggest_task_actions is the profile's assistant's: only it and its routines' threads can use it."

const ACTIONS_TEXT = SuggestionAction.literals.map((a) => `${a} (${ACTION_MEANINGS[a]})`).join(", ")

export const SuggestTaskActions = Tool.make("suggest_task_actions", {
  description:
    "For the profile's assistant (and its routines): help the user curate the board by suggesting what to do with tasks, such as " +
    "ones whose pull request has merged but that aren't done, stale ones, ones waiting to be merged, or ones to come back to later. " +
    "The board shows the list as a card in the assistant's thread (a routine's too): each task with your reason and a button for each action you offer (the " +
    "first one as the one you recommend), plus Leave it. When the user clicks one, the board does it straight away, as the " +
    `board's own buttons do. Actions: ${ACTIONS_TEXT}. Only tasks on this host's boards. You aren't told what the user picks, ` +
    "and needn't wait: end your turn with a short summary of what you suggested and why. Look at the tasks first (list_tasks, " +
    "get_task) so each suggestion fits the task as it is now.",
  parameters: Schema.Struct({
    title: Schema.optionalKey(Schema.String.annotate({ description: "The card's heading, in a few words (e.g. 'Merged but not done')" })),
    suggestions: Schema.Array(
      Schema.Struct({
        task: Schema.String.annotate({ description: "The task (id or key like ABC-12; <profile>:ABC-12 for one on another profile's board)" }),
        reason: Schema.String.annotate({
          description: "Why, in a sentence the user reads on the card (e.g. 'Its pull request was merged on GitHub 3 days ago'); also the reminder's note",
        }),
        actions: Schema.Array(SuggestionAction)
          .check(Schema.isMinLength(1), Schema.isMaxLength(MAX_ACTIONS))
          .annotate({ description: `What the user may do with it, the one you recommend first (1 to ${MAX_ACTIONS})` }),
        remind_at: Schema.optionalKey(
          Schema.String.annotate({
            description:
              "For remind: when, as a delay counted from when the user clicks (2h, 3d, 1w) or a date and time (2026-05-01, 2026-05-01 14:00 in the host's time zone); 1d if left out",
          }),
        ),
        message: Schema.optionalKey(Schema.String.annotate({ description: "For message: what to send the task's agent" })),
      }),
    )
      .check(Schema.isMinLength(1), Schema.isMaxLength(MAX_SUGGESTIONS))
      .annotate({ description: `The tasks, one row each, in the order to show them (1 to ${MAX_SUGGESTIONS})` }),
  }),
  success: Schema.Struct({ ok: Schema.Boolean, count: Schema.Finite, note: Schema.String }),
})

/** What the tool tells the agent once its card is up. */
export const POSTED =
  "The board shows your suggestions as a card in the assistant's thread; the user picks on each task when they're ready, and the board does it. " +
  "You aren't told what they pick. End your turn now with a short summary of what you suggested."

/** The suggestions tool's handler. */
export const suggestionTools = Effect.gen(function* () {
  const suggestions = yield* Suggestions
  const tasks = yield* TaskRepo
  const reach = yield* makeReach

  const suggestTaskActions = threadTool(SuggestTaskActions, (params, caller) =>
    Effect.gen(function* () {
      const t = caller.task
      const parent = t.parent_id === null ? null : yield* tasks.get(t.parent_id)
      // The assistant's own thread, also for a routine's run: the user reads its report there, and nobody watches the routine's.
      const assistant = owner(t, parent)
      if (assistant === null) return yield* ToolError.other(NOT_THE_ASSISTANT)
      const now = yield* DateTime.now
      const zone = DateTime.zoneMakeLocal()
      const rows: Array<TaskSuggestion> = []
      for (const s of params.suggestions) {
        const found = yield* reach
          .task(caller, s.task.trim(), null)
          .pipe(
            Effect.mapError((e) =>
              ToolError.other(
                e.notFound ? `task ${s.task}: not on a board on this host you can use (suggestions are for this host's tasks)` : `task ${s.task}: ${e.message}`,
              ),
            ),
          )
        if (rows.some((r) => r.task_id === found.id)) return yield* ToolError.other(`task ${s.task} is suggested twice: give it one row`)
        const board = yield* reach.profile(found.profile_id)
        const key = board !== null && board.id !== caller.profile.id ? `${board.name}:${found.key}` : found.key
        const row = suggestionRow({ ...s, task_id: found.id, key, title: found.title }, now, zone)
        if (Result.isFailure(row)) return yield* ToolError.other(row.failure)
        rows.push(row.success)
      }
      yield* suggestions
        .post(assistant, { title: cardTitle(params.title), suggestions: rows })
        .pipe(Effect.catchTag("TaskNotFound", () => Effect.fail(ToolError.other("unknown task"))))
      return { ok: true, count: rows.length, note: POSTED }
    }),
  )

  return { suggestTaskActions }
})
