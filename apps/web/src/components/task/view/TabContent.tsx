import { isAssistant, isPenThread, isPensThread, ownWorkDir, type DocumentType, type HostProject as Project, type HostTask as Task } from "@huntaway/client"
import type { ReactNode } from "react"
import { Thread } from "../Thread"
import { Composer } from "../thread/Composer"
import { WithHeldChoice } from "../../board/MergesInto"
import { Details } from "./details/Details"
import type { Mode, Tab } from "./layout"

// What empty threads show. The same elements every time, so the (memoized) thread doesn't redraw for them.
const NOT_STARTED = (
  <div className="rounded-xl border border-dashed border-line p-6 text-center text-[13px] text-muted">
    No agent has worked on this yet. Press <span className="text-fg">Start</span> or send instructions below; the task description is included automatically.
  </div>
)

const ASSISTANT_EMPTY = (
  <div className="rounded-xl border border-dashed border-line p-6 text-center text-[13px] text-muted">
    This is your assistant: one conversation that lasts, outside every project. Ask it anything; it hands code work to project tasks.
  </div>
)

const PENS_EMPTY = (
  <div className="rounded-xl border border-dashed border-line p-6 text-center text-[13px] text-muted">
    This thread keeps your pens: the tabs over the profile's board. Tell it what you're working on, or what to park, and it puts those tasks in pens, makes,
    renames and orders them, and hides the ones you're not on.
  </div>
)

const PEN_EMPTY = (
  <div className="rounded-xl border border-dashed border-line p-6 text-center text-[13px] text-muted">
    This is the pen's own thread: one conversation that lasts, about the tasks in this pen. Its agent can say how they're going, add tasks to the pen, start or
    chase them, and keep notes on what the pen is for.
  </div>
)

/** What a tab of a later milestone shows on this server until its view comes over. */
function NotYet({ what }: { what: string }) {
  return <div className="p-8 text-[13px] text-muted">{what} not yet on this server.</div>
}

/**
 * The tab shown in the task's main area, but for its terminals, which stay mounted beside it: `shown` is the tab shown in
 * place of `tab` where that one isn't there, and `docShown` the label whose document that is, if it is one.
 */
export function TabContent({
  task,
  project,
  mode,
  tab,
  shown,
  docShown,
  onShowThread,
}: {
  task: Task
  project: Project | undefined
  mode: Mode
  tab: Tab
  shown: Tab
  docShown: DocumentType | undefined
  onShowThread: () => void
}) {
  // The old view preloaded the tabs kept in chunks of their own (Changes, Memory, Brief, Routines, the review's patch):
  // they come with their milestones.
  const placeholder = isAssistant(task)
    ? "Message your assistant…"
    : isPensThread(task)
      ? "What are you working on? E.g. today it's the pricing page and the footer fix"
      : isPenThread(task)
        ? "Ask about this pen's tasks, or what to do next: e.g. how's it going, or add a task for the footer fix"
        : undefined
  if (shown === "thread")
    return (
      <WithHeldChoice task={task} project={project}>
        <Thread
          key={`${task.host_id}:${task.id}`}
          task={task}
          cwd={task.worktree_path ?? ownWorkDir(task) ?? project?.repo_path}
          empty={isAssistant(task) ? ASSISTANT_EMPTY : isPensThread(task) ? PENS_EMPTY : isPenThread(task) ? PEN_EMPTY : NOT_STARTED}
          placeholder={placeholder}
        />
      </WithHeldChoice>
    )
  // A document has a composer of its own, for asking for changes to it: documents come with M6 (task/Document.tsx).
  if (docShown) return <NotYet what="Its document is" />
  const content = tabView(task, mode, tab, shown)
  if (!content) return null
  // Every other tab keeps the thread's composer under it, and a message sent from it shows the thread (HA-334).
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">{content}</div>
      <div className="border-t border-line pt-3 narrow:pt-2">
        <Composer key={task.id} task={task} placeholder={placeholder} onSend={onShowThread} />
      </div>
    </div>
  )
}

/**
 * What a tab other than the thread or a document shows above the composer. Changes, the review and the summary come
 * with M4 (changes/Changes.tsx, task/Review.tsx); a workflow's tabs with workflows (6.6); the assistant's memory, brief,
 * routines and action log with the assistant (M6).
 */
function tabView(task: Task, mode: Mode, tab: Tab, shown: Tab): ReactNode {
  return shown === "memory" ? (
    <NotYet what="The assistant's memory is" />
  ) : tab === "changes" ? (
    <NotYet what="Changes are" />
  ) : shown === "review" ? (
    <NotYet what="Reviews are" />
  ) : shown === "summary" ? (
    <NotYet what="Summaries are" />
  ) : shown.startsWith("wf:") ? (
    <NotYet what="Workflows are" />
  ) : shown === "actions" ? (
    <NotYet what="The action log is" />
  ) : shown === "brief" ? (
    <NotYet what="The morning brief is" />
  ) : shown === "routines" ? (
    <NotYet what="Routines are" />
  ) : shown === "details" ? (
    <Details key={task.id} task={task} mode={mode} className="h-full overflow-y-auto" />
  ) : null
}
