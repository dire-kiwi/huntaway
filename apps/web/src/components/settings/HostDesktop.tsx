import { useAtomValue } from "@effect/atom-react"
import { type Effect, Exit } from "effect"
import type { AtomRegistry } from "effect/reactivity"
import { Loader2 } from "lucide-react"
import { useState } from "react"
import { mutate, query } from "@huntaway/client"
import { useAction } from "../../state/mutation"
import { Button, resultError, resultValue, timeAgo, Toggle, useConfirm } from "../ui"

const SESSION: Record<string, string> = { wayland: "a Wayland session", x11: "an X11 session", macos: "macOS" }

const mb = (n: number) => `${(n / 1_000_000).toFixed(1)} MB`

/**
 * Computer use on a host (HA-273): install Cua Driver, and let the host's agents see and use its desktop through their
 * `desktop` tools. Its actions ask first, as any tool does. The host's page (6.12) mounts it.
 */
export function HostDesktop({ hostId }: { hostId: string }) {
  // Read every 15 s, and every second while Cua Driver installs (which the status it reads says); each action reads it
  // again (the desktop group).
  const [fast, setFast] = useState(false)
  const result = useAtomValue(query("desktop.status", hostId, undefined, { refresh: fast ? "1 second" : "15 seconds" }))
  const st = resultValue(result) ?? null
  const [check, setCheck] = useState<string | null>(null)
  // Which action runs, for its button's spinner.
  const [doing, setDoing] = useState<string | null>(null)
  const [action, run] = useAction()
  const confirm = useConfirm()
  const installing = !!st?.install && st.install.phase !== "done" && st.install.phase !== "failed"
  if (installing !== fast) setFast(installing)
  // A host that can't say has nothing to show.
  if (!st) return null

  const busy = action.busy ? doing : null
  const err = action.error ?? resultError(result)
  const act = <A, E>(what: string, change: Effect.Effect<A, E, AtomRegistry.AtomRegistry>) => {
    setDoing(what)
    return run(change)
  }
  const checkNow = () =>
    void act("check", mutate("desktop.check", hostId, undefined)).then((exit) => {
      if (Exit.isSuccess(exit)) setCheck(exit.value.check)
    })
  const inst = st.installed
  const outdated = inst?.source === "installed" && st.release && inst.version !== st.release.version
  const failed = st.install?.phase === "failed" ? st.install : null
  const d = st.driver

  return (
    <section>
      <div className="mb-1 flex items-center justify-between gap-2">
        <h2 className="text-[13px] font-semibold">Computer use</h2>
        <div className="flex items-center gap-2">
          {inst && (
            <Button size="sm" variant="ghost" disabled={!!busy || installing} onClick={checkNow}>
              {busy === "check" && <Loader2 size={12} className="animate-spin" />} Check
            </Button>
          )}
          {st.release && (!inst || outdated) && (
            <Button size="sm" disabled={!!busy || installing} onClick={() => void act("install", mutate("desktop.install", hostId, undefined))}>
              {installing ? <Loader2 size={12} className="animate-spin" /> : null}
              {outdated ? `Update Cua Driver to ${st.release.version}` : `Install Cua Driver ${st.release.version}`}
            </Button>
          )}
          {inst?.source === "installed" && (
            <Button
              size="sm"
              variant="ghost"
              disabled={!!busy || installing}
              onClick={() =>
                confirm.ask({
                  title: "Remove Cua Driver",
                  body: `Remove Cua Driver ${inst.version} from this host? Agents here lose their desktop tools from their next run.`,
                  action: "Remove",
                  danger: true,
                  onConfirm: () => act("remove", mutate("desktop.uninstall", hostId, undefined)),
                })
              }
            >
              Remove
            </Button>
          )}
        </div>
      </div>
      <div className="space-y-2 text-[12.5px] text-muted">
        <p>
          Let agents on this host see and use its desktop through{" "}
          <a className="text-accent hover:underline" href="https://github.com/trycua/cua" target="_blank" rel="noreferrer">
            Cua Driver
          </a>
          : they read apps' windows and click and type in them, in the background, without taking the pointer or focus. Looking needs no approval; acting,
          starting apps and the clipboard ask first, unless the task runs in Bypass. One task drives the desktop at a time, and nothing runs while the screen is
          locked.
        </p>
        {installing && st.install && (
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-fg">
              <Loader2 size={13} className="animate-spin text-accent" />
              {st.install.phase === "downloading"
                ? `Downloading Cua Driver ${st.install.version}… ${mb(st.install.received)} of ${mb(st.install.total)}`
                : `${st.install.phase.charAt(0).toUpperCase()}${st.install.phase.slice(1)}…`}
            </div>
            <div className="h-1 overflow-hidden rounded bg-line">
              <div className="h-full bg-accent" style={{ width: `${Math.round((st.install.received / Math.max(1, st.install.total)) * 100)}%` }} />
            </div>
          </div>
        )}
        {failed && <div className="rounded bg-red-500/10 p-2 font-mono text-[11.5px] whitespace-pre-wrap text-red-300">Install failed: {failed.error}</div>}
        {!st.release && !inst && <div>Cua Driver has no release for this host's platform ({st.platform}).</div>}
        {inst && (
          <div className="space-y-1">
            <div>
              {inst.source === "installed"
                ? `Cua Driver ${inst.version}`
                : inst.source === "env"
                  ? "Cua Driver from HUNTAWAY_CUA_DRIVER"
                  : "Cua Driver from PATH"}
              , <span className="font-mono break-all text-fg">{inst.path}</span>
            </div>
            <div>
              {st.session
                ? `On ${SESSION[st.session] ?? st.session}`
                : "No graphical session found: the driver needs one (DISPLAY or WAYLAND_DISPLAY), so log in on that machine"}
              {st.locked ? ", with the screen locked" : ""}.{" "}
              {d.state === "running"
                ? `The driver is running${d.version ? ` (${d.version})` : ""}${d.last_call_at ? `, last used ${timeAgo(d.last_call_at)}` : ""}.`
                : d.state === "starting"
                  ? "The driver is starting."
                  : "The driver starts when an agent uses the desktop."}
              {st.in_use_by && <> In use by “{st.in_use_by.title}”.</>}
            </div>
            {d.state === "failed" && d.error && (
              <div className="rounded bg-red-500/10 p-2 font-mono text-[11.5px] whitespace-pre-wrap text-red-300">{d.error}</div>
            )}
            {check !== null && <pre className="max-h-48 overflow-auto rounded bg-raised p-2 font-mono text-[11.5px] whitespace-pre-wrap text-fg">{check}</pre>}
            <div className="pt-1">
              <Toggle
                checked={st.enabled}
                onChange={(v) => void act("enable", mutate("desktop.setEnabled", hostId, { enabled: v }))}
                label={<span>Let agents on this host use its desktop (from their next run)</span>}
              />
            </div>
            {st.session === "wayland" && (
              <div className="text-[12px] text-faint">
                On Hyprland, Cua's background input needs its experimental plugin; without it, agents can act only in the foreground (moving the pointer and
                focus), which they ask you for first.
              </div>
            )}
          </div>
        )}
        {err && <div className="rounded bg-red-500/10 p-2 text-[12px] whitespace-pre-wrap text-red-300">{err}</div>}
      </div>
      {confirm.dialog}
    </section>
  )
}
