import { useCallback, useState } from "react"
import { heldTodos, STATUSES, taskKey, type HostTask as Task } from "@huntaway/client"
import type { Status, TaskPatch, Todo as TaskTodo } from "@huntaway/contracts"

import { Button, Modal, ModalFooter } from "../ui"

/**
 * Asks before a task whose todo list isn't complete leaves In progress (API 148, HA-330): the host refuses the move
 * unless it says to move it anyway. `confirmTodos(task, status)` resolves to what the move's update adds (`{}` when the
 * list doesn't hold it, `{todos_override: true}` once you say to move it anyway), or null to leave it where it is.
 * Render `dialog` while it asks.
 */
/** What a move's update adds once the user says to move it anyway. */
export type TaskUpdateOptions = Pick<TaskPatch, "todos_override">

export function useConfirmTodos() {
  const [asking, setAsking] = useState<{ task: Task; status: Status; items: ReadonlyArray<TaskTodo>; answer: (go: boolean) => void } | null>(null)
  const confirmTodos = useCallback((task: Task, status: Status): Promise<TaskUpdateOptions | null> => {
    const items = heldTodos(task, status)
    if (!items.length) return Promise.resolve({})
    const { promise, resolve: answer } = Promise.withResolvers<boolean>()
    setAsking((before) => {
      // Asked about another task meanwhile: that move doesn't happen.
      before?.answer(false)
      return { task, status, items, answer }
    })
    return promise.then((go) => (go ? { todos_override: true } : null))
  }, [])
  const close = (go: boolean) => {
    asking?.answer(go)
    setAsking(null)
  }
  const dialog = asking && <UnfinishedModal {...asking} onClose={() => close(false)} onConfirm={() => close(true)} />
  return { confirmTodos, dialog }
}

function UnfinishedModal({
  task,
  status,
  items,
  onClose,
  onConfirm,
}: {
  task: Task
  status: Status
  items: ReadonlyArray<TaskTodo>
  onClose: () => void
  onConfirm: () => void
}) {
  const key = taskKey(task)
  const to = STATUSES.find((s) => s.id === status)?.label ?? status
  return (
    <Modal title="The todo list isn't complete" onClose={onClose} onSubmit={onConfirm} width="max-w-md">
      <div className="space-y-4 text-[13px]">
        <p className="text-muted">
          <span className="text-fg">
            {key} {task.title}
          </span>{" "}
          stays In progress until its agent's todo list is complete. {items.length === 1 ? "This item isn't" : `These ${items.length} items aren't`} done:
        </p>
        <ul className="space-y-1">
          {withKeys(items).map(({ item: t, key: itemKey }) => (
            <li key={itemKey} className="flex gap-2">
              <span className={t.status === "in_progress" ? "text-fg" : "text-muted"}>{t.status === "in_progress" ? "◐" : "○"}</span>
              <span className="min-w-0 break-words">{t.text}</span>
            </li>
          ))}
        </ul>
        <p className="text-muted">
          Its agent can finish{" "}
          {items.length === 1 ? "it, or drop it from its list if it no longer applies" : "them, or drop them from its list if they no longer apply"}. You can
          move it to {to} anyway.
        </p>
        <ModalFooter className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onConfirm}>
            Move anyway
          </Button>
        </ModalFooter>
      </div>
    </Modal>
  )
}

/** The items with a key each: their text, numbered where it repeats. */
export function withKeys(items: ReadonlyArray<TaskTodo>): Array<{ item: TaskTodo; key: string }> {
  const seen = new Map<string, number>()
  return items.map((item) => {
    const n = (seen.get(item.text) ?? 0) + 1
    seen.set(item.text, n)
    return { item, key: n > 1 ? `${item.text}#${n}` : item.text }
  })
}
