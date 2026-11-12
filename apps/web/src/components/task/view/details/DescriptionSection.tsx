import { splitAttachments, type HostTask as Task } from "@huntaway/client"
import { clsx } from "clsx"
import { useMemo, useState } from "react"
import { Exit } from "effect"
import { exitError, useMutation } from "../../../../state/mutation"
import { Button, isSubmitShortcut, SUBMIT_KEYS, Textarea } from "../../../ui"
import { AttachmentList } from "../../Attachments"
import { Markdown } from "../../thread/Markdown"
import { Section } from "./Section"

/** The task's description, to edit. */
export function DescriptionSection({ task }: { task: Task }) {
  const [editingDesc, setEditingDesc] = useState(false)
  const [desc, setDesc] = useState(task.description)
  const [err, setErr] = useState<string | null>(null)
  // The description as it was when editing started: if it changes meanwhile, the edit stays, and says so.
  const [descBase, setDescBase] = useState(task.description)
  const editDesc = () => {
    setDesc(task.description)
    setDescBase(task.description)
    setErr(null)
    setEditingDesc(true)
  }
  const [, update] = useMutation("tasks.update")
  const saveDesc = () => {
    setErr(null)
    void update(task.host_id, { id: task.id, patch: { description: desc } }).then((exit) => {
      const why = exitError(exit)
      if (Exit.isSuccess(exit)) setEditingDesc(false)
      else if (why !== null) setErr(`Couldn't save the description: ${why}`)
    })
  }
  return (
    <Section
      title="Description"
      right={
        !editingDesc && (
          <button className="text-[11.5px] text-faint hover:text-fg" aria-label="Edit description" onClick={editDesc}>
            Edit
          </button>
        )
      }
    >
      {editingDesc ? (
        <div className="space-y-2" data-draft={desc !== task.description || undefined}>
          <Textarea
            rows={10}
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            onKeyDown={(e) => {
              if (!isSubmitShortcut(e)) return
              e.preventDefault()
              saveDesc()
            }}
            autoFocus
          />
          {task.description !== descBase && (
            <div className="text-[11.5px] text-amber-200/90">It was changed while you were editing it: saving replaces that change.</div>
          )}
          {err && <div className="rounded bg-red-500/10 p-2 text-[11.5px] whitespace-pre-wrap text-red-300">{err}</div>}
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDesc(task.description)
                setErr(null)
                setEditingDesc(false)
              }}
            >
              Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={saveDesc}>
              Save <span className="font-normal text-white/60 touch:hidden">{SUBMIT_KEYS}</span>
            </Button>
          </div>
        </div>
      ) : task.description.trim() ? (
        <Description text={task.description} hostId={task.host_id} />
      ) : (
        <div className="text-[12.5px] text-faint">No description.</div>
      )}
    </Section>
  )
}

/** A task's description, with the files attached to it shown rather than listed. */
function Description({ text, hostId }: { text: string; hostId: string }) {
  const { text: body, files } = useMemo(() => splitAttachments(text), [text])
  return (
    <div className="text-[12.5px]">
      <Markdown text={body} />
      <AttachmentList hostId={hostId} files={files} className={clsx(body && "mt-2")} />
    </div>
  )
}
