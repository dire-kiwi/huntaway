// The "Show outgoing mail and events as drafts" experiment (Settings → Experiments, docs/plan/09-frontend.md): the
// tools a person reads as a message, and what their input says, for the prompt card to draw as that message. The names
// and arguments are workspace-mcp's (2.3.0, the assistant's Google server): `send_gmail_message` and
// `draft_gmail_message` (to, cc, bcc, subject, body, body_format "plain" or "html", thread_id, forward_message_id,
// attachments…), and `manage_event` (action "create" or "update", summary, start_time, end_time, timezone,
// start_timezone, end_timezone, attendees, location, description, event_id, add_google_meet, recurrence…). Anything
// else, or an input that doesn't read as one, is null: the card is the usual one. Pure, so it's tested without a page.

import { DateTime, Option } from "effect"
import { fieldsOf, listOf, stringOf, type Fields } from "./fields"

/** A mail as the agent would send it (or save as a draft). */
export interface MailDraft {
  readonly type: "mail"
  /** `draft_gmail_message`: it's saved as a draft, not sent. */
  readonly draft: boolean
  readonly to: string
  readonly cc: string
  readonly bcc: string
  readonly subject: string
  readonly body: string
  readonly html: boolean
  /** A reply in this thread. */
  readonly thread: string | undefined
  /** A forward of this message (the body is a note above it). */
  readonly forward: string | undefined
  /** Its attachments' names (or where they're from). */
  readonly attachments: ReadonlyArray<string>
}

/** A calendar event as the agent would make it, or what it would change of one. */
export interface EventDraft {
  readonly type: "event"
  readonly action: "create" | "update"
  readonly title: string
  readonly start: string
  readonly end: string
  /** The time zone it's given in (or each end's, when they differ). */
  readonly zone: string
  readonly attendees: ReadonlyArray<string>
  readonly location: string
  readonly description: string
  readonly meet: boolean
  readonly recurrence: ReadonlyArray<string>
  /** An update's event. */
  readonly event: string | undefined
  /** An update: what it changes, by name ("the title", "the time"…), in the card's order. */
  readonly changes: ReadonlyArray<string>
}

export type Draft = MailDraft | EventDraft

const MAIL_TOOLS = new Set(["send_gmail_message", "draft_gmail_message"])
const EVENT_TOOLS = new Set(["manage_event", "create_event", "modify_event", "update_event"])

/** A tool's own name, without its MCP server's `mcp__<server>__`. */
const bare = (tool: string): string => {
  const m = /^mcp__.+?__(.+)$/.exec(tool)
  return m?.[1] ?? tool
}

/** Codex asks for an MCP tool with its arguments beside its question (`{message, arguments}`): the arguments. */
export const toolArgs = (input: unknown): Fields => {
  const f = fieldsOf(input)
  return typeof f.message === "string" && "arguments" in f ? fieldsOf(f.arguments) : f
}

const text = (x: unknown): string => (stringOf(x) ?? "").trim()

/** Attendees as workspace-mcp takes them: addresses, objects with `email`, or a mix. */
const people = (x: unknown): ReadonlyArray<string> =>
  (typeof x === "string" ? x.split(",") : listOf(x).map((a) => (typeof a === "string" ? a : (stringOf(fieldsOf(a).email) ?? ""))))
    .map((a) => a.trim())
    .filter(Boolean)

const attachmentName = (a: unknown): string => {
  if (typeof a === "string") return a
  const f = fieldsOf(a)
  return text(f.filename) || text(f.path).split("/").pop() || text(f.url) || "an attachment"
}

/** What an event update changes, named as the card names them. */
const CHANGES: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  ["the title", ["summary"]],
  ["the time", ["start_time", "end_time"]],
  ["the time zone", ["timezone", "start_timezone", "end_timezone"]],
  ["the attendees", ["attendees"]],
  ["the place", ["location"]],
  ["the description", ["description"]],
  ["the video call", ["add_google_meet", "conference_data", "conference_provider", "conference_uri"]],
  ["how it repeats", ["recurrence"]],
  ["the reminders", ["reminders", "use_default_reminders"]],
  ["the attachments", ["attachments"]],
  ["whether it shows as busy", ["transparency"]],
  ["who can see it", ["visibility"]],
  ["its colour", ["color_id"]],
  ["what guests can do", ["guests_can_modify", "guests_can_invite_others", "guests_can_see_other_guests"]],
]

