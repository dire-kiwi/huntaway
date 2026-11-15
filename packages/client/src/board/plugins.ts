import { Option } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { HostId } from "@huntaway/contracts"
import type { BoardEvent } from "@huntaway/contracts"
import { callRpc } from "../rpc.ts"
import { hostBoardAtom } from "./watch.ts"

// HE-34: what the web app shows of a host's plugins (docs/plan/15-plugins.md): the latest event of each, which its
// frames are given, and a call of a plugin's page. A plugin's pages are `query("plugins.page", …)`, read again on its
// events with `reload` (invalidate.ts).

/** A plugin's event. */
export type PluginEvent = Extract<BoardEvent, { readonly type: "plugin" }>

const lastByKey = Atom.family((key: string) =>
  Atom.make((get): PluginEvent | null => {
    const [host = "", plugin = ""] = key.split("\u0000")
    const board = Option.getOrUndefined(AsyncResult.value(get(hostBoardAtom(HostId.make(host)))))
    return board?.plugins.get(plugin)?.last ?? null
  }),
)

/** The latest event of a host's plugin (null before any): a frame of the plugin's passes each new one on. */
export const pluginEventAtom = (host: string, plugin: string): Atom.Atom<PluginEvent | null> => lastByKey(`${host}\u0000${plugin}`)

/**
 * A call of a plugin's page (`huntaway.call` in its frame), on the plugin's host: not a mutation, as most only read and
 * a page calls as it opens; what a call changes, the plugin says with an event.
 */
export const pluginCall = (host: string, plugin: string, method: string, payload: unknown) => callRpc(host, "plugins.call", { plugin, method, payload })
