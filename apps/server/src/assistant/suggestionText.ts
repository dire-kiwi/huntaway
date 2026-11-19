import { Result } from "effect"
import type { DateTime } from "effect"
import type { SuggestionAction, SuggestionChoice, SuggestionOutcome, TaskSuggestion, TaskSuggestions } from "@huntaway/contracts"
import { reminderTime } from "../tasks/reminders.ts"

// The plain parts of the assistant's suggestions cards (HE-61; the service is Suggestions.ts, the tool
// mcp/tools/suggestions.ts): what a card's rows may say, how one is settled, and what the card's notice says to a client
// that doesn't draw it.

/** The most rows a card has. */
export const MAX_SUGGESTIONS = 30
/** The most actions a row offers. */
export const MAX_ACTIONS = 4
/** The longest reason: it is the reminder's note when the user picks Remind me (a task's reminder is at most 500). */
export const MAX_REASON = 500
/** The longest message a row sends a task's agent. */
export const MAX_MESSAGE = 4000
/** The longest heading. */
export const MAX_TITLE = 200
/** The heading of a card the assistant gave none. */
export const DEFAULT_TITLE = "Tasks to tidy up"
/** When Remind me reminds the user, when the assistant didn't say. */
export const DEFAULT_REMIND = "1d"

/** What each action does, as the tool's description and its errors name it. */
export const ACTION_MEANINGS: { readonly [A in SuggestionAction]: string } = {
  done: "move it to Done (its work is finished, or merged elsewhere)",
  wont_fix: "close it as won't fix (moved to Done, not merged)",
  merge: "merge it (moved to Ready for merge: its agent merges its work)",
  remind: "remind the user of it later (remind_at; the reason is the reminder's note)",
  backlog: "move it to the backlog",
  start: "start its agent (a task in To do or the backlog that hasn't run)",
  message: "send its agent a message (message), which starts or resumes it",
  delete: "delete it (its worktree too, not its branch)",
}

/** A row as the assistant gave it, its task found. */
export interface NewSuggestion {
  readonly task_id: string
  readonly key: string
  readonly title: string
  readonly reason: string
  readonly actions: ReadonlyArray<SuggestionAction>
  readonly remind_at?: string | undefined
  readonly message?: string | undefined
}

/**
 * The row for what the assistant gave, or why it's wrong: a reason, one to `MAX_ACTIONS` different actions, a message
 * for `message`, and for `remind` a time `reminderTime` reads (`DEFAULT_REMIND` if none is given; read again when the
 * user picks it, so a delay counts from then).
 */
export const suggestionRow = (s: NewSuggestion, now: DateTime.Utc, zone: DateTime.TimeZone): Result.Result<TaskSuggestion, string> => {
  const where = `the suggestion for ${s.key}`
  const reason = s.reason.trim()
  if (reason === "") return Result.fail(`${where} needs a reason`)
  if (reason.length > MAX_REASON) return Result.fail(`${where}: its reason is longer than ${MAX_REASON} characters`)
  if (s.actions.length === 0) return Result.fail(`${where} needs at least one action`)
  if (s.actions.length > MAX_ACTIONS) return Result.fail(`${where} offers more than ${MAX_ACTIONS} actions`)
  if (new Set(s.actions).size !== s.actions.length) return Result.fail(`${where} offers an action twice`)
  const message = s.message?.trim() ?? ""
  if (s.actions.includes("message") && message === "") return Result.fail(`${where} offers message: give the message to send`)
  if (message.length > MAX_MESSAGE) return Result.fail(`${where}: its message is longer than ${MAX_MESSAGE} characters`)
  const remind = s.remind_at?.trim() ?? ""
  if (s.actions.includes("remind") && remind !== "" && reminderTime(remind, now, zone) === null) {
    return Result.fail(`${where}: remind_at must be a delay like 2h, 3d or 1w, or a date like 2026-05-01 (09:00 in the host's time zone)`)
  }
  return Result.succeed({
    task_id: s.task_id,
    key: s.key,
    title: s.title,
    reason,
    actions: [...s.actions],
    remind_at: s.actions.includes("remind") ? (remind === "" ? DEFAULT_REMIND : remind) : null,
    message: s.actions.includes("message") ? message : null,
    outcome: null,
  })
}

/** The card's heading: the assistant's, trimmed and cut to `MAX_TITLE`, or `DEFAULT_TITLE`. */
export const cardTitle = (title: string | undefined): string => {
  const t = title?.trim() ?? ""
  return t === "" ? DEFAULT_TITLE : t.slice(0, MAX_TITLE)
}

/** What the card's notice says, for a client that doesn't draw the card (the phone app). */
export const cardText = (card: TaskSuggestions): string => {
  const n = card.suggestions.length
  const keys = card.suggestions.map((s) => s.key).join(", ")
  return `${card.title}: the assistant suggests what to do with ${n === 1 ? "1 task" : `${n} tasks`} (${keys}). Open the board to pick.`
}

/** Why a row can't take `choice`, if it can't: it's settled already, or the row doesn't offer it. */
export const refusal = (row: TaskSuggestion, choice: SuggestionChoice): { readonly closed: boolean; readonly reason: string } | null => {
  if (row.outcome !== null) return { closed: true, reason: `the suggestion for ${row.key} has been settled already` }
  if (choice !== "keep" && !row.actions.includes(choice)) return { closed: false, reason: `the suggestion for ${row.key} doesn't offer ${choice}` }
  return null
}

/** The card with row `index` settled as `outcome`. */
export const settled = (card: TaskSuggestions, index: number, outcome: SuggestionOutcome): TaskSuggestions => ({
  ...card,
  suggestions: card.suggestions.map((s, i) => (i === index ? { ...s, outcome } : s)),
})
