// The hosts' profiles a Docs route stands for, and what tells the page their documents changed.
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
 * Calls `fn` when the board says something of `homes` changed (6.3: the latest `kind` event of the host's, which
 * `@huntaway/client` keeps): their documents (`docs`), a document's comments (`comments`, with `slug`), or their
 * connection to their docs site (`site`).
 */
function useDocsEvent(kind: "docs" | "comments" | "site", homes: DocsHome[], fn: () => void, slug?: string) {
  const call = useEffectEvent(fn)
  useEffect(() => {
    const offs = homes.map((h) => registry.subscribe(docsSeqAtom(h.hostId, kind, h.profileId, slug ?? ""), () => call()))
    return () => offs.forEach((off) => off())
  }, [kind, homes, slug])
}

/** Calls `fn` when a document of one of `homes` is published, moved, relabelled or deleted. */
export const useDocsChanged = (homes: DocsHome[], fn: () => void) => useDocsEvent("docs", homes, fn)

/** Calls `fn` when the hosted docs connection of one of `homes` changes (documents' published state is for it). */
export const useDocsSiteChanged = (homes: DocsHome[], fn: () => void) => useDocsEvent("site", homes, fn)

/** Calls `fn` when document `slug`'s comments of one of `homes` change. */
export const useDocCommentsChanged = (homes: DocsHome[], slug: string, fn: () => void) => useDocsEvent("comments", homes, fn, slug)
