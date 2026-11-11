// A task's turns with checkpoints: what each of its agent's turns changed, and whether the task can be rewound to
// before it. Read by @huntaway/client's `turnsAtom`, again as the board says they changed.
import { useAtomValue } from "@effect/atom-react"
import { noTurnsAtom, turnsAtom, type HostTask as Task, type TurnsView } from "@huntaway/client"
import type { Turn } from "@huntaway/contracts"

/** Whether a task keeps checkpoints of its turns: a task with a worktree of its own. */
export const hasTurns = (task: Task) => task.kind === "task" && task.use_worktree

/** A task's turns, followed while shown. Null until loaded, and when `enabled` is false or the task has none. */
export function useTurns(task: Task, enabled = true): { data: TurnsView["data"]; error: string | null } {
  const on = enabled && hasTurns(task)
  const view = useAtomValue(on ? turnsAtom({ host_id: task.host_id, task_id: task.id }) : noTurnsAtom)
  return { data: view.data, error: view.failed }
}

/** A turn's label: its number, and what it was asked. */
export const turnLabel = (t: Turn) => (t.review_round ? `Fix round ${t.review_round}` : t.text.split("\n")[0] || "(no message)")

/** A turn's changes, short: `3 files +12 −4`. */
export function turnStat(t: Turn): string {
  const s = t.stats
  if (!s) return t.before_n === null ? "no checkpoint before it" : ""
  if (!s.files) return "no changes"
  return `${s.files} file${s.files === 1 ? "" : "s"} +${s.additions} −${s.deletions}`
}
