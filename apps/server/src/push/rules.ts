import type { PushEvents, PushEventsPatch, Status, Task } from "@huntaway/contracts"
import { EXIT_PLAN, isQuestion, shownKind } from "../permissions/prompts.ts"

// What notifies, and what it says (the old push/events.ts and push/subscriptions.ts, which mirror the web client's
// notifications.ts): plain functions, tested without a layer.

/** What a device can be pushed: the board's four (`NOTIFY_EVENTS`), a permission prompt, an assistant's reply, a routine's report. */
export type PushEvent = "attention" | "review" | "merge" | "done" | "prompt" | "reply" | "report"

/** A new subscription's events. */
export const DEFAULT_EVENTS: PushEvents = { attention: true, review: true, merge: false, done: false, prompts: "assistant", replies: false, reports: true }

/**
 * What a stored value leaves out reads as: as a new one's, but no reports (a device subscribed before it could choose
 * them isn't suddenly sent them).
 */
export const MISSING_EVENTS: PushEvents = { attention: true, review: true, merge: false, done: false, prompts: "assistant", replies: false, reports: false }

/** Events `patch` over `old`: what it leaves out stays as it was (a page from before an event was added sends the others without it). */
export const mergedEvents = (old: PushEvents, patch: PushEventsPatch): PushEvents => ({
  attention: patch.attention ?? old.attention,
  review: patch.review ?? old.review,
  merge: patch.merge ?? old.merge,
  done: patch.done ?? old.done,
  prompts: patch.prompts ?? old.prompts,
  replies: patch.replies ?? old.replies,
  reports: patch.reports ?? old.reports,
})

/** The column an event is about, where a move the user made doesn't notify. None for a reply or a report. */
export const eventStatus = (e: PushEvent): Status | null =>
  e === "attention" || e === "prompt" ? "needs_attention" : e === "review" ? "in_review" : e === "merge" ? "ready_for_merge" : e === "done" ? "done" : null

/** What the server says when the user stopped the run: their own doing, so it doesn't notify. */
export const STOPPED = "Stopped by user"

/** In review, with its agent stopped and its review passed or none (`readyToCheck`). */
export const readyToCheck = (t: Pick<Task, "status" | "running" | "review">): boolean =>
  t.status === "in_review" && !t.running && (t.review === null || t.review.state === "passed")

type Seen = Pick<Task, "kind" | "status" | "running" | "review" | "attention_reason">

/** What a change of task `prev` to `next` notifies of, if anything (`taskEvent`). Only tasks: not review threads. */
export const taskEvent = (prev: Seen, next: Seen): Exclude<PushEvent, "prompt" | "reply" | "report"> | null => {
  if (next.kind !== "task") return null
  if (next.status === "needs_attention" && prev.status !== "needs_attention") return next.attention_reason !== STOPPED ? "attention" : null
  if (readyToCheck(next) && !readyToCheck(prev)) return "review"
  if (next.status === "ready_for_merge" && prev.status !== "ready_for_merge") return "merge"
  if (next.status === "done" && prev.status !== "done") return "done"
  return null
}

/** Whether a device with `events` wants event `e` (a prompt depends on the task: `wantsPrompt`). */
export const wants = (events: PushEvents, e: PushEvent): boolean =>
  e === "reply" ? events.replies : e === "report" ? events.reports : e === "prompt" ? false : events[e]

/** Whether task `t` is a profile's assistant's: its thread, or one of its routines' runs. */
const isAssistants = (t: Pick<Task, "kind" | "task_type">): boolean => t.kind === "task" && (t.task_type === "assistant" || t.task_type === "routine")

/** Whether a device with `events` wants task `t`'s permission prompts. */
export const wantsPrompt = (events: PushEvents, t: Pick<Task, "kind" | "task_type">): boolean =>
  events.prompts === "assistant" ? isAssistants(t) : events.prompts === "all" ? t.kind === "task" : false

/** `text` cut to 200 characters, the last an ellipsis. */
const cut = (text: string): string => {
  const chars = Array.from(text)
  return chars.length > 200 ? `${chars.slice(0, 199).join("")}…` : text
}

/** A notification's title and text: the task's key and title, and what happened (`notificationText`). */
export const notificationText = (
  e: PushEvent,
  t: Pick<Task, "key" | "title" | "attention_reason" | "review" | "resolution">,
): { readonly title: string; readonly body: string } => {
  const body =
    e === "attention"
      ? t.attention_reason
        ? `Needs attention: ${t.attention_reason}`
        : "Needs attention"
      : e === "review"
        ? t.review?.state === "passed"
          ? "Ready to review: its review passed"
          : "Ready to review"
        : e === "merge"
          ? "Ready for merge"
          : e === "reply"
            ? "Replied"
            : e === "report"
              ? "Posted a report"
              : e === "prompt"
                ? "Waiting for your answer"
                : t.resolution === "not_done"
                  ? "Closed: not done"
                  : t.resolution === "wont_fix"
                    ? "Closed: won't fix"
                    : "Done"
  return { title: `${t.key} ${t.title}`, body: cut(body) }
}

/**
 * What a prompt's notification says it asks: not what the tool would do, since pushes pass through push services and
 * carry no tool's input.
 */
export const promptText = (prompt: { readonly kind: string; readonly tool_name: string; readonly input: unknown }): string => {
  switch (shownKind(prompt.kind, prompt.input)) {
    case "project":
      return "Approve a project change?"
    case "delete_task":
      return "Delete a task?"
    case "automation":
      return "Approve an automation?"
    case "workflow":
      return "Approve a workflow?"
  }
  if (isQuestion(prompt.tool_name)) return "The agent has questions for you"
  if (prompt.tool_name === EXIT_PLAN) return "Plan ready for approval"
  return `Approve ${prompt.tool_name || "a tool"}?`
}

/**
 * What a routine's report notification says: its routine, and the report's first line (or why it failed). Nothing for
 * one waiting on the user, which its attention notifies of.
 */
export const reportText = (report: {
  readonly automation: string
  readonly outcome: string
  readonly text: string
}): { readonly title: string; readonly body: string } | null => {
  const first =
    report.text
      .split("\n")
      .map((l) => l.trim().replace(/^[#*\- ]+/, ""))
      .find((l) => l !== "") ?? ""
  const body = report.outcome === "reported" ? (first !== "" ? first : "Posted a report") : report.outcome === "failed" ? `Failed: ${first}` : null
  if (body === null) return null
  return { title: report.automation !== "" ? report.automation : "A routine", body: cut(body) }
}

/** A push service's endpoint: HTTPS, or plain HTTP to this machine only (for tests). Why not, or null. */
export const endpointProblem = (endpoint: string): string | null => {
  const url = URL.parse(endpoint)
  if (url === null) return "endpoint must be a URL"
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  return url.protocol === "https:" || (url.protocol === "http:" && local) ? null : "endpoint must be an https: URL"
}
