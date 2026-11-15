import { hostStatuses, taskLabels, type HostTask as Task } from "@huntaway/client"
import { clsx } from "clsx"
import { useBoard } from "../../../../state/board"
import { useProject } from "../../../boardHelpers"
import { Dependencies } from "../../../board/Dependencies"
import { IncomingSection, MergesIntoSection, useIncoming } from "../../../board/MergesInto"
import { levelsTitle, stackedBelowId, stackedOnTitle, useLevels } from "../../../board/StackedOn"
import { LevelsSection, StackedOnSection } from "../../../board/stackSections"
import { ActivityTime, BranchIcon, cost, PrIcon, PreviewDot, ResolutionBadge, RunningDot, StatusIcon } from "../../../ui"
import { FailedChecks } from "./FailedChecks"
import { Section } from "./Section"
import { StatusNotes } from "./StatusSection"
import { CreatedTasksSection, FanoutSection } from "./TaskLists"
import { taskFacts } from "./taskFacts"
import { TodosSection } from "./TodosSection"
import { TrackedWork } from "./TrackedWork"
// 6.6
import { useWorkflowRuns, WorkflowsList } from "../../Workflows"

/**
 * The column beside a task's thread (HE-31): what there is to know about the task while following it, each part only
 * when it has something to say. Its status and what it waits for, its agent's todo list, its pull request with its
 * checks, its preview, its workflows, the tasks it made, depends on or merges with, and its branch. Everything that's
 * set by hand (its title and description, its status, its labels, its links and its worktree) is in the Details tab
 * (Details.tsx), which also has all of this for a view too narrow for the column.
 */
export function KeyItems({ task, className }: { task: Task; className: string }) {
  const project = useProject(task.project_id)
  const host = useBoard((s) => s.hosts.find((h) => h.id === task.host_id))
  const { groupTask, assistant, lasting, code, showMergesInto } = taskFacts(task)
  const incoming = useIncoming(task.id)
  const workflows = useWorkflowRuns(task)
  const levels = useLevels(task.id)
  const status = hostStatuses(host).find((s) => s.id === task.status)?.label ?? task.status
  const spent = cost(task.cost_usd)
  const worktreeBusy = task.worktree_state === "setting_up" || task.worktree_state === "tearing_down"
  return (
    <aside className={className} data-key-items>
      {!lasting && (
        <Section title="Status">
          <div className="flex items-center gap-2 text-[12.5px] text-fg" data-status={task.status}>
            <StatusIcon status={task.status} size={13} />
            <span className="min-w-0 truncate">{status}</span>
            <span className="text-[11.5px]">
              <ResolutionBadge task={task} />
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[11.5px] text-faint">
              {task.running && <RunningDot />}
              <ActivityTime task={task} />
              {spent && <span title="What its agent has cost">· {spent}</span>}
            </span>
          </div>
          <StatusNotes task={task} />
        </Section>
      )}

      {assistant && <TrackedWork task={task} />}

      <TodosSection task={task} />

      {task.kind === "task" && code && task.pr_url && (
        <Section title="Pull request">
          <PrIcon url={task.pr_url} label className="text-[12.5px] text-fg" />
          <FailedChecks task={task} />
        </Section>
      )}

      {!lasting && task.preview_url && (
        <Section title="Preview">
          <div className="flex min-w-0 items-center gap-2 text-[12.5px]">
            <PreviewDot url={task.preview_url} host={task.host_id} />
            <a href={task.preview_url} target="_blank" rel="noreferrer" className="min-w-0 truncate text-fg hover:underline">
              {task.preview_url.replace(/^https?:\/\//, "")}
            </a>
          </div>
        </Section>
      )}

      {!!workflows?.workflows.length && (
        <Section title="Workflows">
          <WorkflowsList task={task} />
        </Section>
      )}

      {task.fanout_id && <FanoutSection task={task} />}

      {(groupTask || taskLabels(task).includes("plan")) && <CreatedTasksSection task={task} />}

      {task.kind === "task" && code && !!task.depends_on?.length && (
        <Section title="Depends on">
          <Dependencies task={task} project={project} listOnly />
        </Section>
      )}

      {/* A stack level that's merging or done says where it goes under "Stacked on" (or "Lands after") instead. */}
      {showMergesInto && !!task.merges_into && !(stackedBelowId(task) && (task.merging || task.status === "done")) && (
        <Section title="Merges into">
          <MergesIntoSection task={task} project={project} />
        </Section>
      )}

      {incoming.length > 0 && (
        <Section title="Merging into this">
          <IncomingSection task={task} project={project} />
        </Section>
      )}

      {stackedBelowId(task) && (
        <Section title={stackedOnTitle(task)}>
          <StackedOnSection task={task} project={project} />
        </Section>
      )}

      {levels.length > 0 && (
        <Section title={levelsTitle(levels)}>
          <LevelsSection task={task} project={project} />
        </Section>
      )}

      {code && (task.branch || task.worktree_error) && (
        <Section title="Branch">
          {task.branch && (
            <div className="flex items-start gap-1.5 font-mono text-[11.5px] text-muted">
              <BranchIcon branch={task.branch} className="mt-0.5 text-faint" />
              <span className="min-w-0 break-all">{task.branch}</span>
            </div>
          )}
          {(worktreeBusy || task.worktree_state === "error") && (
            <div className={clsx("mt-1.5 text-[12px]", worktreeBusy ? "text-st-progress" : "text-red-300")}>
              Worktree {task.worktree_state.replace("_", " ")}
            </div>
          )}
          {task.worktree_error && (
            <div className="mt-1.5 rounded bg-red-500/10 p-2 font-mono text-[11px] whitespace-pre-wrap text-red-300">{task.worktree_error}</div>
          )}
        </Section>
      )}
    </aside>
  )
}
