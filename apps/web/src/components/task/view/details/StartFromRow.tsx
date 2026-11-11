import type { HostProject as Project, HostTask as Task } from "@huntaway/client"
import type { StartFrom } from "@huntaway/contracts"
import { useBoard } from "../../../../state/board"
import { rpc } from "../../../../state/rpc"
import { errorText } from "../../../ui"
import { Row, TextInput } from "./Section"

/** What a task's start_from says, as it's typed: another task's key, a branch, `#12` (or a pull request's URL) or a commit. */
function startFromText(sf: StartFrom | null | undefined, other: Task | undefined, project?: Project | null): string | null {
  if (!sf) return null
  if (sf.type === "branch") return sf.branch
  if (sf.type === "task") return other ? `${project?.key ?? "T"}-${other.number}` : "a deleted task"
  if (sf.type === "pull_request") return sf.repo ? `https://github.com/${sf.repo}/pull/${sf.number}` : `#${sf.number}`
  return sf.commit
}

/**
 * What the task's worktree starts from (API 96): until its branch exists, another task's key (stacking it on that task's
 * branch), a branch, a pull request or a commit, or blank for the base branch; then what it started from, if anything.
 */
export function StartFromRow({ task, project, onError }: { task: Task; project?: Project | null | undefined; onError: (e: string | null) => void }) {
  const other = useBoard((s) => (task.start_from?.type === "task" ? s.tasks[task.start_from.task_id] : undefined))
  const text = startFromText(task.start_from, other, project)
  if (task.parent_id) return null
  // Until the branch is made (a setup that failed before then can be tried again from elsewhere).
  if (task.branch || !["none", "error"].includes(task.worktree_state)) {
    return text ? (
      <Row label="Started from">
        <span className="font-mono text-[11.5px] break-all">{text}</span>
      </Row>
    ) : null
  }
  return (
    <Row label="Starts from">
      <TextInput
        value={text}
        placeholder={`${task.base_branch || project?.base_branch || "the base branch"}, or a task, branch, #PR or commit`}
        onSave={(v) => {
          onError(null)
          rpc(task.host_id, "tasks.update", { id: task.id, patch: { start_from: v || null } }).catch((e: unknown) =>
            onError(`Couldn't change where it starts from: ${errorText(e)}`),
          )
        }}
      />
    </Row>
  )
}
