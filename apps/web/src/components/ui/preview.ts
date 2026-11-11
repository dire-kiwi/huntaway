// Whether a task's preview URL answers. The old board polled `previewStatus` every 2 s for each preview shown (two
// checks at most in flight, HA-188); the new server has no `board.previewStatus` yet (docs/plan/05-protocol.md), so
// until it does a preview's state is unknown and its dot shows as not checked. The poller comes back with the RPC.

/** Whether a preview URL answers 200: null until the first check comes back. */
export type PreviewUp = boolean | null

/** At most this many checks wait on the server at once (HA-188). */
export const MAX_CHECKS = 2

/** Not yet on this server: always unknown. */
export function usePreviewUp(_url: string | null | undefined): PreviewUp {
  return null
}
