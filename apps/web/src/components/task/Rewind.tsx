// Rewinding a task to before one of its turns: its files go back to the checkpoint taken before the turn, and optionally
// its branch and its agent's conversation (on the agent's next run). The composer's `/rewind` (HE-101) lists the
// messages to pick from first.
import { History, Loader2 } from "lucide-react"
import { clsx } from "clsx"
import { Exit } from "effect"
import { useState, type KeyboardEvent } from "react"
import { splitAttachments, type HostTask as Task } from "@huntaway/client"
import type { RewindResult, Turn } from "@huntaway/contracts"
import { composerDraftAtom, composerDraftKey } from "../../state/drafts"
import { useMutation } from "../../state/mutation"
import { registry } from "../../state/registry"
import { Ago, Button, Modal } from "../ui"
import { rewindChoices } from "./rewindCommand"
import { hasTurns, turnStat, useTurns } from "./turns"

const short = (sha: string) => sha.slice(0, 8)

/** Asks how far to rewind to before `turn`, and does it. `head` is the worktree's HEAD now. */
export function RewindDialog({
  task,
  turn,
  head,
  onClose,
  onDone,
}: {
  task: Task
  turn: Turn
  head: string | null | undefined
  onClose: () => void
  /** After it's done, with whether the conversation went back too. */
  onDone?: ((r: RewindResult, conversation: boolean) => void) | undefined
}) {
  const [{ busy, error: err }, rewind] = useMutation("checkpoints.rewind")
  const convo = turn.rewind.ok ? turn.rewind.conversation : null
  const [conversation, setConversation] = useState(!!convo?.ok)
  // The branch has moved on since: commits were made (or pulled) after the turn started.
  const beforeHead = turn.before_head
  const moved = !!beforeHead && !!head && beforeHead !== head
  const [branch, setBranch] = useState(false)
  const submit = () => {
    if (busy || turn.message_id === null) return
    const back = conversation && !!convo?.ok
    void rewind(task.host_id, { task_id: task.id, message_id: turn.message_id, conversation: back, branch: moved && branch }).then((exit) => {
      if (!Exit.isSuccess(exit)) return
      onDone?.(exit.value, back)
      onClose()
    })
  }
  return (
    <Modal title={`Rewind to before turn ${turn.turn}`} onClose={onClose} onSubmit={submit}>
      <div className="space-y-3 text-[13px]">
        <div className="line-clamp-4 border-l-2 border-line-strong pl-2.5 whitespace-pre-wrap text-muted">{turn.text || "(no message)"}</div>
        <p className="text-muted">
          The worktree's files go back to how they were before this message. Files git ignores (build output) are left alone, and the files as they are now are
          kept in a git ref, in case.
        </p>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-0.5 accent-accent"
            disabled={!convo?.ok}
            checked={conversation && !!convo?.ok}
            onChange={(e) => setConversation(e.target.checked)}
          />
          <span>
            {!convo?.ok
              ? "The agent's conversation can't go back"
              : convo.fresh
                ? "Start the agent's conversation over: this message began it"
                : "Take the agent's conversation back too, so it carries on from before this message"}
            <span className="block text-[11.5px] text-faint">
              {convo && !convo.ok
                ? `${convo.reason}. Only the files are rewound; the agent still remembers what came after.`
                : "Your next message goes to it from there. The thread keeps what came after, marked as rewound."}
            </span>
          </span>
        </label>
        {moved && (
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-0.5 accent-accent" checked={branch} onChange={(e) => setBranch(e.target.checked)} />
            <span>
              Move the branch back to <span className="font-mono">{short(beforeHead)}</span> too
              <span className="block text-[11.5px] text-faint">
                It's at <span className="font-mono">{short(head)}</span> now. Moving it drops the commits made since from the branch (the reflog still has
                them); if they're pushed, the next push has to force. Left as it is, those commits stay and the files show as changes undoing them.
              </span>
            </span>
          </label>
        )}
        {err && <div className="rounded bg-red-500/10 p-2 text-[12px] whitespace-pre-wrap text-red-300">{err}</div>}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={busy} onClick={submit}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <History size={13} />} Rewind
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/** Over the composer: the agent's next run takes its conversation back to before a turn. */
export function RewindNote({ task }: { task: Task }) {
  const [{ error: err }, cancelRewind] = useMutation("checkpoints.cancelRewind")
  if (!task.rewind) return null
  const keep = () => void cancelRewind(task.host_id, { task_id: task.id })
  return (
    <div className="mb-2 flex items-start gap-2 rounded-lg border border-line bg-panel px-3 py-2 text-[12px] text-muted">
      <History size={13} className="mt-0.5 shrink-0 text-accent" />
      <span className="min-w-0 flex-1">
        The agent's next run carries on from before turn {task.rewind.turn}: its conversation won't have that message or what came after.
        {err && <span className="block text-red-400">{err}</span>}
      </span>
      <button className="shrink-0 text-faint hover:text-fg" onClick={keep} title="Keep the whole conversation: only the files were rewound">
        Keep the conversation
      </button>
    </div>
  )
}

