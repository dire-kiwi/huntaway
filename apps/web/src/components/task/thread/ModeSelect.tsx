import { PERMISSION_MODES, type HostTask as Task } from "@huntaway/client"
import type { PermissionMode } from "@huntaway/contracts"
import { clsx } from "clsx"
import { Ban, Check, ChevronDown, Map as MapIcon, Pencil, ShieldOff, ShieldQuestion, Sparkles } from "lucide-react"
import { useState, type ReactNode } from "react"
import { rpc } from "../../../state/rpc"
import { useBoard } from "../../../state/board"
import { useProject } from "../../boardHelpers"
import { errorText, useDismiss } from "../../ui"

const MODE_STYLE: Record<PermissionMode, { icon: ReactNode; className: string }> = {
  default: { icon: <ShieldQuestion size={12} />, className: "text-muted" },
  acceptEdits: { icon: <Pencil size={12} />, className: "text-violet-300" },
  auto: { icon: <Sparkles size={12} />, className: "text-sky-300" },
  plan: { icon: <MapIcon size={12} />, className: "text-emerald-300" },
  dontAsk: { icon: <Ban size={12} />, className: "text-amber-300" },
  bypassPermissions: { icon: <ShieldOff size={12} />, className: "text-red-300" },
}

/** Modes Shift+Tab cycles through, like Claude Code. Riskier ones are picked from the menu. */
const CYCLE: PermissionMode[] = ["default", "acceptEdits", "auto", "plan"]

export function useModeControl(task: Task) {
  const project = useProject(task.project_id)
  const hostMode = useBoard((s) => s.hostSettings[task.host_id]?.default_permission_mode)
  const inherited: PermissionMode = project?.permission_mode ?? hostMode ?? "default"
  // Where the inherited mode comes from, for the reset entry.
  const source = project?.permission_mode ? "project default" : hostMode ? "host default" : "default"
  const mode = task.permission_mode ?? inherited
  const [err, setErr] = useState<string | null>(null)
  const setMode = async (m: PermissionMode | null) => {
    setErr(null)
    try {
      await rpc(task.host_id, "tasks.update", { id: task.id, patch: { permission_mode: m } })
    } catch (e) {
      setErr(errorText(e))
    }
  }
  const cycle = () => {
    const i = CYCLE.indexOf(mode)
    void setMode(CYCLE[(i + 1) % CYCLE.length] ?? "default")
  }
  return { mode, inherited, source, overridden: task.permission_mode != null, setMode, cycle, err }
}

export function ModeSelect({ control, running }: { control: ReturnType<typeof useModeControl>; running: boolean }) {
  const [open, setOpen] = useState(false)
  const root = useDismiss<HTMLDivElement>(open, () => setOpen(false))
  const { mode, inherited, source, overridden, setMode } = control
  const current = PERMISSION_MODES.find((m) => m.id === mode) ?? PERMISSION_MODES[0]

  const pick = (m: PermissionMode | null) => {
    setOpen(false)
    void setMode(m)
  }
  const inheritedLabel = PERMISSION_MODES.find((m) => m.id === inherited)?.label

  return (
    <div ref={root} className="relative">
      <button
        onClick={() => setOpen(!open)}
        title={`Permission mode: ${current.description} (Shift+Tab in the message box to cycle; Escape, Shift+Tab to leave the box)`}
        className={clsx(
          "flex h-6 items-center gap-1 rounded-md border border-line px-1.5 text-[11.5px] hover:border-line-strong hover:bg-white/5",
          MODE_STYLE[mode].className,
        )}
      >
        {MODE_STYLE[mode].icon}
        {current.label}
        <ChevronDown size={11} className="text-faint" />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-20 mb-1.5 w-80 rounded-lg border border-line-strong bg-panel-2 p-1 shadow-xl">
          {PERMISSION_MODES.map((m) => (
            <button
              key={m.id}
              onClick={() => pick(m.id)}
              className={clsx("flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-white/5", m.id === mode && "bg-white/[0.04]")}
            >
              <span className={clsx("mt-0.5", MODE_STYLE[m.id].className)}>{MODE_STYLE[m.id].icon}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-[12.5px] text-fg">{m.label}</span>
                <span className="block text-[11.5px] text-faint">{m.description}</span>
              </span>
              {m.id === mode && <Check size={13} className="mt-0.5 text-accent" />}
            </button>
          ))}
          <button
            onClick={() => pick(null)}
            disabled={!overridden}
            className="mt-1 flex w-full items-center gap-2 rounded-md border-t border-line px-2 py-1.5 text-left text-[11.5px] text-muted hover:bg-white/5 disabled:text-faint disabled:hover:bg-transparent"
          >
            {overridden ? `Reset to ${source} (${inheritedLabel})` : `Using ${source} (${inheritedLabel})`}
          </button>
          {running && (
            <div className="px-2 pt-1 pb-0.5 text-[11px] text-faint">
              Changes apply from the next message. Bypass and Don't ask also settle prompts in the current run.
            </div>
          )}
        </div>
      )}
    </div>
  )
}
