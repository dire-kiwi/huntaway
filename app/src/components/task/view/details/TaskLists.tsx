import clsx from "clsx";
import { GitCompareArrows, Hourglass } from "lucide-react";
import { useMemo } from "react";
import { hostSupports, type Task } from "../../../../api";
import { openCompare, openTask } from "../../../../router";
import { isGroupTask, taskKey, useHost, useStore } from "../../../../store";
import { COMPARE_API, harnessLabels, useConfigsOf, useFanout } from "../../../board/Fanout";
import { inGroupTaskGroup } from "../../../../projectGroups";
import { GroupTaskBadge, useCreatedProgress } from "../../../board/TaskCard";
import { TaskTypeBadge } from "../../Document";
import { cost, RunningDot, StatusIcon } from "../../../ui";
import { Section } from "./Section";

/** The tasks made from the same prompt (IA-227), with what each runs with, to compare them. */
export function FanoutSection({ task }: { task: Task }) {
  const tasks = useFanout(task);
  const projects = useStore((s) => s.projects);
  const configs = useConfigsOf(tasks);
  const compares = hostSupports(useHost(task.host_id), COMPARE_API);
  if (tasks.length < 2) return null;
  const labels = harnessLabels(tasks, configs);
  return (
    <Section
      title="Same prompt"
      right={
        compares && (
          <button className="flex items-center gap-1 text-[11.5px] text-faint hover:text-fg" onClick={() => openCompare(task.id)} title="Compare their work side by side, and pick one">
            <GitCompareArrows size={12} /> Compare all {tasks.length}
          </button>
        )
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
            <span className="shrink-0 font-mono text-[11px] text-faint">{taskKey(t, projects)}</span>
            <span className="min-w-0 flex-1 truncate text-fg">{labels[i]}</span>
            {t.running && (t.agent_wait ? <Hourglass size={11} className="shrink-0 text-muted" /> : <RunningDot />)}
            {cost(t.cost_usd) && <span className="shrink-0 text-[11px] text-faint">{cost(t.cost_usd)}</span>}
          </button>
        ))}
      </div>
    </Section>
  );
}

/**
 * The tasks a group task's agent created: in the group's projects, then any elsewhere. For a plan
 * (in a project), the tasks its agent broke it into.
 */
export function CreatedTasksSection({ task }: { task: Task }) {
  const all = useStore((s) => s.tasks);
  const projects = useStore((s) => s.projects);
  const progress = useCreatedProgress()[task.id];
  const groupTask = isGroupTask(task);
  const [inGroup, elsewhere] = useMemo(() => {
    const created = Object.values(all)
      .filter((t) => t.kind === "task" && t.host_id === task.host_id && t.created_by === task.id)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    const own = groupTask ? created.filter((t) => inGroupTaskGroup(t, task, projects)) : created;
    return [own, created.filter((t) => !own.includes(t))];
  }, [all, projects, task, groupTask]);
  const list = (ts: Task[]) => (
    <div className="-mx-1 space-y-0.5">
      {ts.map((t) => (
        <button key={t.id} className="flex w-full items-center gap-2 rounded px-1 py-1 text-left text-[12.5px] hover:bg-raised" onClick={() => openTask(t.id)}>
          <StatusIcon status={t.status} />
          <span className="shrink-0 font-mono text-[11px] text-faint">{taskKey(t, projects)}</span>
          <span className="min-w-0 flex-1 truncate text-fg">{t.title}</span>
          {t.running && (t.agent_wait ? <Hourglass size={11} className="shrink-0 text-muted" /> : <RunningDot />)}
        </button>
      ))}
    </div>
  );
  return (
    <Section title="Tasks" right={<span className="text-[11.5px]">{groupTask ? <GroupTaskBadge progress={progress} /> : <TaskTypeBadge type="plan" progress={progress} />}</span>}>
      {inGroup.length === 0 ? (
        <div className="text-[12.5px] text-muted">
          {groupTask ? "None yet. Its agent plans the work and creates tasks in the group's projects." : "None yet. Once you're happy with the plan, ask its agent to break it into tasks."}
        </div>
      ) : (
        list(inGroup)
      )}
      {elsewhere.length > 0 && (
        <>
          <div className="mt-2 mb-0.5 text-[11.5px] text-faint" title="Tasks its agent created outside the group's projects. They don't count towards its progress.">
            Outside the group
          </div>
          {list(elsewhere)}
        </>
      )}
    </Section>
  );
}