/**
 * After a rewind that took the conversation back: the message rewound to goes into the task's composer (ahead of what's
 * there), to edit and send again. Not the board's own messages (a review's issues, say).
 */
export function rewound(task: Task, r: RewindResult, conversation: boolean) {
  if (!conversation || r.message.auto || !r.message.text?.trim()) return
  const { text, files } = splitAttachments(r.message.text.trim())
  const atom = composerDraftAtom(composerDraftKey(task))
  const d = registry.get(atom)
  registry.set(atom, { text: d?.text.trim() ? `${text}\n\n${d.text}` : text, files: [...files, ...(d?.files ?? [])] })
}

/** Up and Down move between the list's buttons. */
function arrows(e: KeyboardEvent<HTMLElement>) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return
  const all = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"))
  if (!all.length) return
  e.preventDefault()
  const at = all.findIndex((b) => b === document.activeElement)
  const next = e.key === "ArrowDown" ? (at + 1) % all.length : (at - 1 + all.length) % all.length
  all[at === -1 ? 0 : next]?.focus()
}

/** The messages `/rewind` can go back to before, newest first; picking one asks how far, as the thread's mark does. */
function RewindPicker({ task, onPick, onClose }: { task: Task; onPick: (t: Turn) => void; onClose: () => void }) {
  const { data, error } = useTurns(task)
  const choices = data ? rewindChoices(data.turns) : []
  const firstOk = choices.findIndex((t) => t.rewind.ok)
  const why = !hasTurns(task)
    ? "This thread has no checkpoints to go back to: only a task with a worktree of its own keeps them."
    : error
      ? `Couldn't read the task's turns: ${error}`
      : data && !data.available
        ? `There's nothing to rewind: ${data.reason}.`
        : data && !choices.length
          ? "There are no messages to go back to yet."
          : null
  return (
    <Modal title="Rewind" onClose={onClose}>
      <div className="space-y-3 text-[13px]">
        <p className="text-muted">
          Go back to before one of your messages to reword it: the message comes back here to change and send again, and the worktree's files go back to how
          they were before it.
        </p>
        {why ? (
          <p className="text-faint">{why}</p>
        ) : !data ? (
          <p className="flex items-center gap-2 text-faint">
            <Loader2 size={13} className="animate-spin" /> Loading the messages…
          </p>
        ) : (
          <div role="group" aria-label="Messages to rewind to" className="-mx-1 space-y-1" onKeyDown={arrows}>
            {choices.map((t, i) => (
              <button
                key={t.n}
                disabled={!t.rewind.ok}
                autoFocus={i === firstOk}
                onClick={() => onPick(t)}
                title={t.rewind.ok ? "Rewind to before this message" : t.rewind.reason}
                className={clsx(
                  "block w-full rounded-lg border border-transparent px-2.5 py-1.5 text-left outline-none",
                  t.rewind.ok ? "hover:bg-white/5 focus-visible:border-accent/60 focus-visible:bg-white/5" : "cursor-not-allowed opacity-50",
                )}
              >
                <span className="flex items-center gap-2 text-[11.5px] text-faint">
                  <span>Turn {t.turn}</span>
                  <Ago at={t.at} />
                  {turnStat(t) && <span>{turnStat(t)}</span>}
                  {t.auto && <span>from the board</span>}
                </span>
                <span className="line-clamp-2 whitespace-pre-wrap text-fg">{t.text || "(no message)"}</span>
                {!t.rewind.ok && <span className="block text-[11.5px] text-faint">{t.rewind.reason}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}

/**
 * `/rewind`: the messages to pick from, then how far to go back to before the one picked (its Cancel goes back to the
 * list). Once it's done, the message is in the composer to reword (`rewound`).
 */
export function RewindCommand({ task, onClose }: { task: Task; onClose: () => void }) {
  const [picked, setPicked] = useState<Turn | null>(null)
  const { data } = useTurns(task)
  if (!picked) return <RewindPicker task={task} onPick={setPicked} onClose={onClose} />
  return (
    <RewindDialog
      task={task}
      turn={picked}
      head={data?.available ? data.head : null}
      onClose={() => setPicked(null)}
      onDone={(r, convo) => {
        rewound(task, r, convo)
        onClose()
      }}
    />
  )
}
