import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react"
import type { RenderedDocVersion } from "@huntaway/contracts"
import { navigate } from "../../../state/route"
import { followsFrameInput, fromFrame, openable, trackBoardInput } from "../../task/htmlFrame"
import { docFrame } from "../docFrame"
import type { useCommentMarks } from "./useCommentMarks"

type Marks = ReturnType<typeof useCommentMarks>

const str = (x: unknown) => (typeof x === "string" ? x : "")

/**
 * The frame a document's page is shown in: its source, which keeps the reader's place, and what the page tells the
 * board (a selection to comment on, the comments it found, where it scrolled, a link to open).
 */
export function useDocFrame(
  frame: RefObject<HTMLIFrameElement | null>,
  {
    current,
    theme,
    shownVersion,
    setDraft,
    showComments,
    setFound,
    setActive,
  }: {
    current: RenderedDocVersion["pages"][number] | undefined
    /** The board's colours, for the page (boardTheme). */
    theme: string
    shownVersion: number | undefined
  } & Pick<Marks, "setDraft" | "showComments" | "setFound" | "setActive">,
) {
  // A link of the page's that the user is asked about before it opens.
  const [asked, setAsked] = useState<string | null>(null)
  const latestShown = useRef({ shownVersion, path: current?.path })
  useLayoutEffect(() => {
    latestShown.current = { shownVersion, path: current?.path }
  })
  // Where the reader is in the page (the frame reports it), to stay there when it's shown again with a new version, and
  // the `#heading` it opened at until then. Kept with the page, so that working it out again (StrictMode does, in dev)
  // gives the same frame (HA-286). The frame's source is set as it's drawn, as where it was scrolled to is for then.
  const place = useRef<{ key: string; y: number; hash: string }>({ key: "", y: 0, hash: "" })
  const html = current?.html ?? null
  const path = current?.path
  useLayoutEffect(() => {
    const el = frame.current
    if (html === null || path === undefined || !el) return
    if (place.current.key !== path) place.current = { key: path, y: 0, hash: window.location.hash.slice(1) }
    el.setAttribute("srcdoc", docFrame(html, theme, place.current.hash, place.current.y))
  }, [frame, html, path, theme])

  // The frame's links: those to the board's own pages open here, others in a new tab, after the user's own click.
  useEffect(() => {
    trackBoardInput()
    const onMessage = (e: MessageEvent) => {
      if (e.source === frame.current?.contentWindow && e.data && typeof e.data === "object") {
        const d = e.data
        const { shownVersion: v, path: at } = latestShown.current
        if (d.iaComment && typeof d.iaComment.quote === "string" && v !== undefined && at !== undefined) {
          setDraft({ version: v, page: at, quote: d.iaComment.quote, prefix: str(d.iaComment.prefix), suffix: str(d.iaComment.suffix) })
          showComments(true)
        }
        if (Array.isArray(d.iaFound)) setFound(new Set(d.iaFound.filter((x: unknown) => typeof x === "number")))
        if (typeof d.iaFocus === "number") {
          setActive(d.iaFocus)
          showComments(true)
        }
      }
      if (e.source === frame.current?.contentWindow && typeof e.data?.iaScroll === "number") {
        // Scrolled (to the heading, or from it): a new version opens where the reader is.
        place.current.y = e.data.iaScroll
        place.current.hash = ""
      }
      if (typeof e.data?.iaOpen !== "string" || !fromFrame(frame.current, e.source)) return
      let url: URL
      try {
        url = new URL(e.data.iaOpen)
      } catch {
        return
      }
      if (url.origin === window.location.origin) {
        if (navigator.userActivation?.isActive) navigate(url.pathname + url.search + url.hash)
        return
      }
      if (!openable(url.href)) return
      if (followsFrameInput(frame.current)) window.open(url.href, "_blank", "noopener,noreferrer")
      else if (navigator.userActivation?.isActive) setAsked(url.href)
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [frame, setDraft, showComments, setFound, setActive])

  return { doc: html !== null, asked, setAsked }
}
