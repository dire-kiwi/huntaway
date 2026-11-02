import type { Task } from "../../../api";
import { taskConfig, useAvailableConfigs, useProject, useStore } from "../../../store";

/** The subproject a task belongs to, if any. */
export function useSubproject(task: Task | undefined) {
  return useStore((s) => {
    const p = task?.kind === "task" && task.parent_id ? s.tasks[task.parent_id] : undefined;
    return p?.subproject ? p : undefined;
  });
}

/** The config a thread runs with (or will), and the ones it could pick. */
export function useThreadConfig(task: Task) {
  const project = useProject(task.project_id);
  const available = useAvailableConfigs(task.host_id, task.profile_id, project);
  const current = useStore((s) => taskConfig(s, task));
  return { current, available };
}
