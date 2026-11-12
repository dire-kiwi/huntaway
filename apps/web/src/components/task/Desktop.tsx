import { useAtomValue } from "@effect/atom-react"
import { query, type HostTask as Task, type QueryResult } from "@huntaway/client"
import { TaskId, type DesktopFrame, type DesktopOp } from "@huntaway/contracts"
import { clsx } from "clsx"
import { AsyncResult, Atom } from "effect/reactivity"
import { Monitor, X } from "lucide-react"
import { useState } from "react"
import { useVisible } from "../../state/visibility"
import { IconButton, resultError, resultValue, timeAgo } from "../ui"

/** No host to ask. */
const noStatus: Atom.Atom<QueryResult<"desktop.status">> = Atom.make<QueryResult<"desktop.status">>(AsyncResult.initial())

/** Whether host `hostId` lets its agents use its desktop (on, with a driver): the task view's button shows only then. */
export function useDesktopOn(hostId: string | undefined): boolean {
  const status = resultValue(useAtomValue(hostId ? query("desktop.status", hostId, undefined) : noStatus))
  return !!status && status.enabled && status.installed !== null
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

/** How often the view asks for a frame (while the page is shown), and for the task's actions. */
const FRAME_EVERY = "700 millis"
const OPS_EVERY = "3 seconds"
const NO_OPS: ReadonlyArray<DesktopOp> = []

/**
 * The host's desktop as the task's agent sees it (HA-273): the window it last read or acted on (or the whole desktop
 * before it has), live while the driver runs, and what it did there, newest first.
 */
export function DesktopPane({ task, onClose }: { task: Task; onClose: () => void }) {
  const id = TaskId.make(task.id)
  const read = useAtomValue(query("desktop.frame", task.host_id, { task_id: id }, { refresh: useVisible() ? FRAME_EVERY : undefined }))
  const ops = resultValue(useAtomValue(query("desktop.ops", task.host_id, { task_id: id }, { refresh: OPS_EVERY })))?.ops ?? NO_OPS
  const now = resultValue(read)
  // The last frame stays up while a read has none (the driver stopped), dimmed with why.
  const [frame, setFrame] = useState<DesktopFrame | null>(null)
  if (now?.frame && now.frame !== frame) setFrame(now.frame)
  const shown = now?.frame ?? frame
  const reason = resultError(read) ?? (now?.frame ? null : (now?.reason ?? null))
  return (
    <div className="flex h-full min-h-0 flex-col border-l border-line bg-panel/40" data-desktop-pane>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3 text-[12.5px]">
        <Monitor size={13} className="text-muted" />
        <span className="font-semibold">Desktop</span>
        <span className="min-w-0 flex-1 truncate text-muted">
          {shown ? (shown.pid === null ? "the whole desktop" : `window ${shown.window_id ?? "?"} of pid ${shown.pid}`) : ""}
        </span>
        <IconButton title="Close the desktop view" onClick={onClose}>
          <X size={13} />
        </IconButton>
      </div>
      <div className="relative flex min-h-0 flex-[3] items-center justify-center bg-black/40 p-2">
        {shown ? (
          <img
            alt="What the agent sees"
            src={`data:${shown.mime};base64,${shown.data}`}
            className={clsx("h-full w-full object-contain", reason && "opacity-40")}
            style={{ imageRendering: "auto" }}
          />
        ) : (
          <div className="px-6 text-center text-[12.5px] text-muted">{reason ?? "Waiting for the desktop…"}</div>
        )}
        {shown && reason && <div className="absolute inset-x-3 bottom-3 rounded bg-black/70 px-2 py-1 text-center text-[12px] text-muted">{reason}</div>}
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
