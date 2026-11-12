import { useAtomValue } from "@effect/atom-react"
import { query, type QueryResult } from "@huntaway/client"
import type { Host } from "@huntaway/contracts"
import { AsyncResult, Atom } from "effect/reactivity"
import { resultValue } from "../../ui"

/** No hub to ask yet. */
const noStatus: Atom.Atom<QueryResult<"admin.status">> = Atom.make<QueryResult<"admin.status">>(AsyncResult.initial())

/**
 * The commit an Update sends a host (`hub.hosts.pushUpdate`, whose bundle is the hub's checkout's HEAD): the hub's
 * checkout as it is (which can be ahead of the server running it), or without a checkout the commit it runs. The hub's
 * `admin.status` is read again once it has booted again (on another commit, most likely: invalidate.ts).
 */
export function useUpdateCommit(local: Host | undefined): string | null {
  const status = resultValue(useAtomValue(local ? query("admin.status", local.id, undefined) : noStatus))
  const running = local?.commit ?? null
  return (status?.source_dir ? status.source_commit : null) ?? running
}
