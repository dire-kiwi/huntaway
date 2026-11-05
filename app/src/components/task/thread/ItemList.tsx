import clsx from "clsx";
import { History } from "lucide-react";
import { createContext, memo, useContext, useMemo } from "react";
import { isWorkflowApproval, type Turn } from "../../../api";
import { splitAttachments } from "../../../attachments";
import type { Item } from "../../../threadModel";
import { AutomationChangeCard, ProjectChangeCard, TaskDeletionCard, WorkflowChangeCard } from "../Approvals";
import { AttachmentList } from "../Attachments";
import { CompactLine, EventLine, PromptCard, QuestionRow, ResultLine, Thinking } from "./items";
import { Markdown } from "./Markdown";
import { ToolGroup } from "./tools";

// Memoized: the thread redraws for changes to its task (e.g. its context use), which leave the items as they were.
export const ItemList = memo(function ItemList({ items, running, hostId, cwd }: { items: Item[]; running: boolean; hostId: string; cwd?: string | null }) {
  return (
    <>
      {items.map((it) => (
        <Row key={it.key} it={it} running={running} hostId={hostId} cwd={cwd} />
      ))}
    </>
  );
});

/** The thread's turns with checkpoints, by the message each started with, and how to rewind to before one (API 70). */
export const TurnsCtx = createContext<{ byMessage: Map<number, Turn>; rewind: (t: Turn) => void } | null>(null);

/** Beside a user message that started a turn: rewind the task to before it, or that it was rewound. */
function RewindMark({ id }: { id: string }) {
  const turns = useContext(TurnsCtx);
  const turn = turns?.byMessage.get(Number(id));
  if (!turns || !turn) return null;
  if (turn.stale)
    return (
      <span className="mr-2 self-center text-[11px] text-faint" title="A rewind went back to before this message">
        rewound
      </span>
    );
  if (!turn.rewind.ok) return null;
  return (
    <button
      className="mr-1 self-center rounded p-1 text-faint opacity-0 group-hover:opacity-100 hover:bg-white/5 hover:text-fg focus:opacity-100"
      title="Rewind to here: put the files back to how they were before this message"
      aria-label="Rewind to here"
      onClick={() => turns.rewind(turn)}
    >
      <History size={13} />
    </button>
  );
}

/** Memoized: a new message leaves the items it doesn't change as they were (see buildModel), and their rows with them. */
const Row = memo(function Row({ it, running, hostId, cwd }: { it: Item; running: boolean; hostId: string; cwd?: string | null }) {
  switch (it.type) {
    case "user":
      return (
        <div className="group flex justify-end">
          <RewindMark id={it.key} />
          <div
            title={it.steered ? "Sent while the agent was working; it read it here" : undefined}
            className={clsx(
              "max-w-[85%] rounded-2xl rounded-br-md border px-3.5 py-2 text-[13.5px] whitespace-pre-wrap narrow:break-words",
              it.auto ? "border-line bg-transparent text-muted italic" : "border-line-strong bg-raised",
            )}
          >
            <UserText text={it.text} hostId={hostId} />
          </div>
        </div>
      );
    case "text":
      return <Markdown text={it.text} />;
    case "thinking":
      return <Thinking text={it.text} />;
    case "tools":
      return <ToolGroup calls={it.calls} running={running} cwd={cwd} />;
    case "event":
      return <EventLine level={it.level} text={it.text} detail={it.detail} />;
    case "permission":
      if (it.data.kind === "project") return <ProjectChangeCard data={it.data} hostId={hostId} />;
      if (it.data.kind === "delete_task") return <TaskDeletionCard data={it.data} hostId={hostId} />;
      if (isWorkflowApproval(it.data)) return <WorkflowChangeCard data={it.data} hostId={hostId} />;
      if (it.data.kind === "automation") return <AutomationChangeCard data={it.data} hostId={hostId} />;
      return <PromptCard id={Number(it.key)} data={it.data} hostId={hostId} />;
    case "question":
      return <QuestionRow id={it.id} data={it.data} hostId={hostId} />;
    case "result":
      return <ResultLine data={it.data} />;
    case "compact":
      return <CompactLine meta={it.meta} summary={it.summary} result={it.result} />;
  }
});

/** A user message: its text, and the files attached to it. */
function UserText({ text, hostId }: { text: string; hostId: string }) {
  const { text: body, files } = useMemo(() => splitAttachments(text), [text]);
  return (
    <>
      {body}
      <AttachmentList hostId={hostId} files={files} className={clsx(body && "mt-2")} />
    </>
  );
}
