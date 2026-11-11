import { Option, Schema } from "effect"
import { boardAtom, onLiveTaskChange, readyToCheck, type HostTask, type NotifyEvent } from "@huntaway/client"
import { parse } from "../../router"
import { isOpenBoard } from "../../state/auth"
import { board } from "../../state/board"
import {
  attentionCount,
  EVENT_STATUS,
  movedHere,
  notificationText,
  notifySettings,
  onNotifySettings,
  playsSound,
  REVIEW_GRACE_MS,
  showsNotifications,
  stillApplies,
  taskEvent,
} from "../../state/notify"
import { registry } from "../../state/registry"
import { onNavigate, openTask } from "../../state/route"

// Tells the user of task changes on the boards the page shows (state/notify.ts says which): with system notifications
// and a sound, from one tab of the browser, and keeps the count of tasks that need attention in the tab's title, its
// icon and the desktop app's badge (the old notifier.ts). Notifications fire for live changes only (the client's
// `onLiveTaskChange`), never for what a snapshot or a reconnect brings.

/** What the desktop app adds (its preload): every member optional, as older apps lack some. */
interface Desktop {
  readonly setBadgeCount?: (n: number) => void
  readonly focus?: () => void
}
const desktop = (): Desktop | null => {
  const bridge: unknown = Reflect.get(window, "huntawayDesktop")
  if (typeof bridge !== "object" || bridge === null) return null
  const call =
    (name: string) =>
    (...args: ReadonlyArray<unknown>) => {
      const f: unknown = Reflect.get(bridge, name)
      if (typeof f === "function") Reflect.apply(f, bridge, args)
    }
  return { setBadgeCount: call("setBadgeCount"), focus: call("focus") }
}
/** Whether the page is in the desktop app, which notifies by itself and has no push service. */
export const inDesktopApp = (): boolean => desktop() !== null

/** Why system notifications can or can't be shown here. */
export type NotifyPermission = NotificationPermission | "insecure" | "unsupported" | "preview"

export function notifyPermission(): NotifyPermission {
  // A PR preview's agents and demo tasks would notify alongside the user's own board, from a board they're only trying.
  if (isOpenBoard()) return "preview"
  // Browsers only offer them to secure pages: HTTPS, and localhost.
  if (!window.isSecureContext) return "insecure"
  if (typeof Notification === "undefined") return "unsupported"
  return Notification.permission
}

/** This tab, for what tabs share. */
const tab = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("")

/** What tabs share in the browser's storage: the notifying tab's heartbeat, and the task open in the focused tab. */
const Leader = Schema.Struct({ tab: Schema.String, at: Schema.Finite })
const Focus = Schema.Struct({ tab: Schema.String, task: Schema.NullOr(Schema.String) })

/** Reads `key` as `schema` has it (another tab wrote it); null if it isn't there or doesn't read. */
function read<S extends Schema.Codec<unknown, unknown>>(key: string, schema: S): S["Type"] | null {
  try {
    const raw = window.localStorage.getItem(key)
    return raw === null ? null : Option.getOrNull(Schema.decodeOption(Schema.fromJsonString(schema))(raw))
  } catch {
    return null
  }
}
function write<S extends Schema.Codec<unknown, unknown>>(key: string, schema: S, value: S["Type"]): void {
  const raw = Option.getOrNull(Schema.encodeUnknownOption(Schema.fromJsonString(schema))(value))
  if (typeof raw === "string") window.localStorage.setItem(key, raw)
}

/** Whether this tab is the one that notifies, of all of the browser's tabs (and windows) on this board. */
const leader: { leading: () => boolean } = { leading: () => false }

/** The first tab to ask holds the lock for as long as it's open; then the next one in line has it. */
function lead(): void {
  const locks: unknown = Reflect.get(navigator, "locks")
  if (locks !== undefined && locks !== null) {
    const held = { now: false }
    leader.leading = () => held.now
    // Held until the page goes: the promise it's given never settles.
    const forever = Promise.withResolvers<void>().promise
    navigator.locks
      .request("ia.notifications", () => {
        held.now = true
        return forever
      })
      .catch(() => {})
    return
  }
  // Pages that aren't secure have no locks (or notifications, but the sound still plays once): the tab that last took
  // a heartbeat over that had gone stale, or kept its own fresh. Background tabs' timers are slowed down, so it's checked
  // again before notifying.
  const KEY = "ia.notifyLeader"
  const beat = () => {
    try {
      const cur = read(KEY, Leader)
      if (!cur || cur.tab === tab || Date.now() - cur.at > 6_000) write(KEY, Leader, { tab, at: Date.now() })
      return read(KEY, Leader)?.tab === tab
    } catch {
      return true
    }
  }
  leader.leading = beat
  beat()
  setInterval(beat, 2_000)
  window.addEventListener("pagehide", () => {
    try {
      if (read(KEY, Leader)?.tab === tab) window.localStorage.removeItem(KEY)
    } catch {
      // It goes stale.
    }
  })
}

