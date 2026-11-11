import { useState, type FormEvent } from "react"
import { Button, errorText, Input, Modal, ModalFooter } from "../../ui"

/** Names a new group, or renames one. */
export function GroupNameModal({
  title,
  initial,
  onSave,
  onClose,
}: {
  title: string
  initial: string
  onSave: (name: string) => Promise<void>
  onClose: () => void
}) {
  const [name, setName] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const submit = async (e?: FormEvent) => {
    e?.preventDefault()
    if (!name.trim() || busy) return
    setBusy(true)
    setErr(null)
    try {
      await onSave(name.trim())
      onClose()
    } catch (error) {
      setErr(errorText(error))
      setBusy(false)
    }
  }
  return (
    <Modal title={title} onClose={onClose} onSubmit={() => void submit()} width="max-w-sm">
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <Input autoFocus value={name} placeholder="Group name" maxLength={100} onChange={(e) => setName(e.target.value)} />
        <ModalFooter className="space-y-4">
          {err && <div className="text-xs text-red-400">{err}</div>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
              Save
            </Button>
          </div>
        </ModalFooter>
      </form>
    </Modal>
  )
}
