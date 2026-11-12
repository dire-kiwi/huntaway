import { useAtomValue } from "@effect/atom-react"
import { clsx } from "clsx"
import { Effect } from "effect"
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity"
import { Bell, Smartphone, X } from "lucide-react"
import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react"
import { ASSISTANT_PUSH_EVENTS, localHostIdAtom, NOTIFY_EVENTS, PUSH_PROMPTS, query, type QueryResult } from "@huntaway/client"
import type { PushDevice, PushEvents, PushPrompts } from "@huntaway/contracts"
import {
  NOTIFY_MODES,
  notifySettings,
  onNotifySettings,
  playsSound,
  saveNotifySettings,
  showsNotifications,
  type NotifyMode,
  type NotifySettings,
} from "../../state/notify"
import { exitError, useAction } from "../../state/mutation"
import { Button, IconButton, resultError, resultValue, timeAgo, Toggle } from "../ui"
import { chime, inDesktopApp, notifyPermission, showNotification, unlockSound } from "./notifier"
import { endpointAtom, onHub, pushSupport, subscribe, unsubscribe } from "./push"

// Settings → Notifications (6.8): this browser's notifications (state/notify.ts, notifier.ts) and push to devices (push.ts).

/** The devices the board pushes to (`hub.push.info` on the page's own server), once its host id is known. */
const pushInfoAtom: Atom.Atom<QueryResult<"hub.push.info">> = Atom.make((get) => {
  const host = get(localHostIdAtom)
  return host === null ? AsyncResult.initial(true) : get(query("hub.push.info", host, undefined))
})

/** No endpoint to read: a browser without push. */
const noEndpoint: Atom.Atom<AsyncResult.AsyncResult<string | null>> = Atom.make(AsyncResult.success(null))

/** Saves `change` over this browser's notification settings. */
const save = (change: Partial<NotifySettings>) => saveNotifySettings(Object.assign({}, notifySettings(), change))