/** The draft a prompt for `tool` with `input` is, if it's one. */
export function draftOf(tool: string, input: unknown): Draft | null {
  const name = bare(tool)
  const a = toolArgs(input)
  if (MAIL_TOOLS.has(name)) {
    const forward = text(a.forward_message_id) || undefined
    const thread = text(a.thread_id) || undefined
    const to = text(a.to)
    // A mail with nobody to send it to, nothing to say and nothing it replies to or forwards isn't one to show.
    if (!to && !text(a.subject) && !text(a.body) && !forward && !thread) return null
    return {
      type: "mail",
      draft: name === "draft_gmail_message",
      to,
      cc: text(a.cc),
      bcc: text(a.bcc),
      subject: stringOf(a.subject) ?? "",
      body: stringOf(a.body) ?? "",
      html: a.body_format === "html",
      thread,
      forward,
      attachments: listOf(a.attachments).map(attachmentName),
    }
  }
  if (EVENT_TOOLS.has(name)) {
    const given = text(a.action).toLowerCase()
    const action = name === "manage_event" ? given : name === "create_event" ? "create" : "update"
    if (action !== "create" && action !== "update") return null
    const has = (k: string) => a[k] !== undefined && a[k] !== null
    const changes = action === "update" ? CHANGES.filter(([, keys]) => keys.some(has)).map(([label]) => label) : []
    const zones = [text(a.start_timezone) || text(a.timezone), text(a.end_timezone) || text(a.timezone)]
    const zone = zones[0] === zones[1] ? (zones[0] ?? "") : zones.filter(Boolean).join(" → ")
    const event: EventDraft = {
      type: "event",
      action,
      title: text(a.summary),
      start: text(a.start_time),
      end: text(a.end_time),
      zone,
      attendees: people(a.attendees),
      location: text(a.location),
      description: stringOf(a.description) ?? "",
      meet: a.add_google_meet === true,
      recurrence: listOf(a.recurrence).flatMap((r) => (typeof r === "string" && r ? [r] : [])),
      event: text(a.event_id) || undefined,
      changes,
    }
    if (action === "create" && !event.title && !event.start) return null
    return event
  }
  return null
}

// ---------- times ----------

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

interface Moment {
  readonly day: string
  readonly time: string | null
  readonly offset: string | null
}

/** An RFC 3339 time (or a date) as it's written, on its own clock: not moved to the viewer's. */
function moment(s: string): Moment | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(s)
  if (!m) return null
  const [, y, mo, d, h, mi, off] = m
  const date = Option.getOrNull(DateTime.make({ year: Number(y), month: Number(mo), day: Number(d) }))
  if (date === null) return null
  const parts = DateTime.toPartsUtc(date)
  const day = `${WEEKDAYS[parts.weekDay]} ${parts.day} ${MONTHS[parts.month - 1]} ${parts.year}`
  const offset = off === undefined ? null : off === "Z" ? "UTC" : `UTC${off.length === 5 ? `${off.slice(0, 3)}:${off.slice(3)}` : off}`
  return { day, time: h === undefined ? null : `${h}:${mi}`, offset }
}

/**
 * When an event is, as its own clock and zone say: "Mon 16 Nov 2026, 14:00 – 15:00 (Pacific/Auckland)", an all-day
 * event's days, or the times as given if they don't read.
 */
export function eventWhen(e: Pick<EventDraft, "start" | "end" | "zone">): string {
  if (!e.start && !e.end) return ""
  const s = moment(e.start)
  const t = moment(e.end)
  if ((e.start && !s) || (e.end && !t)) return [e.start, e.end].filter(Boolean).join(" – ") + (e.zone ? ` (${e.zone})` : "")
  const zone = e.zone || (s?.offset ?? t?.offset ?? "")
  const z = zone ? ` (${zone})` : ""
  if (s && t && s.time === null && t.time === null) {
    // All day: the end date is exclusive.
    return s.day === t.day ? `${s.day}, all day` : `${s.day} – ${t.day} (all day, to the end before)`
  }
  if (s && t) return s.day === t.day ? `${s.day}, ${s.time ?? ""} – ${t.time ?? ""}${z}` : `${s.day}, ${s.time ?? ""} – ${t.day}, ${t.time ?? ""}${z}`
  const one = s ?? t
  return one ? `${s ? "From" : "Until"} ${one.day}${one.time ? `, ${one.time}` : ""}${z}` : ""
}

// ---------- editing ----------

/** What of a mail the card edits. */
export interface MailEdit {
  readonly to: string
  readonly cc: string
  readonly bcc: string
  readonly subject: string
  readonly body: string
}

export const mailEdit = (m: MailDraft): MailEdit => ({ to: m.to, cc: m.cc, bcc: m.bcc, subject: m.subject, body: m.body })

/**
 * The input the tool runs with once mail `was` (which it asked with `input`) is edited to `edit`: its own, with the
 * fields edited (an address emptied left out). Null when nothing changed.
 */
export function editedInput(input: unknown, was: MailDraft, edit: MailEdit): Record<string, unknown> | null {
  const before = mailEdit(was)
  const keys = ["to", "cc", "bcc", "subject", "body"] as const
  if (keys.every((k) => edit[k] === before[k])) return null
  const next: Record<string, unknown> = { ...fieldsOf(input) }
  for (const k of keys) {
    if (edit[k] === before[k]) continue
    if (edit[k] === "" && k !== "body" && k !== "subject") delete next[k]
    else next[k] = edit[k]
  }
  return next
}

// ---------- HTML ----------

/**
 * What a mail's HTML body may load in its frame: its own inline styles, and images and fonts in data: URLs. No scripts
 * (the frame has none, as a document's has none it didn't bring), no remote images (which would tell their sender the
 * mail was read), no frames, forms or base. Before anything of the mail's.
 */
export const MAIL_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ")

/** A mail's HTML body as its frame's document: the policy first, then the mail on a white page, links in a new tab. */
export const mailFrameDoc = (html: string): string =>
  `<!doctype html><meta http-equiv="Content-Security-Policy" content="${MAIL_CSP}"><base target="_blank"><style>html{background:#fff;color:#202124;font:14px/1.5 system-ui,sans-serif}body{margin:12px}</style>\n${html}`
