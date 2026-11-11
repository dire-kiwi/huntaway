import type { HostTask as Task } from "@huntaway/client"
import { useEffect, useState } from "react"
import { board, useBoard } from "../../../state/board"
import { rpc } from "../../../state/rpc"

/**
 * A thread off every list the board loads (a routine's run of the assistant, 6.7: the board's snapshot leaves them out)
 * asked for by itself from the connected hosts when it's opened by its link and isn't on the board: what one of them
 * has, until the board has it (its next event puts it there), and whether it's still being looked for.
 */
export function useSoughtTask(taskId: string, onBoard: boolean): { readonly task: Task | undefined; readonly seeking: boolean } {
  const loaded = useBoard((s) => s.loaded)
  const [sought, setSought] = useState<{ readonly taskId: string; readonly task: Task | undefined }>()
  useEffect(() => {
    if (onBoard || !loaded) return undefined
    let live = true
    const hosts = board.get().hosts.filter((h) => h.connected)
    void Promise.allSettled(hosts.map((h) => rpc(h.id, "tasks.get", { id: taskId }).then((t): Task => ({ ...t, host_id: h.id })))).then((all) => {
      if (!live) return
      const found = all.find((r) => r.status === "fulfilled")
      setSought({ taskId, task: found?.status === "fulfilled" ? found.value : undefined })
    })
    return () => {
      live = false
    }
  }, [taskId, onBoard, loaded])
  const mine = sought?.taskId === taskId ? sought : undefined
  return { task: onBoard ? undefined : mine?.task, seeking: !onBoard && loaded && !mine }
}
