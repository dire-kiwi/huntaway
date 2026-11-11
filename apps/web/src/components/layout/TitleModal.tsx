import { useState, type FormEvent } from "react"
import { type HostTask as Task } from "@huntaway/client"
import { Button, errorText, Input, Modal, ModalFooter, type MenuItem } from "../ui"
import { rpc } from "../../state/rpc"

/** The menu item that opens the task's title in a {@link TitleModal}. */
export const titleItem = (onPick: () => void, divider = false): MenuItem => ({ label: "Set title…", divider, onSelect: onPick })

/**
 * Renames a task by hand. Like a rename from its header, that pins the title, so it no longer
 * follows the task's messages.
 */
export function TitleModal({ task, onClose }: { task: Task; onClose: () => void }) {
  const [title, setTitle] = useState(task.title)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const save = async (e?: FormEvent) => {
    e?.preventDefault()
    if (!title.trim() || busy) return
    if (title.trim() === task.title) {
      onClose()
      return
    }
    setBusy(true)
    setErr(null)
    try {
      await rpc(task.host_id, "tasks.update", { id: task.id, patch: { title: title.trim() } })
      onClose()
    } catch (error) {
      setErr(`Couldn't rename the task: ${errorText(error)}`)
      setBusy(false)
    }
  }
  return (
    <Modal title="Set title" onClose={onClose} onSubmit={() => void save()} width="max-w-md">
      <form onSubmit={(e) => void save(e)} className="space-y-3">
        <Input autoFocus value={title} aria-label="Title" onChange={(e) => setTitle(e.target.value)} onFocus={(e) => e.currentTarget.select()} />
        <div className="text-[12px] text-faint">A title set by hand stays as it is, rather than following your messages.</div>
        <ModalFooter className="space-y-3">
          {err && <div className="text-xs text-red-400">{err}</div>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy || !title.trim()}>
              Save
            </Button>
          </div>
        </ModalFooter>
      </form>
    </Modal>
  )
}
