// Huntaway's own rows in an agent-threads thread: the user's messages (with their attachments and
// where the task can be rewound to), subagents (which open full screen), and the board's messages
// that the thread doesn't have (permission prompts, request_user_input questions and events).
import type { Item, ToolCall, UserMessage } from "@dire-kiwi/agent-threads-protocol";
import { Subagent, subagentTitle, useThreadState, type ToolRowProps } from "@dire-kiwi/agent-threads-react";
import clsx from "clsx";
import { Bot, Clock, History, Maximize2 } from "lucide-react";
import { createContext, memo, useContext, useMemo, type ReactNode } from "react";
import type { Message, Turn } from "../../../api";
import { attachmentRef, splitAttachments, type AttachmentRef } from "../../../attachments";
import { QUESTION_TOOLS, questionsOf } from "../../../questions";
import { useSubagentView } from "../../../subagents";
import { AutomationChangeCard, ProjectChangeCard, TaskDeletionCard } from "../Approvals";
import { AttachmentList } from "../Attachments";
import { AskCard, BoardQuestionCard, PlanCard } from "../Questions";
import { EventLine, PermissionCard } from "../thread/items";
import { Markdown } from "../thread/Markdown";

/** What the rows need of the task: its host and id, its turns that can be rewound to by item id, and the latest message the board sent the agent. */
export interface TaskRows {
  hostId: string;
  taskId: string;
  /** A user message's first turn, by the message's item id (see userMessageIds). */
  turns: Map<string, Turn> | null;
  rewind: (t: Turn) => void;
  /** The board's id of the latest message sent to the agent: its prompts and questions from before are ones the thread moved on from. */
  lastSent: number;
}

export const TaskRowsCtx = createContext<TaskRows | null>(null);

const useRows = () => useContext(TaskRowsCtx);

export const renderMarkdown = (text: string): ReactNode => <Markdown text={text} />;

/** The package's renderItem: Huntaway's own row for a user message, the package's for the rest. */
export function renderItem(item: Item): ReactNode | undefined {
  if (item.type === "user_message") return <UserRow item={item} />;
  return undefined;
}

/** The files attached to a message: listed at the end of its text (as the composer sends them), or as the item's attachments. */
function attached(item: UserMessage): { text: string; files: AttachmentRef[]; images: { name: string; src: string }[] } {
  const { text, files } = splitAttachments(item.text);
  const images: { name: string; src: string }[] = [];
  for (const a of item.attachments ?? []) {
    const ref = a.path ? attachmentRef(a.path) : null;
    if (ref) {
      if (!files.some((f) => f.path === ref.path)) files.push(ref);
    } else if (a.kind === "image" && a.data) images.push({ name: a.name ?? "image", src: `data:${a.media_type ?? "image/png"};base64,${a.data}` });
  }
  return { text, files, images };
}

/** A message to the agent, as the board's thread draws it: on the right, with its attachments, and a mark to rewind to before it. */
const UserRow = memo(function UserRow({ item }: { item: UserMessage }) {
  const rows = useRows();
  const { text, files, images } = useMemo(() => attached(item), [item]);
  return (
    <div className="group flex flex-col items-end" data-item={item.id}>
      <div className="flex w-full justify-end">
        <RewindMark id={item.id} />
        <div
          title={item.steered ? "Sent while the agent was working; it read it here" : undefined}
          className={clsx(
            "max-w-[85%] rounded-2xl rounded-br-md border px-3.5 py-2 text-[13.5px] whitespace-pre-wrap narrow:break-words",
            item.queued ? "border-dashed border-line-strong bg-transparent text-muted" : "border-line-strong bg-raised",
          )}
        >
          {text}
          {rows && <AttachmentList hostId={rows.hostId} files={files} className={clsx(text && "mt-2")} />}
          {images.length > 0 && (
            <div className={clsx("flex flex-wrap gap-2", (text || files.length > 0) && "mt-2")}>
              {images.map((im, i) => (
                <img key={i} src={im.src} alt={im.name} className="max-h-40 max-w-[12rem] rounded-md border border-line object-cover" />
              ))}
            </div>
          )}
        </div>
      </div>
      {item.queued && (
        <div className="mt-1 flex items-center gap-1 text-[11.5px] text-faint">
          <Clock size={11} /> Waiting for the agent to read it
        </div>
      )}
    </div>
  );
});

