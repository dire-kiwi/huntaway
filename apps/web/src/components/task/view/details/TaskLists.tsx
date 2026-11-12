import { backgroundIdle, taskKey, type HostTask as Task } from "@huntaway/client"
import { clsx } from "clsx"
import { GitCompareArrows, Hourglass, MonitorPlay } from "lucide-react"
import { useMemo } from "react"
import { inGroupTaskGroup } from "../../../../projectGroups"
import { useBoard } from "../../../../state/board"
import { openCompare, openTask } from "../../../../state/route"
import { isGroupTask } from "../../../boardHelpers"
import { harnessLabels, useConfigsOf, useFanout } from "../../../board/Fanout"
import { GroupTaskBadge, useCreatedProgress } from "../../../board/TaskCard"
import { cost, RunningDot, StatusIcon } from "../../../ui"
import { TaskTypeBadge } from "../../documentInfo"
import { Section } from "./Section"

/** The tasks made from the same prompt (IA-227), with what each runs with, to compare them (changes/Compare, 6.11). */
export function FanoutSection({ task }: { task: Task }) {
  const tasks = useFanout(task)
  const configs = useConfigsOf(tasks)
  if (tasks.length < 2) return null
  const labels = harnessLabels(tasks, configs)
  return (
    <Section
      title="Same prompt"
      right={
        <button
          className="flex items-center gap-1 text-[11.5px] text-faint hover:text-fg"
          onClick={() => openCompare(task.id)}
          title="Compare their work side by side, and pick one"
        >
          <GitCompareArrows size={12} /> Compare all {tasks.length}
        </button>
      }
    >
      <div className="-mx-1 space-y-0.5">
        {tasks.map((t, i) => (
          <button
            key={t.id}
            className={clsx("flex w-full items-center gap-2 rounded px-1 py-1 text-left text-[12.5px] hover:bg-raised", t.id === task.id && "bg-raised")}
            onClick={() => openTask(t.id)}
            title={t.title}
          >
            <StatusIcon status={t.status} />
            <span className="shrink-0 font-mono text-[11px] text-faint">{taskKey(t)}</span>
            <span className="min-w-0 flex-1 truncate text-fg">{labels[i]}</span>
            {t.running &&
              (t.agent_wait ? (
                <Hourglass size={11} className="shrink-0 text-muted" />
              ) : backgroundIdle(t) ? (
                <MonitorPlay size={11} className="shrink-0 text-muted" />
              ) : (
                <RunningDot />
              ))}
            {cost(t.cost_usd) && <span className="shrink-0 text-[11px] text-faint">{cost(t.cost_usd)}</span>}
          </button>
        ))}
      </div>
    </Section>
  )
}

/** Tasks to open, each with its status, key and title. */
function TaskList({ tasks }: { tasks: ReadonlyArray<Task> }) {
  return (
    <div className="-mx-1 space-y-0.5">
      {tasks.map((t) => (
        <button key={t.id} className="flex w-full items-center gap-2 rounded px-1 py-1 text-left text-[12.5px] hover:bg-raised" onClick={() => openTask(t.id)}>
          <StatusIcon status={t.status} />
          <span className="shrink-0 font-mono text-[11px] text-faint">{taskKey(t)}</span>
          <span className="min-w-0 flex-1 truncate text-fg">{t.title}</span>
          {t.running &&
            (t.agent_wait ? (
              <Hourglass size={11} className="shrink-0 text-muted" />
            ) : backgroundIdle(t) ? (
              <MonitorPlay size={11} className="shrink-0 text-muted" />
            ) : (
              <RunningDot />
            ))}
        </button>
      ))}
    </div>
  )
}

/**
 * The tasks a group task's agent created: in the group's projects, then any elsewhere. For a plan
 * (in a project), the tasks its agent broke it into.
 */
export function CreatedTasksSection({ task }: { task: Task }) {
  const all = useBoard((s) => s.tasks)
  const projects = useBoard((s) => s.projects)
  const progress = useCreatedProgress()[task.id]
  const groupTask = isGroupTask(task)
  const [inGroup, elsewhere] = useMemo(() => {
    const created = Object.values(all)
      .filter((t) => t.kind === "task" && t.host_id === task.host_id && t.created_by === task.id)
      .toSorted((a, b) => a.created_at.localeCompare(b.created_at))
    const own = groupTask ? created.filter((t) => inGroupTaskGroup(t, task, projects)) : created
    return [own, created.filter((t) => !own.includes(t))]
  }, [all, projects, task, groupTask])
  return (
    <Section
      title="Tasks"
      right={<span className="text-[11.5px]">{groupTask ? <GroupTaskBadge progress={progress} /> : <TaskTypeBadge type="plan" progress={progress} />}</span>}
    >
      {inGroup.length === 0 ? (
        <div className="text-[12.5px] text-muted">
          {groupTask
            ? "None yet. Its agent plans the work and creates tasks in the group's projects."
            : "None yet. Once you're happy with the plan, ask its agent to break it into tasks."}
        </div>
      ) : (
        <TaskList tasks={inGroup} />
      )}
      {elsewhere.length > 0 && (
        <>
          <div
            className="mt-2 mb-0.5 text-[11.5px] text-faint"
            title="Tasks its agent created outside the group's projects. They don't count towards its progress."
          >
            Outside the group
          </div>
          <TaskList tasks={elsewhere} />
        </>
      )}
    </Section>
  )
}
