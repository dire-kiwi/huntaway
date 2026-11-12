import { useAtom } from "@effect/atom-react"
import { Schema } from "effect"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react"
import { storedBare } from "../../../state/storage"
import type { CommentDraft, useDocComments } from "../DocComments"

/** Whether the document page shows its comments panel ("0" hides it): the user's choice, kept in this browser. */
const commentsShownAtom = storedBare("ia.docComments", Schema.Literals(["0", "1"]), null)

/**
 * The comments of the page that's shown (HA-302): whether their panel is, the comment being written, the one chosen,
 * and what the page's frame is told to highlight.
 */
export function useCommentMarks(
  frame: RefObject<HTMLIFrameElement | null>,
  {
    data,
    commenting,
    shownVersion,
    path,
  }: { data: ReturnType<typeof useDocComments>["data"]; commenting: boolean; shownVersion: number | undefined; path: string | undefined },
) {
  const [shown, setShown] = useAtom(commentsShownAtom)
  const commentsShown = shown !== "0"
  const showComments = useCallback((on: boolean) => setShown(on ? "1" : "0"), [setShown])
  const [draft, setDraft] = useState<CommentDraft | null>(null)
  // The shown page's comments the frame found, and the one chosen (in the page or the panel).
  const [found, setFound] = useState<Set<number> | null>(null)
  const [active, setActive] = useState<number | null>(null)

  const pageComments = useMemo(() => (data?.comments ?? []).filter((m) => m.version === shownVersion && m.page === path), [data, shownVersion, path])
  // What the frame highlights: the shown page's comments and the draft's quote (see docFrame's docComments). Sent when
  // it changes, and when the frame (re)loads (`toFrame`).
  const message = useMemo(() => {
    const onPage = draft && draft.version === shownVersion && draft.page === path ? draft : null
    return {
      iaComments: pageComments.map((m) => ({ id: m.id, quote: m.quote, prefix: m.prefix, suffix: m.suffix })),
      enabled: commenting && data !== null,
      draft: onPage && { quote: onPage.quote, prefix: onPage.prefix, suffix: onPage.suffix },
      active,
    }
  }, [pageComments, draft, shownVersion, path, commenting, data, active])
  const toFrame = useRef<() => void>(() => {})
  useLayoutEffect(() => {
    toFrame.current = () => frame.current?.contentWindow?.postMessage(message, "*")
  })
  useEffect(() => frame.current?.contentWindow?.postMessage(message, "*"), [frame, message])

  return { commentsShown, showComments, draft, setDraft, found, setFound, active, setActive, toFrame }
}
