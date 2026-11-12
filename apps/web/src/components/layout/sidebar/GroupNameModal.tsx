import { type Effect, Exit } from "effect"
import { type AtomRegistry } from "effect/reactivity"
import { useState, type FormEvent } from "react"
import { type CallError } from "@huntaway/client"
import { useAction } from "../../../state/mutation"
import { Button, Input, Modal, ModalFooter } from "../../ui"

/** Names a new group, or renames one. */
export function GroupNameModal({
  title,
  initial,
  onSave,
  onClose,
}: {
  title: string
  initial: string
  /** What saving the name does: the dialog runs it, closes once it worked and shows why it didn't. */
  onSave: (name: string) => Effect.Effect<void, CallError<"projects.update">, AtomRegistry.AtomRegistry>
  onClose: () => void
}) {
  const [name, setName] = useState(initial)
  const [{ busy, error: err }, run] = useAction()
  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    if (!name.trim() || busy) return
    void run(onSave(name.trim())).then((exit) => {
      if (Exit.isSuccess(exit)) onClose()
    })
  }
  return (
    <Modal title={title} onClose={onClose} onSubmit={() => submit()} width="max-w-sm">
      <form onSubmit={(e) => submit(e)} className="space-y-4">
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
