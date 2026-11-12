import { useAtom } from "@effect/atom-react"
import { BrowserKeyValueStore } from "@effect/platform-browser"
import { callRpc } from "@huntaway/client"
import { TaskId } from "@huntaway/contracts"
import { Effect, Schedule, Schema } from "effect"
import { Atom } from "effect/reactivity"
import { useCallback } from "react"
import { registry } from "../../state/registry"

/**
 * Terminal tools (lazygit, an editor…) this board has open, per task. Each is a tmux session
 * on the task's host that lasts as long as a board keeps it open: while the app is open we
 * renew it every so often, and the host ends sessions nobody renews or is attached to. The
 * list is kept for the browser tab (sessionStorage), so reloading doesn't close them.
 */

const KEEPALIVE = "30 seconds"

const OpenTool = Schema.Struct({ hostId: Schema.String, taskId: Schema.String, toolId: Schema.String })
export type OpenTool = typeof OpenTool.Type

const same = (a: OpenTool, b: OpenTool) => a.hostId === b.hostId && a.taskId === b.taskId && a.toolId === b.toolId

/** The open tools, under the old `ia.openTools` key of the tab's sessionStorage, as JSON. */
const openToolsAtom = Atom.kvs({
  runtime: Atom.runtime(BrowserKeyValueStore.layerSessionStorage),
  key: "ia.openTools",
  schema: Schema.Array(OpenTool),
  defaultValue: (): ReadonlyArray<OpenTool> => [],
})

/** The tools this tab has open, and opening or closing one. */
export function useOpenTools() {
  const [open, setOpen] = useAtom(openToolsAtom)
  const openTool = useCallback((t: OpenTool) => setOpen((cur) => (cur.some((o) => same(o, t)) ? cur : [...cur, t])), [setOpen])
  const closeTool = useCallback((t: OpenTool) => setOpen((cur) => cur.filter((o) => !same(o, t))), [setOpen])
  return { open, openTool, closeTool }
}

/**
 * Renews every open tool's session now and every 30 seconds while mounted. A renewal changes nothing the board shows,
 * so it reads nothing again (a plain call, not a mutation).
 */
const keepaliveAtom = Atom.make((get) =>
  Effect.suspend(() =>
    Effect.forEach(
      get.once(openToolsAtom),
      (t) => callRpc(t.hostId, "terminal.keepalive", { task_id: TaskId.make(t.taskId), tool: t.toolId }).pipe(Effect.ignore),
      { concurrency: "unbounded", discard: true },
    ),
  ).pipe(Effect.repeat(Schedule.spaced(KEEPALIVE)), Effect.asVoid),
)

/** Keep every open tool's session alive while the app is open. */
export function startToolKeepalive() {
  registry.mount(keepaliveAtom)
}
