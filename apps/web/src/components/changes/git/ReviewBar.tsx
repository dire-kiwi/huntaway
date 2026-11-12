import { clsx } from "clsx"
import { ChevronDown, ChevronRight, Loader2, MessageSquare, X } from "lucide-react"
import { useState } from "react"
import { runningAgentSteers, type HostTask as Task } from "@huntaway/client"
import { dropDraft, lineRange, removeComments, sendComments, type CommentLines, type Review } from "../lineComments"
import { exitError, useAction } from "../../../state/mutation"
import { Button } from "../../ui"

/**
 * The comments for the agent that haven't been sent: how many, a list of them (each one goes to its lines), and a
 * button that sends them all as one message, as the thread's composer would (queued or steered while the agent works).
 */
export function ReviewBar({
  task,
  review,
  onJump,
  onDiscard,
  onError,
}: {
  task: Task
  review: Review
  onJump: (c: CommentLines, anchorId: string) => void
  onDiscard: () => void
  onError: (text: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [{ busy: sending }, run] = useAction()
  const { comments, drafts } = review
  if (!comments.length && !drafts.length) return null
  // Every host on this server takes messages while the agent is running: steered, or queued.
  const queue = task.running && (!runningAgentSteers(task) || !!task.queued_message)
  const send = () =>
    void run(sendComments(task, comments)).then((exit) => {
      const failed = exitError(exit)
      if (failed !== null) onError(`Couldn't send the comments: ${failed}`)
      else setOpen(false)
    })
  const unfinished = drafts.filter((d) => !d.of)
  return (
    <div className="shrink-0 border-t border-line font-sans text-[12px]" data-review>
      {open && (
        <div className="max-h-48 overflow-y-auto border-b border-line py-1">
          {[
            ...comments.map((c) => ({ c, anchor: c.id, draft: drafts.some((d) => d.of === c.id) })),
            ...unfinished.map((d) => ({ c: d, anchor: d.id, draft: true })),
          ].map(({ c, anchor, draft }) => (
            <div key={anchor} className="group flex items-baseline gap-2 px-3 py-0.5 hover:bg-white/[0.04]">
              <button
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onJump(c, anchor)}
                className="flex min-w-0 flex-1 items-baseline gap-2 text-left"
              >
                <span className="shrink-0 font-mono text-[11.5px] text-muted">
                  {c.path}, {lineRange(c)}
                </span>
                <span className="shrink-0 text-[11px] text-faint">{c.source}</span>
                <span className={clsx("min-w-0 truncate", draft ? "text-amber-300" : "text-fg")}>
                  {draft ? (c.note.trim() ? `${c.note} (being written)` : "(being written)") : c.note}
                </span>
              </button>
              <button
                tabIndex={-1}
                title="Delete the comment"
                onMouseDown={(e) => e.preventDefault()}
                // One being written may be where it can't be seen any more (its lines changed): it goes from here.
                onClick={() =>
                  anchor === c.id && drafts.some((d) => d.id === c.id) ? dropDraft(task.host_id, task.id, c.id) : removeComments(task.host_id, task.id, [c.id])
                }
                className="shrink-0 self-center rounded text-faint opacity-0 group-hover:opacity-100 hover:text-red-300"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex h-8 items-center gap-2 px-2">
        <button
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1.5 text-muted hover:text-fg"
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <MessageSquare size={12} className="text-accent" />
          {comments.length ? `${comments.length} comment${comments.length === 1 ? "" : "s"} for the agent` : "No comments added yet"}
          {unfinished.length > 0 && <span className="text-amber-300">· {unfinished.length} being written</span>}
        </button>
        <span className="truncate text-[11px] text-faint">also in the thread's composer, to send with a message</span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <Button size="sm" onMouseDown={(e) => e.preventDefault()} onClick={onDiscard}>
            Discard
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={!comments.length || sending}
            title={queue ? "Queued: the agent gets them when it finishes" : "Sends them to the agent as one message"}

            onMouseDown={(e) => e.preventDefault()}
            onClick={send}
          >
            {sending && <Loader2 size={12} className="animate-spin" />}
            {queue ? "Queue for the agent" : "Send to the agent"}
          </Button>
        </div>
      </div>
    </div>
  )
}
