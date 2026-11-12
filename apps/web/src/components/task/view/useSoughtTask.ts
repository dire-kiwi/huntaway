import { useAtomValue } from "@effect/atom-react"
import { query, type HostTask as Task } from "@huntaway/client"
import { HostId, TaskId } from "@huntaway/contracts"
import { Atom } from "effect/reactivity"
import { useBoard } from "../../../state/board"
import { resultError, resultValue } from "../../ui"

interface Sought {
  readonly task: Task | undefined
  /** Some host hasn't answered yet. */
  readonly seeking: boolean
}

const NOT_SOUGHT: Atom.Atom<Sought> = Atom.make({ task: undefined, seeking: false })

/**
 * What the connected hosts have of a task (`<task id>\n<host>\n…`): one `tasks.get` query per host, and once each has
 * answered, the first host's (in the board's order) that has it.
 */
const soughtAtom = Atom.family((key: string) =>
  Atom.make((get): Sought => {
    const [taskId = "", ...hosts] = key.split("\n")
    const answers = hosts.map((host) => {
      const result = get(query("tasks.get", host, { id: TaskId.make(taskId) }))
      return { host, task: resultValue(result), failed: resultError(result) !== null }
    })
    if (answers.some((a) => a.task === undefined && !a.failed)) return { task: undefined, seeking: true }
    const found = answers.find((a) => a.task !== undefined)
    return { task: found?.task === undefined ? undefined : { ...found.task, host_id: HostId.make(found.host) }, seeking: false }
  }),
)

/**
 * A thread off every list the board loads (a routine's run of the assistant, 6.7: the board's snapshot leaves them out)
 * asked for by itself from the connected hosts when it's opened by its link and isn't on the board: what one of them
 * has, until the board has it (its next event puts it there), and whether it's still being looked for.
 */
export function useSoughtTask(taskId: string, onBoard: boolean): { readonly task: Task | undefined; readonly seeking: boolean } {
  const loaded = useBoard((s) => s.loaded)
  const hosts = useBoard((s) =>
    s.hosts
      .filter((h) => h.connected)
      .map((h) => h.id)
      .join("\n"),
  )
  const sought = useAtomValue(onBoard || !loaded ? NOT_SOUGHT : soughtAtom(hosts === "" ? taskId : `${taskId}\n${hosts}`))
  return { task: onBoard ? undefined : sought.task, seeking: !onBoard && loaded && sought.seeking }
}
