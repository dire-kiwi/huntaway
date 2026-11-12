// The assistant's Brief tab (6.7): the morning brief its routine writes (brief.html, one version a day), and beside it the
// day's items (from the run's brief.json, as the host checked them) with a thumbs up and down each, which go into MEMORY.md
// as preferences (`assistant.briefFeedback`). Without a brief yet, it sets up the routine (`assistant.addBrief`).
//
// The brief was written from mail, so its page has no say in the ratings: it's shown in a frame that runs no scripts and
// is sent nothing, and the ratings are the board's own buttons, outside it. A page that navigates its frame elsewhere gets
// nothing.
import { useAtomValue } from "@effect/atom-react"
import { automationsAtom, query, type HostTask as Task } from "@huntaway/client"
import { ProfileId, TaskId, type BriefItem, type BriefRating, type TaskDocument, type Weekday } from "@huntaway/contracts"
import { clsx } from "clsx"
import { Loader2, Newspaper, Play, ThumbsDown, ThumbsUp } from "lucide-react"
import { useMemo, useRef, useState } from "react"
import { exitError, useMutation } from "../../state/mutation"
import { WEEKDAYS } from "../settings/automations/draft"
import { localTime, timeUntil, triggerText } from "../settings/automations/text"
import { Button, localeDateString, localeString, parseJson, resultError, resultValue, toJson } from "../ui"

/** The routine the template makes is called this (the server's brief `NAME`). */
const BRIEF_NAME = "Morning brief"

type Rated = Record<string, "up" | "down">

/** A rated item's key: its kind and topic, as MEMORY.md keeps one line for each. */
const itemKey = (kind: string, topic: string) => `${kind}:${topic}`.toLowerCase()

const storeKey = (hostId: string, taskId: string) => `ia.briefRatings:${hostId}:${taskId}`

const isRating = (v: unknown): v is "up" | "down" => v === "up" || v === "down"

function loadRated(hostId: string, taskId: string): Rated {
  try {
    const v = parseJson(localStorage.getItem(storeKey(hostId, taskId)))
    if (!v || typeof v !== "object" || Array.isArray(v)) return {}
    return Object.fromEntries(Object.entries(v).filter((e): e is [string, "up" | "down"] => isRating(e[1])))
  } catch {
    return {}
  }
}

function saveRated(hostId: string, taskId: string, r: Rated) {
  try {
    localStorage.setItem(storeKey(hostId, taskId), toJson(r))
  } catch {
    // Storage full or unavailable: the ratings are in memory regardless.
  }
}

/** What the brief's frame takes out of its page: scripts and what could load or go elsewhere by itself. */
const DROP = "script, noscript, meta[http-equiv], base, iframe, frame, frameset, object, embed, portal, link, template"

/**
 * The brief as its frame shows it, which is defence in depth: the frame runs no scripts and has no part in the ratings
 * whatever the page says. The page is parsed (so a refresh written `ref&#114;esh`, or with a `>` in another attribute, is
 * found as the browser would find it) and what's in `DROP` goes, with every `on…` attribute; links open in a new tab.
 * Then a policy that lets nothing load from elsewhere (no tracking pixels from mail) goes first of all.
 */
export function briefDoc(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html")
  for (const el of Array.from(doc.querySelectorAll(DROP))) el.remove()
  for (const el of Array.from(doc.querySelectorAll("*"))) {
    for (const a of Array.from(el.attributes)) if (/^on|^formaction$/i.test(a.name)) el.removeAttribute(a.name)
    if (el.localName === "a" || el.localName === "area") {
      el.setAttribute("target", "_blank")
      el.setAttribute("rel", "noopener noreferrer")
    }
  }
  const csp = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'"
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank">${doc.documentElement.outerHTML}`
}

const KIND_LABEL: Record<string, string> = { calendar: "Calendar", mail: "Mail", drive: "Drive", board: "Board", other: "Other" }

const dayLabel = (iso: string) => localeDateString(iso, { weekday: "short", day: "numeric", month: "short" }, [])

