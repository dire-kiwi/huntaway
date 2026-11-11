import { Archive } from "lucide-react"
import { useState } from "react"
import type { HostProject as Project } from "@huntaway/client"
import { parse } from "../../router"
import { navigate } from "../../state/route"
import { Button, errorText, Modal, ModalFooter } from "../ui"
import { rpc } from "../../state/rpc"
import { board } from "../../state/board"

// The Settings panel of archived projects (`ArchivedProjectsPanel`) comes with settings/ on this server.

/**
 * Archives `project`: it goes off the board (the sidebar, its profile's and group's boards, agents'
 * project lists) until it's unarchived in Settings. Leaves a page about the project for the home page.
 */
export function ArchiveProjectModal({ project, onClose }: { project: Project; onClose: () => void }) {
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const archive = async () => {
    setErr(null)
    setBusy(true)
    try {
      await rpc(project.host_id, "projects.update", { id: project.id, patch: { archived: true } })
      const s = board.get()
      const route = parse(window.location.pathname)
      const panel = new URLSearchParams(window.location.search).get("task")
      const taskId = route.name === "task" ? route.taskId : panel
      const here = ("projectId" in route && route.projectId === project.id) || (!!taskId && s.tasks[taskId]?.project_id === project.id)
      onClose()
      if (here) navigate({ name: "home" }, true)
    } catch (e) {
      setErr(errorText(e))
      setBusy(false)
    }
  }
  return (
    <Modal title={`Archive ${project.name}`} onClose={onClose}>
      <p className="mb-4 text-[13px] text-muted">
        The project goes off the board: out of the sidebar, the inbox and its group, and agents can&apos;t add tasks to it. Its tasks, worktrees and branches
        are kept. To bring it back, unarchive it in Settings → Archived projects.
      </p>
      <ModalFooter>
        {err && <div className="mb-3 text-xs text-red-400">{err}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void archive()}>
            <Archive size={13} /> Archive project
          </Button>
        </div>
      </ModalFooter>
    </Modal>
  )
}
