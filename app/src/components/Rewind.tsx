// Rewinding a task to before one of its turns (API 67): its files go back to the checkpoint taken
// before the turn, and optionally its branch and its agent's conversation (on the agent's next run).
import { History, Loader2 } from "lucide-react";
import { useState } from "react";
import { api, type RewindResult, type Task, type Turn } from "../api";
import { Button, Modal } from "./ui";

const short = (sha: string) => sha.slice(0, 8);

/** Asks how far to rewind to before `turn`, and does it. `head` is the worktree's HEAD now. */
export function RewindDialog({
  task,
  turn,
  head,
  onClose,
  onDone,
}: {
  task: Task;
  turn: Turn;
  head: string | null | undefined;
  onClose: () => void;
  /** After it's done, with whether the conversation went back too. */
  onDone?: (r: RewindResult, conversation: boolean) => void;
}) {
  const convo = turn.rewind.ok ? turn.rewind.conversation : null;
  const [conversation, setConversation] = useState(!!convo?.ok);
  // The branch has moved on since: commits were made (or pulled) after the turn started.
  const moved = !!turn.before_head && !!head && turn.before_head !== head;
  const [branch, setBranch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    if (busy || turn.message_id === null) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.rewind(task.host_id, task.id, { message_id: turn.message_id, conversation: conversation && !!convo?.ok, branch: moved && branch });
      onDone?.(r, conversation && !!convo?.ok);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title={`Rewind to before turn ${turn.turn}`} onClose={onClose} onSubmit={submit}>
      <div className="space-y-3 text-[13px]">
        <div className="line-clamp-4 border-l-2 border-line-strong pl-2.5 whitespace-pre-wrap text-muted">{turn.text || "(no message)"}</div>
        <p className="text-muted">
          The worktree's files go back to how they were before this message. Files git ignores (build output) are left alone, and the files as
          they are now are kept in a git ref, in case.
        </p>
        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-0.5 accent-accent" disabled={!convo?.ok} checked={conversation && !!convo?.ok} onChange={(e) => setConversation(e.target.checked)} />
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
              Move the branch back to <span className="font-mono">{short(turn.before_head!)}</span> too
              <span className="block text-[11.5px] text-faint">
                It's at <span className="font-mono">{short(head!)}</span> now. Moving it drops the commits made since from the branch (the reflog
                still has them); if they're pushed, the next push has to force. Left as it is, those commits stay and the files show as changes
                undoing them.
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
  );
}

/** Over the composer: the agent's next run takes its conversation back to before a turn. */
export function RewindNote({ task }: { task: Task }) {
  const [err, setErr] = useState<string | null>(null);
  if (!task.rewind) return null;
  const keep = () => {
    setErr(null);
    api.cancelRewind(task.host_id, task.id).catch((e) => setErr((e as Error).message));
  };
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
  );
}
