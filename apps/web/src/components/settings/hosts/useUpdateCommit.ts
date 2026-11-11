import type { Host } from "@huntaway/contracts"
import { useEffect, useState } from "react"
import { rpc } from "../../../state/rpc"

/**
 * The commit an Update sends a host (`hub.hosts.pushUpdate`, whose bundle is the hub's checkout's HEAD): the hub's
 * checkout as it is (which can be ahead of the server running it), or without a checkout the commit it runs.
 */
export function useUpdateCommit(local: Host | undefined): string | null {
  // Read again once the hub runs another commit (its checkout moved on, most likely).
  const [checkout, setCheckout] = useState<{ host: string; running: string | null; commit: string | null } | null>(null)
  const id = local?.id
  const running = local?.commit
  useEffect(() => {
    if (!id) return undefined
    const req = { live: true }
    rpc(id, "admin.status", undefined).then(
      (s) => {
        if (req.live) setCheckout({ host: id, running: running ?? null, commit: s.source_dir ? (s.source_commit ?? null) : null })
      },
      () => {
        // Its running commit, then.
      },
    )
    return () => {
      req.live = false
    }
  }, [id, running])
  return (checkout && checkout.host === id && checkout.running === (running ?? null) ? checkout.commit : null) ?? running ?? null
}