/** The task open in this tab: in the side panel, or on its own page. */
function openTaskId(): string | null {
  const route = parse(window.location.pathname)
  return new URLSearchParams(window.location.search).get("task") ?? (route.name === "task" ? route.taskId : null)
}

const focused = () => document.visibilityState === "visible" && document.hasFocus()

/** The task open in the focused tab, if one of the browser's tabs on this board is focused. */
const FOCUS_KEY = "ia.focusedTask"

function shareFocus(): void {
  try {
    const cur = read(FOCUS_KEY, Focus)
    if (focused()) {
      const task = openTaskId()
      if (cur?.tab !== tab || cur.task !== task) write(FOCUS_KEY, Focus, { tab, task })
    } else if (cur?.tab === tab) window.localStorage.removeItem(FOCUS_KEY)
  } catch {
    // Only this tab's focus counts.
  }
}

/** Whether task `id` is open in a focused window: this one, or another of the browser's. */
function openInFocus(id: string): boolean {
  if (focused()) return openTaskId() === id
  return read(FOCUS_KEY, Focus)?.task === id
}

// ---------- notifications ----------

/** The notifications shown by this tab, by host and task id. */
const shown = new Map<string, { readonly n: Notification; readonly event: NotifyEvent }>()
const keyOf = (t: { readonly host_id: string; readonly id: string }) => `${t.host_id}:${t.id}`

function close(key: string): void {
  shown.get(key)?.n.close()
  shown.delete(key)
}

/** Closes task `id`'s notification, once it's been opened. */
function closeOpened(id: unknown): void {
  if (typeof id === "string" && id) for (const key of shown.keys()) if (key.endsWith(`:${id}`)) close(key)
}

/** Shows `title` and `body` as a system notification; clicking it opens task `t` (if given) in this window. */
export function showNotification(title: string, body: string, t?: HostTask): Notification | undefined {
  if (notifyPermission() !== "granted") return undefined
  try {
    // Silent: the sound is a setting of its own.
    const n = new Notification(title, { body, icon: "/icon.svg", silent: true })
    n.addEventListener("click", () => {
      n.close()
      window.focus()
      desktop()?.focus?.()
      if (t) openTask(t.id)
    })
    return n
  } catch {
    // Some browsers have the API but only let service workers show them (Chrome on Android).
    return undefined
  }
}

function present(t: HostTask, event: NotifyEvent): void {
  const settings = notifySettings()
  if (settings.mode === "off" || !settings.events[event] || !leader.leading()) return
  if (openInFocus(t.id) || movedHere(t.host_id, t.id, EVENT_STATUS[event])) return
  if (playsSound(settings.mode)) chime(event)
  if (!showsNotifications(settings.mode)) return
  const { title, body } = notificationText(event, t)
  const key = keyOf(t)
  // A task has one notification at a time: its latest.
  close(key)
  const n = showNotification(title, body, t)
  if (!n) return
  shown.set(key, { n, event })
  n.addEventListener("close", () => {
    if (shown.get(key)?.n === n) shown.delete(key)
  })
}

/** The tasks whose "ready to review" waits out its grace, by host and id. */
const pending = new Map<string, ReturnType<typeof setTimeout>>()

function cancel(key: string): void {
  clearTimeout(pending.get(key))
  pending.delete(key)
}

/** Notifies of a change at once, or for "ready to review" only once it has stayed so for `REVIEW_GRACE_MS`. */
function observe(prev: HostTask, next: HostTask): void {
  const key = keyOf(next)
  if (!readyToCheck(next)) cancel(key)
  const e = taskEvent(prev, next)
  if (!e) return
  if (e !== "review") return present(next, e)
  if (pending.has(key)) return
  pending.set(
    key,
    setTimeout(() => {
      pending.delete(key)
      const cur = board.get().tasks[next.id]
      if (cur?.host_id === next.host_id && readyToCheck(cur)) present(cur, "review")
    }, REVIEW_GRACE_MS),
  )
}

function taskChanged(prev: HostTask | undefined, next: HostTask): void {
  // What it said is over: answered, or moved on.
  const s = shown.get(keyOf(next))
  if (s && !stillApplies(s.event, next)) close(keyOf(next))
  // A task first seen now (new, or not loaded yet) was in its column before anything here could tell.
  if (prev) observe(prev, next)
}

// ---------- sound ----------

const sound: { audio: AudioContext | null; chimed: number } = { audio: null, chimed: 0 }

