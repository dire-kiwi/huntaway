// The dialog a home's tree asks for a folder's path with: to move a document, or to rename a folder.
import { Loader2 } from "lucide-react"
import { useId, useState } from "react"
import { Button, ErrorBox, Field, Input, Modal, ModalFooter, useAsyncAction } from "../../ui"

/** A dialog that asks for a folder's path, suggesting the folders there are. */
export function FolderDialog({
  title,
  initial,
  folders,
  action,
  hint,
  onSave,
  onDone,
  onClose,
}: {
  title: string
  initial: string
  folders: string[]
  action: string
  hint: string
  onSave: (folder: string) => Promise<unknown>
  onDone: () => void
  onClose: () => void
}) {
  const [folder, setFolder] = useState(initial)
  const run = useAsyncAction()
  const listId = useId()
  const save = () =>
    void run.run(async () => {
      await onSave(folder)
      onDone()
      onClose()
    })
  return (
    <Modal title={title} onClose={onClose} onSubmit={save} width="max-w-md">
      <form
        className="space-y-4 text-[13px]"
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <Field label="Folder" hint={hint}>
          <Input autoFocus value={folder} onChange={(e) => setFolder(e.target.value)} list={listId} placeholder="Top level" aria-label="Folder" />
          <datalist id={listId}>
            {folders.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </Field>
        <ModalFooter className="space-y-3">
          {run.error && <ErrorBox>{run.error}</ErrorBox>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={run.busy}>
              {run.busy && <Loader2 size={13} className="animate-spin" />} {action}
            </Button>
          </div>
        </ModalFooter>
      </form>
    </Modal>
  )
}
