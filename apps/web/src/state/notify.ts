import { DateTime, Option, Schema } from "effect"
import { NOTIFY_EVENTS, readyToCheck, type HostTask, type NotifyEvent } from "@huntaway/client"
import type { Status } from "@huntaway/contracts"

// Which changes notify, the settings for it, and the user's own moves (docs/plan/09-frontend.md, state/notify.ts): the
// old notifications.ts and the client's `movedHere`, apart from how a browser shows them
// (components/layout/notifier.ts), so push to a device can use the same triggers and settings. Kept in this browser's
// storage under the old keys, read each time (another tab may have changed them).

/** Off, system notifications, a sound, or both. */
export type NotifyMode = "off" | "notify" | "sound" | "both"

export const NOTIFY_MODES: ReadonlyArray<{ readonly id: NotifyMode; readonly label: string }> = [
  { id: "off", label: "Off" },
  { id: "notify", label: "Notifications" },
  { id: "sound", label: "Sound" },
  { id: "both", label: "Both" },
]

export const showsNotifications = (m: NotifyMode): boolean => m === "notify" || m === "both"
export const playsSound = (m: NotifyMode): boolean => m === "sound" || m === "both"

export interface NotifySettings {
  readonly mode: NotifyMode
  /** Which events notify. */
  readonly events: Readonly<Record<NotifyEvent, boolean>>
  /** The number of tasks that need attention in the tab title and icon, and on the desktop app's badge. */
  readonly count: boolean
}

export const DEFAULT_NOTIFY: NotifySettings = { mode: "off", events: { attention: true, review: true, merge: false, done: false }, count: true }

const KEY = "ia.notifications"

/** What a stored value may hold: each field read on its own, one that doesn't read being the default. */
const Stored = Schema.Struct({
  mode: Schema.optional(Schema.Unknown),
  events: Schema.optional(Schema.Unknown),
  count: Schema.optional(Schema.Unknown),
})
const decodeStored = Schema.decodeUnknownOption(Schema.fromJsonString(Stored))
const isMode = Schema.is(Schema.Literals(["off", "notify", "sound", "both"]))
const isEvents = Schema.is(Schema.Record(Schema.String, Schema.Unknown))
const encodeSettings = Schema.encodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      mode: Schema.String,
      events: Schema.Struct({ attention: Schema.Boolean, review: Schema.Boolean, merge: Schema.Boolean, done: Schema.Boolean }),
      count: Schema.Boolean,
    }),
  ),
)

/** The settings when this browser has no storage, for this page only. */
const unsaved: { raw: string | null } = { raw: null }

function readSaved(): string | null {
  try {
    return window.localStorage.getItem(KEY)
  } catch {
    return unsaved.raw
  }
}

function parseSettings(raw: string | null): NotifySettings {
  const saved = Option.getOrUndefined(decodeStored(raw ?? "{}"))
  if (saved === undefined) return DEFAULT_NOTIFY
  const events = isEvents(saved.events) ? saved.events : {}
  const flag = (e: NotifyEvent) => {
    const v = events[e]
    return typeof v === "boolean" ? v : DEFAULT_NOTIFY.events[e]
  }
  return {
    mode: isMode(saved.mode) ? saved.mode : DEFAULT_NOTIFY.mode,
    events: { attention: flag("attention"), review: flag("review"), merge: flag("merge"), done: flag("done") },
    count: typeof saved.count === "boolean" ? saved.count : DEFAULT_NOTIFY.count,
  }
}

const cache: { current: { readonly raw: string | null; readonly settings: NotifySettings } | null } = { current: null }

/** The settings saved in this browser, with the defaults for the rest: the same object while they don't change. */
export function notifySettings(): NotifySettings {
  const raw = readSaved()
  if (cache.current?.raw !== raw) cache.current = { raw, settings: parseSettings(raw) }
  return cache.current.settings
}

const listeners = new Set<() => void>()

export function saveNotifySettings(s: NotifySettings): void {
  const raw = Option.getOrNull(encodeSettings(s))
  if (raw === null) return
  try {
    window.localStorage.setItem(KEY, raw)
  } catch {
    unsaved.raw = raw
  }
  for (const l of listeners) l()
}

/** Calls `cb` when the settings change, in this tab or another one. */
export function onNotifySettings(cb: () => void): () => void {
  const storage = (e: StorageEvent) => {
    if (e.key === KEY) cb()
  }
  listeners.add(cb)
  window.addEventListener("storage", storage)
  return () => {
    listeners.delete(cb)
    window.removeEventListener("storage", storage)
  }
}

