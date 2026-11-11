// The labels and the scratch type a card and the new task dialog show, from the old components/task/Document.tsx (the
// part of it the board needs; the document view itself comes with task/, docs/plan/13-milestones.md 2.7).
import { clsx } from "clsx"
import { ClipboardList, NotebookPen, Sparkles, Workflow } from "lucide-react"
import type { ReactNode } from "react"
import { type DocumentType } from "@huntaway/client"
/** What a card's type badge shows besides labels: a scratch task. */
type TaskType = "scratch"
import type { Progress } from "../board/TaskCard"
import { CARD_BADGE, ProgressCount, Wide } from "../ui"
/** What each label asks its task's agent for (API 71; types of task from API 42), in the order tasks show them. */
type LabelInfo = { id: DocumentType; label: string; icon: ReactNode; file: string; hint: string }

const PLAN: LabelInfo = {
  id: "plan",
  label: "Plan",
  icon: <ClipboardList size={12} />,
  file: "plan.html",
  hint: "An HTML plan its agent writes and you iterate on together",
}

export const LABEL_INFO: LabelInfo[] = [
  PLAN,
  {
    id: "artifact",
    label: "Artifact",
    icon: <Sparkles size={12} />,
    file: "artifact.html",
    hint: "A designed HTML page: a document, explainer, dashboard or prototype, kept here rather than on claude.ai",
  },
  { id: "diagram", label: "Diagram", icon: <Workflow size={12} />, file: "diagram.mmd", hint: "A Mermaid diagram" },
]

/** A scratch task, which the new task dialog offers as a type: in no project (API 47), or in a project (API 51). */
export const SCRATCH_TYPE = {
  id: "scratch" as const,
  label: "Scratch",
  icon: <NotebookPen size={12} />,
  hint: "Its agent works in its own folder, with no worktree, on whatever you ask: in a project it reads the repository, in no project it has none",
}

export const documentInfo = (t: DocumentType): LabelInfo => LABEL_INFO.find((x) => x.id === t) ?? PLAN

export const taskTypeInfo = (t: TaskType | DocumentType): { label: string; icon: ReactNode; hint: string; file?: string | undefined } =>
  t === "scratch" ? SCRATCH_TYPE : documentInfo(t)

/** A scratch task, or a task's label, on a card: what it is or makes, or for a plan, how the tasks it created are doing.
 *  `compact`: the icon, and the words once the card has room. */
export function TaskTypeBadge({ type, progress, compact }: { type: TaskType | DocumentType; progress?: Progress | undefined; compact?: boolean | undefined }) {
  const info = taskTypeInfo(type)
  if (compact)
    return (
      <span
        className={clsx(CARD_BADGE, "text-accent")}
        title={progress?.total ? `${info.label}: ${progress.done} of the ${progress.total} tasks it created are done` : `${info.label}: ${info.hint}`}
      >
        {info.icon} {progress?.total ? <ProgressCount progress={progress} /> : <Wide>{info.label.toLowerCase()}</Wide>}
      </span>
    )
  return (
    <span
      className="flex items-center gap-1 text-accent"
      title={progress?.total ? `${info.label}: ${progress.done} of the ${progress.total} tasks it created are done` : info.hint}
    >
      {info.icon} {progress?.total ? `${progress.done}/${progress.total} done` : info.label.toLowerCase()}
    </span>
  )
}
