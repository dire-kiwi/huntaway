import { Cause, Exit } from "effect"
import { boardAtom, callHub, serverUrlAtom, tokenAtom, tokenPendingAtom } from "@huntaway/client"
import { registry } from "./registry"
import { isTagged, runExit } from "./mutation"

// The board token (inventory 10, section 2.1): from `?token=` once (how the desktop shell and shared links sign in),
// else the one this browser keeps (`ia.token`), else, on a board started with `--open-token` (PR previews, test
// servers), the one it hands out (`public.openToken`). A token turned down shows the token screen, unless the board
// hands out a new one (a rebuilt preview does).

const TOKEN_KEY = "ia.token"
/** Whether this board handed out its token last time ("1") or not ("0"), so a load with a token need not ask again. */
const OPEN_KEY = "ia.openBoard"

// Storage may throw (a browser that blocks it): then there is no token kept, and nothing remembered.
function load(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function save(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
  } catch {
    // Kept for this page only: the token is in the atom.
  }
}

/**
 * Whether this board hands out its token (a PR preview, a test server with `--open-token`): its agents and demo tasks
 * would notify alongside the user's own board, from a board they're only trying (6.8).
 */
export const isOpenBoard = (): boolean => load(OPEN_KEY) === "1"

/** The websocket URL of this page's server's RPC: `/api/rpc` on the page's own host (vite proxies it in dev). */
export const rpcUrl = (location: Pick<Location, "protocol" | "host">): string => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/rpc`

/** Takes `?token=` off the page's URL, if it has one, and keeps it. */
function captureTokenFromUrl(): void {
  const url = new URL(window.location.href)
  const token = url.searchParams.get("token")
  if (!token) return
  save(TOKEN_KEY, token)
  url.searchParams.delete("token")
  window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash)
}

/** Signs in with `token`: kept in this browser, and every session reconnects with it. */
export function signIn(token: string): void {
  save(TOKEN_KEY, token)
  registry.set(tokenAtom, token)
}

/** Forgets the token: the token screen shows. */
export function signOut(): void {
  save(TOKEN_KEY, null)
  registry.set(tokenAtom, "")
}

/** Asks the board for the token it hands out, if it does; resolves to whether that changed the token. */
function fetchOpenToken(): Promise<boolean> {
  return runExit(callHub("public.openToken", undefined)).then((exit) => {
    if (Exit.isFailure(exit)) {
      // Not offered: not asked again on the next load with a token.
      if (isTagged(Cause.squash(exit.cause), "NotFound")) save(OPEN_KEY, "0")
      return false
    }
    save(OPEN_KEY, "1")
    const { token } = exit.value
    if (!token || token === registry.get(tokenAtom)) return false
    signIn(token)
    return true
  })
}

/**
 * Before the first render (main.tsx): the server's URL and the token. With no token, a board that hands out its own is
 * asked first, and the board is held meanwhile so the token screen does not flash; with one, the board shows at once
 * and the open token is checked behind it unless this board did not hand one out last time.
 */
export function startAuth(): void {
  captureTokenFromUrl()
  registry.set(serverUrlAtom, rpcUrl(window.location))
  const token = load(TOKEN_KEY)
  registry.set(tokenAtom, token ?? "")
  if (token === null) {
    registry.set(tokenPendingAtom, true)
    void fetchOpenToken().finally(() => registry.set(tokenPendingAtom, false))
  } else if (load(OPEN_KEY) !== "0") void fetchOpenToken()
  // A token turned down is asked for again, unless the board hands out a new one.
  let refused = false
  registry.subscribe(
    boardAtom,
    (b) => {
      const now = b.authed === false
      if (now && !refused && load(OPEN_KEY) !== "0") void fetchOpenToken()
      refused = now
    },
    { immediate: true },
  )
  // Another tab signed in or out.
  window.addEventListener("storage", (e) => {
    if (e.key === TOKEN_KEY) registry.set(tokenAtom, e.newValue ?? "")
  })
}
