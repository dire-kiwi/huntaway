// The hosts' profiles a Docs route stands for, and what tells a link to a document that it changed.
import { useEffect, useEffectEvent, useMemo } from "react"
import { docsSeqAtom } from "@huntaway/client"
import { docsHomes, type DocsHome } from "../docs"
import { useBoard } from "../../../state/board"
import { registry } from "../../../state/registry"

/** The hosts' profiles the route's profile stands for, kept as long as they don't change. */
export function useHomes(segment: string): { name: string; homes: DocsHome[] } {
  // One string, so that the board's other changes don't draw the page again.
  const key = useBoard((s) => {
    const { name, homes } = docsHomes(s.profiles, s.hosts, segment)
    return [name, ...homes.map((h) => `${h.hostId}\u0000${h.profileId}`)].join("\n")
  })
  return useMemo(() => {
    const [name = segment, ...homes] = key.split("\n")
    return {
      name,
      homes: homes.map((h) => {
        const [hostId = "", profileId = ""] = h.split("\u0000")
        return { hostId, profileId }
      }),
    }
  }, [key, segment])
}

/**
 * Calls `fn` when a document of one of `homes` is published, moved, relabelled or deleted (6.3: the latest `docs` event
 * of the host's, which `@huntaway/client` keeps). The Docs page's own reads follow these events by themselves (their
 * queries' triggers, invalidate.ts): this is for what doesn't read through a query yet (a message's link to a document).
 */
export function useDocsChanged(homes: ReadonlyArray<DocsHome>, fn: () => void) {
  const call = useEffectEvent(fn)
  useEffect(() => {
    const offs = homes.map((h) => registry.subscribe(docsSeqAtom(h.hostId, "docs", h.profileId), () => call()))
    return () => offs.forEach((off) => off())
  }, [homes])
}
