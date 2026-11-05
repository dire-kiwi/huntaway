import { lazy, Suspense } from "react";
import { isAssistant, ownWorkDir, type DocumentType, type Project, type Task } from "../../../api";
import { DocumentView } from "../Document";
import { ChangeSummaryView, ReviewSummary } from "../Review";
import { Thread } from "../Thread";
import { isWorkflowTab, WorkflowTabView } from "../Workflows";
import { Details } from "./details/Details";
import type { Mode, Tab } from "./layout";

const ChangesView = lazy(() => import("../../changes/Changes").then((m) => ({ default: m.ChangesView })));

// What empty threads show. The same elements every time, so the (memoized) thread doesn't redraw for them.
const NOT_STARTED = (
  <div className="rounded-xl border border-dashed border-line p-6 text-center text-[13px] text-muted">
    No agent has worked on this yet. Press <span className="text-fg">Start</span> or send instructions below; the task description is included
    automatically.
  </div>
);

const ASSISTANT_EMPTY = (
  <div className="rounded-xl border border-dashed border-line p-6 text-center text-[13px] text-muted">
    This is your assistant: one conversation that lasts, outside every project. Ask it anything; it hands code work to project tasks.
  </div>
);

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
  task: Task;
  project: Project | undefined;
  mode: Mode;
  tab: Tab;
  shown: Tab;
  docShown: DocumentType | undefined;
  onShowThread: () => void;
}) {
  return shown === "thread" ? (
    <Thread
      key={`${task.host_id}:${task.id}`}
      task={task}
      cwd={task.worktree_path ?? ownWorkDir(task) ?? project?.repo_path}
      empty={isAssistant(task) ? ASSISTANT_EMPTY : NOT_STARTED}
      placeholder={isAssistant(task) ? "Message your assistant…" : undefined}
    />
  ) : docShown ? (
    <DocumentView key={`${task.id}:${docShown}`} task={task} label={docShown} onShowThread={onShowThread} />
  ) : tab === "changes" ? (
    <Suspense fallback={null}>
      <ChangesView task={task} />
    </Suspense>
  ) : shown === "review" ? (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-5 py-5">
        <ReviewSummary task={task} />
      </div>
    </div>
  ) : shown === "summary" ? (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-5 py-5">
        <ChangeSummaryView task={task} />
      </div>
    </div>
  ) : isWorkflowTab(shown) ? (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-5 py-5">
        <WorkflowTabView task={task} label={shown.slice(3)} />
      </div>
    </div>
  ) : shown === "details" ? (
    <Details key={task.id} task={task} mode={mode} className="h-full overflow-y-auto" />
  ) : null;
}