/** Browsers only let a page play sound once the user has clicked or typed on it: call it from a click or key. */
export function unlockSound(): void {
  if (!playsSound(notifySettings().mode) || typeof AudioContext === "undefined") return
  sound.audio ??= new AudioContext()
  if (sound.audio.state !== "running") sound.audio.resume().catch(() => {})
}

/** Two notes, falling for attention and rising otherwise. Several at once play once. */
export function chime(event: NotifyEvent): void {
  unlockSound()
  const audio = sound.audio
  if (!audio || audio.state === "closed" || Date.now() - sound.chimed < 1_000) return
  sound.chimed = Date.now()
  const notes = event === "attention" ? [880, 660] : [660, 880]
  notes.forEach((f, i) => {
    const at = audio.currentTime + 0.02 + i * 0.16
    const osc = audio.createOscillator()
    const gain = audio.createGain()
    osc.type = "sine"
    osc.frequency.value = f
    gain.gain.setValueAtTime(0.0001, at)
    gain.gain.exponentialRampToValueAtTime(0.25, at + 0.015)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.45)
    osc.connect(gain).connect(audio.destination)
    osc.start(at)
    osc.stop(at + 0.5)
  })
}

// ---------- count ----------

const icon: {
  current: { readonly link: HTMLLinkElement; readonly href: string; readonly type: string; readonly image: Promise<HTMLImageElement | null> } | null
} = { current: null }
const count = { drawn: -1, title: "Huntaway" }

/** The tab's icon with a badge of `n` on it (or as it was for 0). */
async function setIcon(n: number): Promise<void> {
  const link = icon.current?.link ?? document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (!link) return
  if (!icon.current) {
    const image = new Image()
    const loaded = Promise.withResolvers<HTMLImageElement | null>()
    image.addEventListener("load", () => loaded.resolve(image))
    image.addEventListener("error", () => loaded.resolve(null))
    image.src = link.href
    icon.current = { link, href: link.href, type: link.type, image: loaded.promise }
  }
  const { href, type } = icon.current
  if (!n) {
    link.type = type
    link.href = href
    return
  }
  const image = await icon.current.image
  if (count.drawn !== n) return // a later count took over meanwhile
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = 64
  const ctx = canvas.getContext("2d")
  if (!ctx) return
  if (image) ctx.drawImage(image, 0, 0, 64, 64)
  const label = n > 99 ? "99+" : String(n)
  ctx.beginPath()
  ctx.arc(42, 42, 22, 0, Math.PI * 2)
  ctx.fillStyle = "#f59e0b"
  ctx.fill()
  ctx.lineWidth = 4
  ctx.strokeStyle = "#0b0b0e"
  ctx.stroke()
  ctx.fillStyle = "#0b0b0e"
  ctx.font = `bold ${label.length > 2 ? 18 : label.length > 1 ? 24 : 30}px system-ui, sans-serif`
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"
  ctx.fillText(label, 42, 44)
  link.type = "image/png"
  link.href = canvas.toDataURL("image/png")
}

const showTitle = () => {
  document.title = count.drawn > 0 ? `(${count.drawn}) ${count.title}` : count.title
}

/** Names the profile the sidebar lists in the title, where there are several, so that each window says which it shows (HA-298). */
export function setTitleProfile(profile: string | undefined): void {
  count.title = profile ? `${profile} · Huntaway` : "Huntaway"
  showTitle()
}

function showCount(): void {
  const n = notifySettings().count ? attentionCount(Object.values(board.get().tasks)) : 0
  if (n === count.drawn) return
  count.drawn = n
  showTitle()
  void setIcon(n)
  desktop()?.setBadgeCount?.(n)
}

// ---------- start ----------

const started = { yes: false }

/** Starts telling the user: once per page (main.tsx). */
export function startNotifications(): void {
  if (started.yes) return
  started.yes = true
  lead()
  onLiveTaskChange(taskChanged)
  registry.subscribe(boardAtom, showCount)
  onNotifySettings(showCount)
  showCount()

  for (const e of ["pointerdown", "keydown"]) document.addEventListener(e, unlockSound, { capture: true, passive: true })

  // Which task the focused tab shows, for all of them; and a task opened in it has nothing more to tell.
  const focusChanged = () => {
    shareFocus()
    if (focused()) closeOpened(openTaskId())
  }
  window.addEventListener("focus", focusChanged)
  window.addEventListener("blur", focusChanged)
  document.addEventListener("visibilitychange", focusChanged)
  onNavigate(focusChanged)
  window.addEventListener("pagehide", () => {
    try {
      if (read(FOCUS_KEY, Focus)?.tab === tab) window.localStorage.removeItem(FOCUS_KEY)
    } catch {
      // It's taken over by the next tab focused.
    }
  })
  window.addEventListener("storage", (e) => {
    if (e.key !== FOCUS_KEY) return
    closeOpened(read(FOCUS_KEY, Focus)?.task)
  })
  shareFocus()
}
