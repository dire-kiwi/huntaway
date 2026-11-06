import { Kanban, Layers } from "lucide-react";
import { useState } from "react";
import { api, worktreesOn, type Task } from "../../../../api";
import { navigate } from "../../../../router";
import { useProject } from "../../../../store";
import { SubprojectBadge, useSubprojectProgress } from "../../../board/TaskCard";
import { Button } from "../../../ui";
import { useSubproject } from "../hooks";
import { Section } from "./Section";

export function SubprojectSection({ task }: { task: Task }) {
  const subproject = useSubproject(task);
  const progress = useSubprojectProgress(task.id);
  const project = useProject(task.project_id);
  const [err, setErr] = useState<string | null>(null);
  const set = (on: boolean) => {
    setErr(null);
    api.updateTask(task.host_id, task.id, { subproject: on }).catch((e) => setErr(e.message));
  };
  if (subproject)
    return (
      <Section title="Subproject">
        <button className="text-left text-[13px] text-fg hover:underline" onClick={() => navigate({ name: "subproject", taskId: subproject.id })}>
          <span className="mr-1.5 font-mono text-[12px] text-faint">
            {project?.key ?? "T"}-{subproject.number}
          </span>
          {subproject.title}
        </button>
        <div className="mt-1.5 text-[12px] text-muted">
          Branches from {subproject.branch ? <span className="font-mono text-[11.5px]">{subproject.branch}</span> : "the subproject's branch"} and merges back into
          it.
        </div>
      </Section>
    );
  // Only a top-level task in a project with worktrees can be one.
  if (!(project && worktreesOn(project)) && !task.subproject) return null;
  return (
    <Section title="Subproject" right={task.subproject && <SubprojectBadge progress={progress} />}>
      {task.subproject ? (
        <div className="space-y-2">
          <div className="text-[12.5px] text-muted">
            Its tasks branch from {task.branch ? <span className="font-mono text-[11.5px]">{task.branch}</span> : "its branch"} and merge back into it. The
            subproject is then merged as a whole.
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => navigate({ name: "subproject", taskId: task.id })}>
              <Kanban size={12} /> Open board
            </Button>
            {!progress?.total && (
              <Button size="sm" variant="ghost" onClick={() => set(false)}>
                Make it a plain task
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="text-[12.5px] text-muted">Split this task into its own board of smaller tasks, which merge into this task's branch.</div>
          <Button size="sm" onClick={() => set(true)}>
            <Layers size={12} /> Make it a subproject
          </Button>
        </div>
      )}
      {err && <div className="mt-2 rounded bg-red-500/10 p-2 text-[11.5px] whitespace-pre-wrap text-red-300">{err}</div>}
    </Section>
  );
}