export function BriefView({ assistant }: { assistant: Task }) {
  const { host_id: hostId, profile_id: profileId, id: taskId } = assistant
  const [picked, setPicked] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)
  // Read again as the assistant's documents change (its `document_at`, invalidate.ts).
  const read = useAtomValue(query("tasks.document", hostId, { id: TaskId.make(taskId), label: "brief", ...(picked === null ? {} : { version: picked }) }))
  const docErr = resultError(read)
  // The day shown before stays until another picked has been read.
  const value = resultValue(read)
  const [shown, setShown] = useState<TaskDocument | null>(null)
  if (value !== undefined && value !== shown) setShown(value)
  const doc: TaskDocument | null = value ?? (docErr === null ? shown : null)
  // The profile's routines, read again as they change (`automations_changed`).
  const routines = useAtomValue(automationsAtom({ host_id: hostId, profile_id: profileId }))
  const list = routines.data?.automations ?? null
  const tz = routines.data?.time_zone ?? null
  const routine = list?.find((a) => a.name === BRIEF_NAME) ?? null

  const [rated, setRated] = useState<Rated>(() => loadRated(hostId, taskId))
  const ratedRef = useRef(rated)
  const content = doc?.content ?? null
  const html = useMemo(() => (content === null ? null : briefDoc(content)), [content])
  const items = doc?.items ?? []
  // A rating, from the list beside the brief: kept here at once, and taken back if it isn't saved. Pressing a pressed one
  // takes it back.
  const [, feedback] = useMutation("assistant.briefFeedback")
  const rate = (item: BriefItem, pressed: "up" | "down") => {
    const key = itemKey(item.kind, item.topic)
    const before = ratedRef.current
    const rating: BriefRating = before[key] === pressed ? "clear" : pressed
    const next = { ...before }
    if (rating === "clear") delete next[key]
    else next[key] = rating
    ratedRef.current = next
    setRated(next)
    saveRated(hostId, taskId, next)
    void feedback(hostId, { profile_id: ProfileId.make(profileId), rating, kind: item.kind, topic: item.topic, text: item.title }).then((exit) => {
      const failed = exitError(exit)
      setErr(failed === null ? null : `That rating wasn't saved: ${failed}`)
      if (failed === null) return
      ratedRef.current = before
      setRated(before)
      saveRated(hostId, taskId, before)
    })
  }

  const versions = doc?.versions ?? []
  const latest = versions[versions.length - 1]
  const [run, runRoutine] = useMutation("automations.run")
  const running = run.busy
  const runNow = () => {
    if (!routine) return
    void runRoutine(hostId, { id: routine.id }).then((exit) => setErr(exitError(exit)))
  }
  const working = routine?.last_run?.task?.running === true
  const shownErr = err ?? docErr ?? routines.failed

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="brief">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3 text-[12px]">
        <span className="flex items-center gap-1.5 text-muted narrow:hidden">
          <Newspaper size={12} /> Brief
        </span>
        {versions.length > 0 && (
          <select
            className="h-6 rounded border border-line bg-panel px-1 text-[12px] text-fg outline-none"
            title="One for each day it was written"
            aria-label="Day"
            value={doc?.version ?? ""}
            onChange={(e) => {
              const v = Number(e.target.value)
              setPicked(v === latest?.version ? null : v)
            }}
          >
            {versions.toReversed().map((v) => (
              <option key={v.version} value={v.version}>
                {dayLabel(v.created_at)}
                {v.version === latest?.version ? " (latest)" : ""}
              </option>
            ))}
          </select>
        )}
        {working && (
          <span className="flex items-center gap-1.5 text-muted">
            <Loader2 size={12} className="animate-spin" /> Writing today's…
          </span>
        )}
        {routine && (
          <span className="ml-auto flex min-w-0 items-center gap-2 text-faint">
            <span className="truncate" title={routine.enabled && routine.next_run_at ? localeString(routine.next_run_at) : undefined}>
              {routine.enabled
                ? routine.next_run_at
                  ? `Next ${timeUntil(routine.next_run_at)} (${localTime(routine.next_run_at)})`
                  : triggerText(routine.trigger, tz)
                : "Paused"}
            </span>
            <Button size="sm" variant="ghost" disabled={running || working} onClick={runNow} title="Write today's brief now">
              {running ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} Run now
            </Button>
          </span>
        )}
      </div>
      {shownErr && <div className="shrink-0 bg-red-500/10 px-3 py-1.5 text-[12px] text-red-300">{shownErr}</div>}
      <div className="relative min-h-0 flex-1">
        {doc === null && !docErr ? (
          <div className="flex h-full items-center justify-center text-muted">
            <Loader2 size={16} className="animate-spin" />
          </div>
        ) : html ? (
          <div className="flex h-full min-h-0 narrow:flex-col">
            {/* No scripts (no allow-scripts) and nothing sent to it: links open in a new tab, and that's all it can do. */}
            <iframe
              title="Morning brief"
              srcDoc={html}
              sandbox="allow-popups allow-popups-to-escape-sandbox"
              referrerPolicy="no-referrer"
              className="block h-full min-w-0 flex-1 bg-white narrow:h-auto narrow:min-h-0"
            />
            <aside
              className="w-[300px] shrink-0 overflow-y-auto border-l border-line bg-panel/40 narrow:max-h-[40%] narrow:w-full narrow:border-t narrow:border-l-0"
              aria-label="Rate the brief's items"
              data-testid="brief-items"
            >
              <div className="border-b border-line/70 px-3 py-2 text-[12px] text-muted">
                Rate its items: 👍 more like this, 👎 less. Each rating is a line in your assistant's memory, by the topic shown.
              </div>
              {items.length === 0 && <div className="px-3 py-3 text-[12px] text-faint">This brief has no items to rate.</div>}
              <ul className="divide-y divide-line/60">
                {items.map((it) => {
                  const r = rated[itemKey(it.kind, it.topic)]
                  return (
                    <li key={`${it.kind}:${it.topic}:${it.title}`} className="flex items-start gap-2 px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-[12.5px] break-words text-fg">{it.title}</div>
                        <div className="text-[11.5px] text-faint">
                          {KIND_LABEL[it.kind] ?? it.kind} · {it.topic}
                        </div>
                      </div>
                      {(["up", "down"] as const).map((v) => (
                        <button
                          key={v}
                          type="button"
                          aria-pressed={r === v}
                          aria-label={`${v === "up" ? "More" : "Less"} like this: ${it.topic}`}
                          title={`${v === "up" ? "More" : "Less"} like this: ${it.topic}`}
                          onClick={() => rate(it, v)}
                          className={clsx(
                            "flex h-6 w-6 shrink-0 items-center justify-center rounded",
                            r === v
                              ? v === "up"
                                ? "bg-emerald-500/20 text-emerald-300"
                                : "bg-red-500/20 text-red-300"
                              : "text-faint hover:bg-raised hover:text-fg",
                          )}
                        >
                          {v === "up" ? <ThumbsUp size={13} /> : <ThumbsDown size={13} />}
                        </button>
                      ))}
                    </li>
                  )
                })}
              </ul>
            </aside>
          </div>
        ) : (
          <div className="h-full overflow-y-auto">
            <div className="mx-auto max-w-xl p-8">
              {list === null ? null : routine ? (
                <div className="rounded-xl border border-dashed border-line p-6 text-center text-[13px] text-muted">
                  No brief yet. {routine.name} runs {triggerText(routine.trigger, tz).replace(/^At/, "at")}: press Run now for one today.
                </div>
              ) : (
                <BriefSetup hostId={hostId} profileId={profileId} />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** The template: the morning brief on the weekdays and at the time picked. It shows once the routine's event comes. */
function BriefSetup({ hostId, profileId }: { hostId: string; profileId: string }) {
  const [time, setTime] = useState("07:30")
  const [days, setDays] = useState<Weekday[]>(["mon", "tue", "wed", "thu", "fri"])
  const [{ busy, error: err }, addBrief] = useMutation("assistant.addBrief")
  const add = () => void addBrief(hostId, { profile_id: ProfileId.make(profileId), time, weekdays: days })
  return (
    <div className="space-y-3 rounded-xl border border-line p-5 text-[13px]" data-testid="brief-setup">
      <div className="text-fg">A morning brief</div>
      <p className="text-muted">
        Each morning your assistant reads today's calendar, unread and starred mail, Drive files changed lately and what's waiting for you on the board, writes
        a brief here, and sends you a short summary. Rate its items with 👍 and 👎, and later briefs follow your ratings. It needs Google (Settings → Assistant)
        for mail, calendar and Drive; it only reads and drafts.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-muted">
          At
          <input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className="h-7 rounded-md border border-line bg-panel px-1.5 text-[12.5px] text-fg outline-none"
            aria-label="Time"
          />
        </label>
        <div className="flex items-center gap-1" role="group" aria-label="Days">
          {WEEKDAYS.map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={days.includes(d)}
              onClick={() => setDays(days.includes(d) ? days.filter((x) => x !== d) : WEEKDAYS.filter((x) => x === d || days.includes(x)))}
              className={clsx(
                "h-7 rounded-md border px-2 text-[12px] capitalize",
                days.includes(d) ? "border-accent/60 bg-accent/15 text-fg" : "border-line text-muted hover:text-fg",
              )}
            >
              {d}
            </button>
          ))}
        </div>
      </div>
      <Button size="sm" variant="primary" disabled={busy || !time || days.length === 0} onClick={add}>
        {busy && <Loader2 size={12} className="animate-spin" />} Add the morning brief
      </Button>
      {err && <div className="text-[12px] text-red-400">{err}</div>}
    </div>
  )
}