/** Beside a user message that started a turn: rewind the task to before it, or that it was rewound. */
function RewindMark({ id }: { id: string }) {
  const rows = useRows();
  const turn = rows?.turns?.get(id);
  if (!rows || !turn) return null;
  if (turn.stale)
    return (
      <span className="mr-2 self-center text-[11px] text-faint" title="A rewind went back to before this message">
        rewound
      </span>
    );
  if (!turn.rewind.ok) return null;
  return (
    <button
      className="mr-1 self-center rounded p-1 text-faint opacity-0 group-hover:opacity-100 hover:bg-white/5 hover:text-fg focus:opacity-100 touch:opacity-100"
      title="Rewind to here: put the files back to how they were before this message"
      aria-label="Rewind to here"
      onClick={() => rows.rewind(turn)}
    >
      <History size={13} />
    </button>
  );
}

/** A subagent's row: the package's, which opens to show what it did inline, with a button that shows its own thread full screen. */
export function SubagentRow({ call }: ToolRowProps) {
  const rows = useRows();
  const show = useSubagentView((s) => s.show);
  return (
    <div className="ha-subagent-row relative">
      <Subagent call={call} />
      {rows && (
        <button
          onClick={() => show(rows.taskId, call.id)}
          title="Open its thread"
          aria-label="Open subagent thread"
          className="absolute top-[3px] right-1 rounded p-1 text-faint hover:bg-white/5 hover:text-fg"
        >
          <Maximize2 size={12} />
        </button>
      )}
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** The tool call `id` in the thread, if it's loaded. */
function findCall(items: readonly Item[], id: string): ToolCall | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.id === id) return it.type === "tool_call" ? it : undefined;
  }
  return undefined;
}

/** Which subagent a board prompt is from (by the call it's for), opening its thread; nothing for the main thread's own. */
function From({ toolUseId }: { toolUseId?: string }) {
  const rows = useRows();
  const show = useSubagentView((s) => s.show);
  const viewing = useSubagentView((s) => (rows ? s.open[rows.taskId] : undefined));
  const parent = useThreadState((s) => (toolUseId ? findCall(s.snapshot.items, toolUseId)?.parent_id : undefined));
  const sub = useThreadState((s) => (parent && parent !== viewing ? s.view.subagents.get(parent) : undefined));
  if (!sub || !rows) return null;
  return (
    <button
      onClick={() => show(rows.taskId, sub.id)}
      className="flex min-w-0 items-center gap-1 text-[12px] text-faint hover:text-muted"
      title="Open the subagent's thread"
    >
      <Bot size={12} className="shrink-0" />
      <span className="truncate">from {subagentTitle(sub.call)}</span>
    </button>
  );
}

/** One of the board's messages in the thread: a permission prompt (or the board's own approval), a question asked with request_user_input, or an event. */
export const BoardRow = memo(function BoardRow({ message: m }: { message: Message }) {
  const rows = useRows();
  if (!rows) return null;
  const { hostId, taskId } = rows;
  const movedOn = rows.lastSent > m.id;
  const data: Any = m.data;
  if (m.kind === "event") return <EventLine level={data.level} text={data.text} detail={data.detail} />;
  if (m.kind === "question") return <BoardQuestionCard id={m.id} data={data} hostId={hostId} taskId={taskId} movedOn={movedOn} />;
  if (data.kind === "project") return <ProjectChangeCard data={data} hostId={hostId} />;
  if (data.kind === "delete_task") return <TaskDeletionCard data={data} hostId={hostId} />;
  if (data.kind === "automation") return <AutomationChangeCard data={data} hostId={hostId} />;
  const from = <From toolUseId={data.tool_use_id} />;
  if (QUESTION_TOOLS.includes(data.tool_name) && questionsOf(data).length) return <AskCard id={m.id} data={data} hostId={hostId} from={from} movedOn={movedOn} />;
  if (data.tool_name === "ExitPlanMode") return <PlanCard data={data} hostId={hostId} taskId={taskId} from={from} movedOn={movedOn} />;
  return <PermissionCard data={data} hostId={hostId} from={from} />;
});
