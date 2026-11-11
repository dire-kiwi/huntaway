import { TaskId } from "@huntaway/contracts"
import { createStore } from "../../smallStore"
import { rpc } from "../../state/rpc"
import { parseJson, toJson } from "../ui/json"

/**
 * Terminal tools (lazygit, an editor…) this board has open, per task. Each is a tmux session
 * on the task's host that lasts as long as a board keeps it open: while the app is open we
 * renew it every so often, and the host ends sessions nobody renews or is attached to. The
 * list is kept for the browser tab (sessionStorage), so reloading doesn't close them.
 *
 * Step 1 (docs/plan/09-frontend.md): the old zustand store on `smallStore`, kept beside the terminal.
 */

const KEY = "ia.openTools"
const KEEPALIVE_MS = 30_000

export interface OpenTool {
  hostId: string
  taskId: string
  toolId: string
}

interface ToolsState {
  open: OpenTool[]
  openTool: (t: OpenTool) => void
  closeTool: (t: OpenTool) => void
}

const same = (a: OpenTool, b: OpenTool) => a.hostId === b.hostId && a.taskId === b.taskId && a.toolId === b.toolId

const isOpenTool = (v: unknown): v is OpenTool =>
  typeof v === "object" &&
  v !== null &&
  "hostId" in v &&
  typeof v.hostId === "string" &&
  "taskId" in v &&
  typeof v.taskId === "string" &&
  "toolId" in v &&
  typeof v.toolId === "string"

function load(): OpenTool[] {
  try {
    const v = parseJson(sessionStorage.getItem(KEY) ?? "[]")
    return Array.isArray(v) ? v.filter(isOpenTool) : []
  } catch {
    return []
  }
}

function save(open: OpenTool[]) {
  try {
    sessionStorage.setItem(KEY, toJson(open))
  } catch {
    /* ignore */
  }
}

export const useOpenTools = createStore<ToolsState>((set) => ({
  open: load(),
  openTool: (t) => {
    const { open } = useOpenTools.getState()
    if (open.some((o) => same(o, t))) return
    const next = [...open, t]
    set({ open: next })
    save(next)
  },
  closeTool: (t) => {
    const next = useOpenTools.getState().open.filter((o) => !same(o, t))
    set({ open: next })
    save(next)
  },
}))

let timer: ReturnType<typeof setInterval> | undefined

const tick = () => {
  for (const t of useOpenTools.getState().open) rpc(t.hostId, "terminal.keepalive", { task_id: TaskId.make(t.taskId), tool: t.toolId }).catch(() => {})
}

/** Keep every open tool's session alive while the app is open. */
export function startToolKeepalive() {
  if (timer) return
  tick()
  timer = setInterval(tick, KEEPALIVE_MS)
}