/** Settings → Notifications: how this browser tells the user that a task needs them. */
export function NotificationsPanel() {
  const settings = useSyncExternalStore(onNotifySettings, notifySettings)
  const [permission, setPermission] = useState(notifyPermission)
  // Allowed or blocked in the browser's own site settings meanwhile.
  useEffect(() => {
    const changed = () => setPermission(notifyPermission())
    const state: { status: PermissionStatus | null; live: boolean } = { status: null, live: true }
    navigator.permissions
      ?.query({ name: "notifications" })
      .then((s) => {
        if (!state.live) return
        state.status = s
        s.addEventListener("change", changed)
      })
      .catch(() => {})
    return () => {
      state.live = false
      state.status?.removeEventListener("change", changed)
    }
  }, [])

  // Browsers only ask from a click.
  const enable = () => {
    void Notification.requestPermission()
      .catch(() => "denied" as const)
      .then((answer) => {
        setPermission(notifyPermission())
        const mode = notifySettings().mode
        if (answer === "granted" && !showsNotifications(mode)) save({ mode: mode === "sound" ? "both" : "notify" })
      })
  }
  const pick = (mode: NotifyMode) => {
    save({ mode })
    unlockSound()
    if (showsNotifications(mode) && permission === "default") enable()
  }
  const test = () => {
    if (playsSound(settings.mode)) chime("attention")
    if (showsNotifications(settings.mode)) showNotification("Huntaway", "Notifications are on. Tasks that need you will show like this.")
  }

  const unavailable = permission === "insecure" || permission === "unsupported" || permission === "denied" || permission === "preview"
  return (
    <section>
      <h2 className="mb-3 text-[13px] font-semibold">Notifications</h2>
      <div className="space-y-4 rounded-xl border border-line p-4 text-[12.5px] text-muted">
        <p>
          Tell me when a task needs me, from this browser, while the board is open in it. One of its tabs or windows notifies, and none do for the task open in
          a focused window. These settings are kept in this browser.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex w-fit items-center gap-0.5 rounded-lg border border-line bg-panel p-0.5" role="radiogroup" aria-label="Notify with">
            {NOTIFY_MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={settings.mode === m.id}
                onClick={() => pick(m.id)}
                className={clsx("rounded-md px-2.5 py-1 text-[12px]", settings.mode === m.id ? "bg-raised text-fg" : "text-muted hover:text-fg")}
              >
                {m.label}
              </button>
            ))}
          </div>
          {settings.mode !== "off" && (
            <Button size="sm" onClick={test} disabled={!playsSound(settings.mode) && permission !== "granted"}>
              <Bell size={13} /> Try it
            </Button>
          )}
        </div>
        {showsNotifications(settings.mode) && (
          <div className={clsx("flex items-center gap-3 rounded-lg px-3 py-2", unavailable ? "bg-amber-400/10 text-amber-200" : "bg-white/5")}>
            <div className="min-w-0 flex-1">
              <PermissionNote permission={permission} />
            </div>
            {permission === "default" && (
              <Button size="sm" variant="primary" onClick={enable}>
                Enable
              </Button>
            )}
          </div>
        )}
        {playsSound(settings.mode) && (
          <p className="text-faint">
            The sound plays once you've clicked or typed on the page since it loaded: browsers don't let a page play sound before that.
          </p>
        )}
        <div className={clsx("space-y-2", settings.mode === "off" && "opacity-50")}>
          <div className="text-[12px] font-medium text-fg">When a task</div>
          {NOTIFY_EVENTS.map((e) => (
            <label key={e.id} className="flex items-start gap-2.5">
              <input
                type="checkbox"
                className="mt-0.5 accent-accent"
                checked={settings.events[e.id]}
                onChange={(ev) => save({ events: Object.assign({}, notifySettings().events, { [e.id]: ev.target.checked }) })}
              />
              <span>
                <span className="text-fg">{e.label}</span> <span className="text-faint">· {e.hint}</span>
              </span>
            </label>
          ))}
        </div>
        <Toggle
          checked={settings.count}
          onChange={(count) => save({ count })}
          label={<span>Count the tasks that need attention in the tab's title and icon{inDesktopApp() ? " and on the app's badge" : ""}</span>}
        />
      </div>
      {pushSupport() !== "desktop" && <PushPanel />}
    </section>
  )
}

/**
 * Push to this device: the board sends its notifications to devices that turn it on, such as a phone with the board on
 * its home screen, even while the board isn't open on them (see push.ts). Each device picks its own events.
 */
