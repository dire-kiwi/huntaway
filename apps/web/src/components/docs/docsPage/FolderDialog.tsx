// The dialog a home's tree asks for a folder's path with: to move a document, or to rename a folder.
import { Loader2 } from "lucide-react"
import { Exit, type Effect } from "effect"
import type { AtomRegistry } from "effect/reactivity"
import { useId, useState } from "react"
import type { CallError } from "@huntaway/client"
import { useAction } from "../../../state/mutation"
import { Button, ErrorBox, Field, Input, Modal, ModalFooter } from "../../ui"

/** A dialog that asks for a folder's path, suggesting the folders there are; `onSave`'s change closes it once it's made. */
export function FolderDialog({
  title,
  initial,
  folders,
  action,
  hint,
  onSave,
  onClose,
}: {
  title: string
  initial: string
  folders: string[]
  action: string
  hint: string
  onSave: (folder: string) => Effect.Effect<unknown, CallError<"docs.update" | "docs.renameFolder">, AtomRegistry.AtomRegistry>
  onClose: () => void
}) {
  const [folder, setFolder] = useState(initial)
  const [run, start] = useAction()
  const listId = useId()
  const save = () =>
    void start(onSave(folder)).then((exit) => {
      if (Exit.isSuccess(exit)) onClose()
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
