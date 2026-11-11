import type { HostTask as Task } from "@huntaway/client"
import { useBoard } from "../../../state/board"
import { taskConfig, useAvailableConfigs, useProject } from "../../boardHelpers"

// The old file's `useSubproject` was for subprojects, a legacy branch, and is gone.

/** The config a thread runs with (or will), and the ones it could pick. */
export function useThreadConfig(task: Task) {
  const project = useProject(task.project_id)
  const available = useAvailableConfigs(task.host_id, task.profile_id, project)
  const current = useBoard((s) => taskConfig(s, task))
  return { current, available }
}
