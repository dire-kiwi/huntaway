// The dialog that edits a document's labels, from its row in the tree or from its page.
import { Loader2, X } from "lucide-react"
import { useEffect, useId, useState } from "react"
import { ProfileId, type DocLabelNode } from "@huntaway/contracts"
import { rpc } from "../../../state/rpc"
import type { DocsHome } from "../docs"
import { Button, ErrorBox, Field, Input, Modal, ModalFooter, useAsyncAction } from "../../ui"

/** Every label of a host's label tree, the labels inside them included. */
const flatLabels = (nodes: ReadonlyArray<DocLabelNode>): string[] => nodes.flatMap((n) => [n.path, ...flatLabels(n.children)])

/**
 * A dialog that edits a document's labels: each a chip to remove, and a field that adds one, suggesting the labels
 * there are (`suggested`, else the host's, which it loads).
 */
export function LabelsDialog({
  title,
  initial,
  suggested,
  home,
  onSave,
  onDone,
  onClose,
}: {
  title: string
  initial: ReadonlyArray<string>
  suggested?: string[]
  /** Where to load the labels to suggest from, without `suggested`. */
  home?: DocsHome
  onSave: (labels: ReadonlyArray<string>) => Promise<unknown>
  onDone: () => void
  onClose: () => void
}) {
  const [labels, setLabels] = useState(initial)
  const [text, setText] = useState("")
  const [loaded, setLoaded] = useState<string[]>([])
  const run = useAsyncAction()
  const listId = useId()
  useEffect(() => {
    if (suggested || !home) return undefined
    let live = true
    rpc(home.hostId, "docs.labels", { profile_id: ProfileId.make(home.profileId) }).then(
      (t) => live && setLoaded(flatLabels(t.labels)),
      () => {},
    )
    return () => {
      live = false
    }
  }, [suggested, home])
  /** The labels with what's typed added (each '/'-separated segment trimmed), once whatever its case. */
  const withText = (list: ReadonlyArray<string>): ReadonlyArray<string> => {
    const l = text
      .split("/")
      .map((seg) => seg.trim())
      .filter(Boolean)
      .join("/")
    return l === "" || list.some((x) => x.toLowerCase() === l.toLowerCase()) ? list : [...list, l]
  }
  const add = () => {
    setLabels(withText(labels))
    setText("")
  }
  const save = () =>
    void run.run(async () => {
      // What's typed but not added yet is saved too.
      await onSave(withText(labels))
      onDone()
      onClose()
    })
  const options = (suggested ?? loaded).filter((o) => !labels.some((l) => l.toLowerCase() === o.toLowerCase()))
  return (
    <Modal title={title} onClose={onClose} onSubmit={save} width="max-w-md">
      <form
        className="space-y-4 text-[13px]"
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <div className="flex min-h-7 flex-wrap gap-1.5" aria-label="Labels">
          {labels.length ? (
            labels.map((l) => (
              <span key={l} className="flex max-w-full items-center gap-1 rounded bg-white/[0.06] py-0.5 pr-0.5 pl-2 text-[12px] text-fg">
                <span className="truncate">{l}</span>
                <button
                  type="button"
                  title={`Remove ${l}`}
                  onClick={() => setLabels(labels.filter((x) => x !== l))}
                  className="rounded p-0.5 text-faint hover:bg-white/10 hover:text-fg"
                >
                  <X size={12} />
                </button>
              </span>
            ))
          ) : (
            <span className="text-faint">No labels.</span>
          )}
        </div>
        <Field label="Add a label" hint="A label like research/ai is inside research, and shows under it in the Labels view. Press Enter to add it.">
          <div className="flex gap-2">
            <Input
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter" || e.nativeEvent.isComposing || e.ctrlKey || e.metaKey || !text.trim()) return
                e.preventDefault()
                add()
              }}
              list={listId}
              placeholder="research/ai"
              aria-label="New label"
            />
            <Button type="button" onClick={add} disabled={!text.trim()}>
              Add
            </Button>
          </div>
          <datalist id={listId}>
            {options.map((o) => (
              <option key={o} value={o} />
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
              {run.busy && <Loader2 size={13} className="animate-spin" />} Save
            </Button>
          </div>
        </ModalFooter>
      </form>
    </Modal>
  )
}