// ---------- which changes notify ----------

/** What the server says when the user stopped the run: their own doing, so it doesn't notify. */
const STOPPED = "Stopped by user"

type Seen = Pick<HostTask, "kind" | "status" | "running" | "review" | "attention_reason">

/** What a change of task `prev` to `next` notifies of, if anything. */
export function taskEvent(prev: Seen, next: Seen): NotifyEvent | null {
  if (next.kind !== "task") return null
  if (next.status === "needs_attention" && prev.status !== "needs_attention") return next.attention_reason === STOPPED ? null : "attention"
  if (readyToCheck(next) && !readyToCheck(prev)) return "review"
  if (next.status === "ready_for_merge" && prev.status !== "ready_for_merge") return "merge"
  if (next.status === "done" && prev.status !== "done") return "done"
  return null
}

/** The column an event is about: a task the user moved there themselves doesn't notify (see `movedHere`). */
export const EVENT_STATUS: Readonly<Record<NotifyEvent, Status>> = { attention: "needs_attention", review: "in_review", merge: "ready_for_merge", done: "done" }

/** Whether task `t` is still as event `e` said, so its notification still applies. */
export const stillApplies = (e: NotifyEvent, t: Seen): boolean => (e === "review" ? readyToCheck(t) : t.status === EVENT_STATUS[e])

const RESOLUTIONS: Readonly<Record<string, string>> = { done: "Done", not_done: "Closed: not done", wont_fix: "Closed: won't fix" }

/** A notification's title and text: the task's key and title, and what happened. */
export function notificationText(
  e: NotifyEvent,
  t: Pick<HostTask, "key" | "title" | "attention_reason" | "review" | "resolution">,
): { readonly title: string; readonly body: string } {
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
          : (RESOLUTIONS[t.resolution ?? "done"] ?? "Done")
  return { title: `${t.key} ${t.title}`, body: body.length > 200 ? `${body.slice(0, 199)}…` : body }
}

/** How many tasks need attention. */
export function attentionCount(tasks: Iterable<Pick<HostTask, "kind" | "status">>): number {
  let n = 0
  for (const t of tasks) if (t.kind === "task" && t.status === "needs_attention") n++
  return n
}

/**
 * How long a task that's ready to review has to stay so before it notifies. A review starts a moment after the run
 * ends (it reads the worktree first), and a run can carry on straight away, so either would make a false alarm.
 */
export const REVIEW_GRACE_MS = 5_000

export { NOTIFY_EVENTS }

// ---------- the user's own moves ----------

const MOVES_KEY = "ia.movedHere"
/** How long a move made in this browser keeps its notification away. */
const MOVE_MS = 15_000

const Moves = Schema.Record(Schema.String, Schema.Struct({ status: Schema.String, at: Schema.Finite }))
type Moves = typeof Moves.Type
const decodeMoves = Schema.decodeUnknownOption(Schema.fromJsonString(Moves))
const encodeMoves = Schema.encodeUnknownOption(Schema.fromJsonString(Moves))

const now = () => DateTime.toEpochMillis(DateTime.nowUnsafe())

function readMoves(): Moves {
  try {
    return Option.getOrElse(decodeMoves(window.localStorage.getItem(MOVES_KEY) ?? "{}"), () => ({}))
  } catch {
    return {}
  }
}

/**
 * Notes that this browser moved task `id` on host `host` to `status`: before the request, as the task's event reaches
 * every tab before the answer does. Kept for every tab of the browser.
 */
export function noteMove(host: string, id: string, status: Status): void {
  const t = now()
  const moves = Object.fromEntries(Object.entries(readMoves()).filter(([, m]) => t - m.at < MOVE_MS))
  moves[`${host}:${id}`] = { status, at: t }
  const raw = Option.getOrNull(encodeMoves(moves))
  try {
    if (raw !== null) window.localStorage.setItem(MOVES_KEY, raw)
  } catch {
    // Then it may notify of the move.
  }
}

/** Whether a tab of this browser moved task `id` on host `host` to `status` in the last few seconds: nobody needs telling of their own moves. */
export function movedHere(host: string, id: string, status: Status): boolean {
  const m = readMoves()[`${host}:${id}`]
  return m !== undefined && m.status === status && now() - m.at < MOVE_MS
}
