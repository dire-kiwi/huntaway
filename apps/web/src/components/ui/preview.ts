import { useCallback, useSyncExternalStore } from "react"
import { rpc } from "../../state/rpc"

// Whether a task's preview URL answers (`board.previewStatus`, asked of the task's host: a browser can't read a
// cross-origin response's status). Polled every 2 s while a preview is shown and the window is visible, one poller per
// URL shared by every component showing it, two checks at most waiting on the server at once (HA-188).

/** Whether a preview URL answers 200: null until the first check comes back. */
export type PreviewUp = boolean | null

const POLL_MS = 2000

/** One poller per host and URL, shared by every component showing it. */
interface Poller {
  readonly host: string
  readonly url: string
  up: PreviewUp
  readonly listeners: Set<() => void>
  timer: number | null
  inflight: boolean
}

const pollers = new Map<string, Poller>()
/** Last result per host and URL, so a card that remounts (moved to another column, say) doesn't flicker. */
const last = new Map<string, boolean>()

/**
 * How many checks may be waiting on the server at once. A check of a preview that doesn't answer holds its request for
 * the server's timeout (5 s), and a browser opens only 6 connections to a host over HTTP/1.1: a board with more such
 * previews than that kept every connection busy, so loading a thread waited seconds behind them (HA-188).
 */
export const MAX_CHECKS = 2
let checking = 0
const waiting: Array<() => void> = []

async function limited<T>(f: () => Promise<T>): Promise<T> {
  if (checking >= MAX_CHECKS) {
    const { promise, resolve } = Promise.withResolvers<void>()
    waiting.push(resolve)
    await promise
  } else checking++
  try {
    return await f()
  } finally {
    // The slot goes to the next waiting check, if there is one.
    const next = waiting.shift()
    if (next) next()
    else checking--
  }
}

const keyOf = (host: string, url: string) => `${host}\n${url}`

async function check(key: string, p: Poller) {
  p.timer = null
  if (document.hidden) return // resumed by the visibilitychange handler
  p.inflight = true
  let up = false
  try {
    // Nobody may be watching any more by the time a slot is free.
    up = (await limited(() => (pollers.get(key) === p ? rpc(p.host, "board.previewStatus", { url: p.url }) : Promise.resolve(null))))?.up ?? false
  } catch {
    /* counts as not up */
  }
  p.inflight = false
  if (pollers.get(key) !== p) return // nobody is watching any more
  last.set(key, up)
  if (up !== p.up) {
    p.up = up
    p.listeners.forEach((l) => l())
  }
  p.timer = window.setTimeout(() => void check(key, p), POLL_MS)
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) return
  for (const [key, p] of pollers) if (p.timer === null && !p.inflight) void check(key, p)
})

function subscribe(host: string, url: string, listener: () => void) {
  const key = keyOf(host, url)
  let p = pollers.get(key)
  if (!p) {
    p = { host, url, up: last.get(key) ?? null, listeners: new Set(), timer: null, inflight: false }
    pollers.set(key, p)
    void check(key, p)
  }
  const poller = p
  poller.listeners.add(listener)
  return () => {
    poller.listeners.delete(listener)
    if (poller.listeners.size === 0) {
      if (poller.timer !== null) clearTimeout(poller.timer)
      pollers.delete(key)
    }
  }
}

/** Polls `url` on host `host` every 2 s while mounted (and the window is visible). Pass null to not poll. */
export function usePreviewUp(url: string | null | undefined, host: string): PreviewUp {
  const sub = useCallback((l: () => void) => (url ? subscribe(host, url, l) : () => {}), [host, url])
  return useSyncExternalStore(sub, () => (url ? (pollers.get(keyOf(host, url))?.up ?? last.get(keyOf(host, url)) ?? null) : null))
}