function PushPanel() {
  const support = pushSupport()
  // The devices, read when the panel opens and again after each change (the hub's `hub.*` mutations).
  const info = useAtomValue(pushInfoAtom)
  // This browser's subscription's endpoint, which tells its device from the others.
  const endpointResult = useAtomValue(support === "ok" ? endpointAtom : noEndpoint)
  const endpoint = resultValue(endpointResult) ?? null
  const [{ busy }, run] = useAction()
  const [, runUpdate] = useAction()
  const [failed, setErr] = useState<string | null>(null)
  const err = failed ?? resultError(info) ?? resultError(endpointResult)
  const [tested, setTested] = useState<string | null>(null)
  // A device's events as just picked, shown until the devices are read again (of: the events they were picked over).
  const [edited, setEdited] = useState<ReadonlyMap<string, { readonly of: PushEvents; readonly events: PushEvents }>>(() => new Map())
  const read = resultValue(info)?.subscriptions
  const devices = read?.map((d) => {
    const picked = edited.get(d.id)
    return picked && picked.of === d.events ? Object.assign({}, d, { events: picked.events }) : d
  })
  const mine = devices?.find((d) => d.endpoint === endpoint)
  const others = devices?.filter((d) => d !== mine) ?? []
  /** Runs a change of the devices, then reads this browser's subscription again (the devices are read again by the hub's mutations). */
  const change = <E,>(effect: Effect.Effect<unknown, E, AtomRegistry.AtomRegistry>, onDone?: () => void) => {
    setErr(null)
    setTested(null)
    void run(Effect.ensuring(effect, Atom.refresh(endpointAtom))).then((exit) => {
      const why = exitError(exit)
      if (why !== null) setErr(why)
      else onDone?.()
    })
  }
  const setEvents = (d: PushDevice, events: PushEvents) => {
    const of = read?.find((x) => x.id === d.id)?.events
    if (of) setEdited((m) => new Map(m).set(d.id, { of, events }))
    void runUpdate(onHub("hub.push.update", { id: d.id, events })).then((exit) => {
      const why = exitError(exit)
      if (why !== null) setErr(why)
    })
  }
  const test = (d: PushDevice) => change(onHub("hub.push.test", { id: d.id }), () => setTested(d.id))
  // Browsers only ask for the permission from a click.
  const turnOn = () => change(subscribe(Notification.requestPermission()))

  return (
    <div className="mt-4 space-y-4 rounded-xl border border-line p-4 text-[12.5px] text-muted" aria-label="Push">
      <div>
        <div className="mb-1 flex items-center gap-2 text-[12.5px] font-medium text-fg">
          <Smartphone size={14} /> Push to this device
        </div>
        <p>
          The board pushes notifications of these events to the devices that turn this on, even while the board isn't open on them: a phone with the board on
          its home screen, say. Tapping one opens the task. Each device picks its own events, whatever the setting above, and whose permission prompts it gets.
        </p>
      </div>
      {support !== "ok" ? (
        <div className="rounded-lg bg-amber-400/10 px-3 py-2 text-amber-200">
          <PushNote support={support} />
        </div>
      ) : mine ? (
        <div className="space-y-3 rounded-lg bg-white/5 px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 text-fg">
              On for this device <span className="text-faint">· {mine.name}</span>
            </span>
            <Button size="sm" disabled={busy} onClick={() => test(mine)}>
              <Bell size={13} /> Send a test
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => change(unsubscribe(mine))}>
              Turn off
            </Button>
          </div>
          {tested === mine.id && <p className="text-emerald-300">Sent. It should show on this device in a moment.</p>}
          <DeviceEvents device={mine} onChange={(e) => setEvents(mine, e)} />
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" variant="primary" disabled={busy || !devices} onClick={turnOn}>
            Turn on push for this device
          </Button>
          {typeof Notification !== "undefined" && Notification.permission === "denied" && (
            <span className="text-amber-200">This browser blocks the board's notifications: allow them in its settings for this site first.</span>
          )}
        </div>
      )}
      {err && <p className="text-red-400">{err}</p>}
      {others.length > 0 && (
        <div className="space-y-2">
          <div className="text-[12px] font-medium text-fg">Other devices</div>
          {others.map((d) => (
            <div key={d.id} className="rounded-lg border border-line px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-fg">
                  {d.name || "A device"}
                  {d.kind === "expo" && <span className="text-faint"> · Huntaway app (its pushes wait for the app)</span>}
                </span>
                <span className="shrink-0 text-faint">{d.last_sent_at ? `last sent ${timeAgo(d.last_sent_at)}` : `added ${timeAgo(d.created_at)}`}</span>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => test(d)} title={`Send ${d.name || "it"} a test notification`}>
                  Test
                </Button>
                <IconButton
                  title={`Stop pushing to ${d.name || "this device"}`}
                  disabled={busy}
                  onClick={() => change(onHub("hub.push.unsubscribe", { id: d.id }))}
                >
                  <X size={14} />
                </IconButton>
              </div>
              {tested === d.id && <p className="mt-1 text-emerald-300">Sent.</p>}
              {d.last_error && <p className="mt-1 text-amber-200">The last push failed: {d.last_error}</p>}
              <div className="mt-2">
                <DeviceEvents device={d} onChange={(e) => setEvents(d, e)} compact />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** The events a device gets by push (the board's, and the assistant's replies and reports), and whose permission prompts. */
function DeviceEvents({ device, onChange, compact }: { device: PushDevice; onChange: (e: PushEvents) => void; compact?: boolean }) {
  return (
    <div className={clsx(compact ? "flex flex-wrap items-center gap-x-4 gap-y-1" : "space-y-2")} role="group" aria-label={`Events pushed to ${device.name}`}>
      {NOTIFY_EVENTS.map((e) => (
        <label key={e.id} className="flex items-start gap-2.5">
          <input
            type="checkbox"
            className="mt-0.5 accent-accent"
            checked={device.events[e.id]}
            onChange={(ev) => onChange(Object.assign({}, device.events, { [e.id]: ev.target.checked }))}
          />
          <span>
            <span className="text-fg">{e.label}</span>
            {!compact && <span className="text-faint"> · {e.hint}</span>}
          </span>
        </label>
      ))}
      {ASSISTANT_PUSH_EVENTS.map((e) => (
        <label key={e.id} className="flex items-start gap-2.5">
          <input
            type="checkbox"
            className="mt-0.5 accent-accent"
            checked={device.events[e.id]}
            onChange={(ev) => onChange(Object.assign({}, device.events, { [e.id]: ev.target.checked }))}
          />
          <span>
            <span className="text-fg">{e.label}</span>
            {!compact && <span className="text-faint"> · {e.hint}</span>}
          </span>
        </label>
      ))}
      <label className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <span className="text-fg">Permission prompts</span>
        <select
          className="h-7 rounded-md border border-line bg-panel px-1.5 text-[12px] text-fg outline-none"
          value={device.events.prompts}
          aria-label={`Permission prompts pushed to ${device.name || "this device"}`}
          onChange={(ev) => onChange(Object.assign({}, device.events, { prompts: pushPrompts(ev.target.value) }))}
        >
          {PUSH_PROMPTS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        {!compact && <span className="basis-full text-faint">It names the tool, but not what it's run with.</span>}
      </label>
    </div>
  )
}

const isPushPrompts = (v: string): v is PushPrompts => PUSH_PROMPTS.some((p) => p.id === v)
/** A picked value, as the device's events take it. */
const pushPrompts = (v: string): PushPrompts => (isPushPrompts(v) ? v : "assistant")

function PushNote({ support }: { support: ReturnType<typeof pushSupport> }) {
  if (support === "insecure")
    return (
      <>
        Push needs the board on HTTPS, and this page is plain HTTP on <span className="font-mono">{window.location.hostname}</span>. Serve the board over HTTPS
        at an address the device can reach, such as with <code>tailscale serve</code> (see{" "}
        <a className="underline" href="/guide/mobile#push-notifications-on-a-phone">
          Push notifications on a phone
        </a>{" "}
        in the guide), and open it there.
      </>
    )
  if (support === "install")
    return (
      <>
        On an iPhone or iPad, push works for the board on the Home Screen: tap Share, then <i>Add to Home Screen</i>, open Huntaway from there, sign in with the
        board's token, and turn push on here.
      </>
    )
  return <>This browser can't receive push notifications.</>
}

const PERMISSION_NOTES: Readonly<Record<ReturnType<typeof notifyPermission>, () => ReactNode>> = {
  granted: () => <>This browser shows the board's notifications.</>,
  default: () => <>This browser hasn't been allowed to show the board's notifications yet.</>,
  denied: () => <>This browser blocks the board's notifications. Allow them in its settings for this site (from the icon beside the address), then reload.</>,
  insecure: () => (
    <>
      Notifications can't work here: browsers only show them for secure pages, on HTTPS or localhost, and this page is plain HTTP on{" "}
      <span className="font-mono">{window.location.hostname}</span>. Open the board on localhost (through an SSH tunnel, say), over HTTPS (such as{" "}
      <code>tailscale serve</code>) or in the desktop app. The sound and the count still work.
    </>
  ),
  unsupported: () => <>This browser doesn't support notifications. The sound and the count still work.</>,
  preview: () => (
    <>This board is a preview (it signs in any browser that opens it), so it doesn't show system notifications. The sound and the count still work.</>
  ),
}

function PermissionNote({ permission }: { permission: ReturnType<typeof notifyPermission> }) {
  return PERMISSION_NOTES[permission]()
}
