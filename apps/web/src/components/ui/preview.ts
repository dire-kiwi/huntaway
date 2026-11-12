import { useAtomValue } from "@effect/atom-react"
import { AsyncResult, Atom } from "effect/reactivity"
import { query } from "@huntaway/client"
import { useVisible } from "../../state/visibility"

// Whether a task's preview URL answers (`board.previewStatus`, asked of the task's host: a browser can't read a
// cross-origin response's status). Read every 2 s while a preview is shown and the page is visible, one query per host
// and URL shared by everything showing it, and kept ten seconds after the last (a card moved to another column doesn't
// flicker). The old limit of two checks waiting at once (HA-188) was for the browser's six HTTP connections to a host;
// the checks now share the page's one RPC socket.

/** Whether a preview URL answers 200: null until the first check comes back. */
export type PreviewUp = boolean | null

const POLL = "2 seconds"

/** What is read for no URL: nothing. */
const notPolled: Atom.Atom<AsyncResult.AsyncResult<{ readonly up: boolean }>> = Atom.make(AsyncResult.initial())

const upOf = (r: AsyncResult.AsyncResult<{ readonly up: boolean }, unknown>): PreviewUp =>
  // A check that failed counts as not up.
  AsyncResult.isFailure(r) ? false : AsyncResult.isSuccess(r) ? r.value.up : null

/** Polls `url` on host `host` every 2 s while mounted (and the page is visible). Pass null to not poll. */
export function usePreviewUp(url: string | null | undefined, host: string): PreviewUp {
  const visible = useVisible()
  const checked = useAtomValue<AsyncResult.AsyncResult<{ readonly up: boolean }, unknown>>(
    url ? query("board.previewStatus", host, { url }, { refresh: visible ? POLL : undefined }) : notPolled,
  )
  return url ? upOf(checked) : null
}
