import { useCallback, useEffect, useRef, useState } from "react"
import { ProfileId, type DocDetail } from "@huntaway/contracts"
import type { DocsHome } from "../docs"
import { isTagged, rpc } from "../../../state/rpc"
import { errorText } from "../../ui"

interface Found {
  readonly home?: DocsHome | undefined
  readonly detail?: DocDetail | undefined
  readonly missing: boolean
  readonly error?: string | undefined
}

/** The document's host, of those the route's profile stands for: the first that has it. */
export function useDocHome(homes: DocsHome[], slug: string): Found & { reload: () => void } {
  const [state, setState] = useState<Found>({ missing: false })
  const seq = useRef(0)
  const reload = useCallback(() => {
    const n = ++seq.current
    void Promise.allSettled(homes.map((h) => rpc(h.hostId, "docs.get", { profile_id: ProfileId.make(h.profileId), slug }))).then((got) => {
      if (n !== seq.current) return
      const i = got.findIndex((g) => g.status === "fulfilled")
      const found = got[i]
      if (found !== undefined && found.status === "fulfilled") return setState({ home: homes[i], detail: found.value, missing: false })
      const other = got.find((g) => g.status === "rejected" && !isTagged(g.reason, "NotFound"))
      setState({ missing: other === undefined, error: other !== undefined && other.status === "rejected" ? errorText(other.reason) : undefined })
    })
  }, [homes, slug])
  useEffect(reload, [reload])
  return { ...state, reload }
}
