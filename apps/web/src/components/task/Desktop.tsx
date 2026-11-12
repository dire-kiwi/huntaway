import type { HostTask as Task } from "@huntaway/client"
import { TaskId, type DesktopFrame, type DesktopOp } from "@huntaway/contracts"
import { clsx } from "clsx"
import { Monitor, X } from "lucide-react"
import { useEffect, useState } from "react"
import { rpc } from "../../state/rpc"
import { errorText, IconButton, timeAgo } from "../ui"

/** Each host's computer use, as last fetched, so opening tasks doesn't ask again and again. */
const known = new Map<string, { at: number; on: boolean }>()

/** Whether host `hostId` lets its agents use its desktop (on, with a driver): the task view's button shows only then. */
export function useDesktopOn(hostId: string | undefined): boolean {
  const id = hostId ?? ""
  const [on, setOn] = useState(() => known.get(id)?.on ?? false)
  const [shownFor, setShownFor] = useState(id)
  if (shownFor !== id) {
    setShownFor(id)
    setOn(known.get(id)?.on ?? false)
  }
  useEffect(() => {
    if (id === "") return undefined
    const k = known.get(id)
    if (k && Date.now() - k.at < 60_000) return undefined
    const view = { live: true }
    rpc(id, "desktop.status", undefined).then(
      (s) => {
        const v = s.enabled && s.installed !== null
        known.set(id, { at: Date.now(), on: v })
        if (view.live) setOn(v)
      },
      () => {},
    )
    return () => {
      view.live = false
    }
  }, [id])
  return on
}

export function DesktopButton({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <IconButton
      title={open ? "Close the desktop view" : "What the agent sees on the host's desktop"}
      aria-pressed={open}
      className={clsx("border border-line bg-panel", open && "bg-raised! text-fg")}
      onClick={onClick}
    >
      <Monitor size={14} />
    </IconButton>
  )
}

const STATUS: Record<DesktopOp["status"], string> = { running: "bg-amber-400", ok: "bg-emerald-400", failed: "bg-red-400", interrupted: "bg-zinc-400" }

/** How often the view asks for a frame, and for the task's actions. */
const FRAME_MS = 700
const OPS_MS = 3000

/**
 * The host's desktop as the task's agent sees it (HA-273): the window it last read or acted on (or the whole desktop
 * before it has), live while the driver runs, and what it did there, newest first.
 */
export function DesktopPane({ task, onClose }: { task: Task; onClose: () => void }) {
  const [frame, setFrame] = useState<DesktopFrame | null>(null)
  const [reason, setReason] = useState<string | null>(null)
  const [ops, setOps] = useState<ReadonlyArray<DesktopOp>>([])
  useEffect(() => {
    const view: { live: boolean; timer?: ReturnType<typeof setTimeout> } = { live: true }
    const tick = async () => {
      if (document.visibilityState === "visible") {
        try {
          const r = await rpc(task.host_id, "desktop.frame", { task_id: TaskId.make(task.id) })
          if (!view.live) return
          if (r.frame) setFrame(r.frame)
          setReason(r.frame ? null : (r.reason ?? null))
        } catch (e) {
          if (view.live) setReason(errorText(e))
        }
      }
      if (view.live) view.timer = setTimeout(() => void tick(), FRAME_MS)
    }
    void tick()
    return () => {
      view.live = false
      clearTimeout(view.timer)
    }
  }, [task.host_id, task.id])
  useEffect(() => {
    const view = { live: true }
    const load = () =>
      rpc(task.host_id, "desktop.ops", { task_id: TaskId.make(task.id) }).then(
        (r) => {
          if (view.live) setOps(r.ops)
        },
        () => {},
      )
    void load()
    const id = setInterval(() => void load(), OPS_MS)
    return () => {
      view.live = false
      clearInterval(id)
    }
  }, [task.host_id, task.id])
  return (
    <div className="flex h-full min-h-0 flex-col border-l border-line bg-panel/40" data-desktop-pane>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3 text-[12.5px]">
        <Monitor size={13} className="text-muted" />
        <span className="font-semibold">Desktop</span>
        <span className="min-w-0 flex-1 truncate text-muted">
          {frame ? (frame.pid === null ? "the whole desktop" : `window ${frame.window_id ?? "?"} of pid ${frame.pid}`) : ""}
        </span>
        <IconButton title="Close the desktop view" onClick={onClose}>
          <X size={13} />
        </IconButton>
      </div>
      <div className="relative flex min-h-0 flex-[3] items-center justify-center bg-black/40 p-2">
        {frame ? (
          <img
            alt="What the agent sees"
            src={`data:${frame.mime};base64,${frame.data}`}
            className={clsx("h-full w-full object-contain", reason && "opacity-40")}
            style={{ imageRendering: "auto" }}
          />
        ) : (
          <div className="px-6 text-center text-[12.5px] text-muted">{reason ?? "Waiting for the desktop…"}</div>
        )}
        {frame && reason && <div className="absolute inset-x-3 bottom-3 rounded bg-black/70 px-2 py-1 text-center text-[12px] text-muted">{reason}</div>}
      </div>
      <div className="min-h-0 flex-[2] overflow-y-auto border-t border-line">
        <div className="px-3 pt-2 pb-1 text-[11.5px] font-semibold tracking-wide text-faint uppercase">What it did</div>
        {ops.length === 0 ? (
          <div className="px-3 pb-3 text-[12.5px] text-muted">Nothing yet: its reads aren't listed, only what it does.</div>
        ) : (
          <ul className="pb-2">
            {ops.map((o) => (
              <li key={o.id} className="flex items-start gap-2 px-3 py-1 text-[12.5px]" title={o.result ?? undefined}>
                <span className={clsx("mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full", STATUS[o.status])} />
                <span className="min-w-0 flex-1">
                  <span className="text-fg">{o.summary}</span>
                  {o.status !== "ok" && <span className="text-muted"> · {o.status}</span>}
                </span>
                <span className="shrink-0 text-[11.5px] text-faint">{timeAgo(o.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
