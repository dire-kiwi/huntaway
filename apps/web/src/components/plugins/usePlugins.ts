import { useAtomValue } from "@effect/atom-react"
import { query, type QueryResult } from "@huntaway/client"
import type { PluginInfo } from "@huntaway/contracts"
import { AsyncResult, Atom } from "effect/reactivity"
import { resultValue } from "../ui/Loading"

// HE-34: a host's plugins (`plugins.list`), read while something shows them.

const none: Atom.Atom<QueryResult<"plugins.list">> = Atom.make<QueryResult<"plugins.list">>(AsyncResult.initial())
const empty: ReadonlyArray<PluginInfo> = []

/** The plugins of `host` (none until they're read, or with no host). */
export function usePlugins(host: string | null): ReadonlyArray<PluginInfo> {
  return resultValue(useAtomValue(host ? query("plugins.list", host, undefined) : none)) ?? empty
}
