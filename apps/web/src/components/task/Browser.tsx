import type { HostTask as Task } from "@huntaway/client"
import { clsx } from "clsx"
import { Globe } from "lucide-react"
import { useBoard } from "../../state/board"
import { IconButton } from "../ui"
import { BrowserStream } from "./BrowserStream"
import { BrowserWebview, paneDebugger } from "./BrowserWebview"

// HE-62: the task's own web browser, beside its thread (after the old pane, HA-275): the page its agent drives with the
// `browser` MCP server. In the desktop app, for a task on the app's own host, it is the app's <webview>, given to the
// server to drive (BrowserWebview); everywhere else it is the host's headless Chrome, streamed (BrowserStream).

export function BrowserButton({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <IconButton
      title={open ? "Close the browser" : "The task's browser, beside the thread"}
      aria-pressed={open}
      className={clsx("border border-line bg-panel", open && "bg-raised! text-fg")}
      onClick={onClick}
    >
      <Globe size={14} />
    </IconButton>
  )
}

/**
 * The task's browser: the desktop app's own for a task on its host (kept while the pane is closed, so its page stays),
 * else the host's, streamed while the pane is open (the page stays on the host).
 */
export function BrowserPane({ task, visible, onClose }: { task: Task; visible: boolean; onClose: () => void }) {
  const local = useBoard((s) => s.localHostId)
  if (paneDebugger() !== null && task.host_id === local) return <BrowserWebview task={task} onClose={onClose} />
  return visible ? <BrowserStream task={task} onClose={onClose} /> : null
}

export { useBrowserShare } from "./BrowserBar"
