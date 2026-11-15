import type { HostTask } from "@huntaway/client"
import type { PendingPermission } from "@huntaway/contracts"

// The Inbox (the old app's inbox.ts, for one board): what waits on the user. Every prompt an agent is waiting on, and
// every task in Needs attention that has none, newest first.

/** What the Inbox needs of a task. */
export type InboxTask = Pick<HostTask, "host_id" | "id" | "status" | "updated_at">

export type InboxItem<T extends InboxTask = HostTask> =
  | {
      readonly type: "prompt"
      readonly key: string
      readonly host_id: string
      readonly prompt: PendingPermission
      readonly task: T | undefined
      readonly at: string
    }
  | { readonly type: "attention"; readonly key: string; readonly host_id: string; readonly task: T; readonly at: string }

/** A host's prompts, as it last answered `permissions.pending`. */
export interface HostPrompts {
  readonly host_id: string
  readonly prompts: ReadonlyArray<PendingPermission>
}

/**
 * The Inbox's items (pure): each host's prompts with their task (found on that host), then the tasks in Needs attention
 * with no prompt of theirs, newest first.
 */
export function inboxItems<T extends InboxTask>(tasks: ReadonlyArray<T>, prompts: ReadonlyArray<HostPrompts>): ReadonlyArray<InboxItem<T>> {
  const byKey = new Map(tasks.map((t) => [`${t.host_id}/${t.id}`, t]))
  const asking = new Set<string>()
  const items: Array<InboxItem<T>> = []
  for (const { host_id, prompts: list } of prompts)
    for (const prompt of list) {
      const key = `${host_id}/${prompt.task_id}`
      asking.add(key)
      items.push({ type: "prompt", key: `${host_id}/p/${prompt.id}`, host_id, prompt, task: byKey.get(key), at: prompt.created_at })
    }
  for (const task of tasks)
    if (task.status === "needs_attention" && !asking.has(`${task.host_id}/${task.id}`))
      items.push({ type: "attention", key: `${task.host_id}/t/${task.id}`, host_id: task.host_id, task, at: task.updated_at })
  return items.toSorted((a, b) => b.at.localeCompare(a.at))
}
