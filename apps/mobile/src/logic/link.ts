// A board as the app reaches it: its address and its token, from what the user pasted, typed or scanned. The board's
// Settings → Network access gives `http://<host>:<port>/?token=<token>`; a bare address is taken too (its token typed
// apart, or handed out by a board started with `--open-token`). Parsed by hand: React Native's `URL` and
// `URLSearchParams` leave most of their getters unimplemented.

/** A board the app connects to. */
export interface BoardLink {
  /** The board's address, `http(s)://host[:port]`, lower case, with no path or trailing slash. */
  readonly url: string
  /** Its token; empty when the link had none. */
  readonly token: string
}

const LINK = /^(?:([a-z][a-z0-9+.-]*):\/\/)?([^/?#\s]*)([^?#\s]*)(?:\?([^#\s]*))?(?:#\S*)?$/i
const HOST = /^(?:\[[0-9a-f:.]+\]|[a-z0-9._~%-]+)(?::(\d{1,5}))?$/i

/** A query string's `token`, decoded. */
const tokenIn = (query: string): string => {
  for (const pair of query.split("&")) {
    const [name = "", value = ""] = pair.split("=")
    if (name === "token") {
      try {
        return decodeURIComponent(value.replaceAll("+", " "))
      } catch {
        return value
      }
    }
  }
  return ""
}

/**
 * What the user gave as a board link, or why it isn't one (pure). An address with no scheme is taken as `http://` (a
 * phone's keyboard makes typing one slow); only http and https are boards.
 */
export function parseBoardLink(text: string): BoardLink | { readonly error: string } {
  const given = text.trim()
  if (given === "") return { error: "Give the board's address." }
  const m = LINK.exec(given)
  if (!m) return { error: "That isn't an address." }
  const [, scheme = "http", host = "", , query = ""] = m
  const protocol = scheme.toLowerCase()
  if (protocol !== "http" && protocol !== "https") return { error: "A board's address starts with http:// or https://." }
  if (host === "") return { error: "That address has no host." }
  const port = HOST.exec(host)
  if (!port || (port[1] !== undefined && Number(port[1]) > 65_535)) return { error: "That isn't an address." }
  return { url: `${protocol}://${host.toLowerCase()}`, token: tokenIn(query) }
}

/** The websocket address of a board's RPC (`/api/rpc`), from its address (pure). */
export const rpcUrl = (url: string): string => `${url.replace(/^http/i, "ws")}/api/rpc`

/** Whether a board's address is plain HTTP to another machine, so its token travels unencrypted (pure). */
export const insecure = (url: string): boolean => {
  if (!url.startsWith("http://")) return false
  const host = url.slice("http://".length).replace(/:\d+$/, "")
  return !["localhost", "127.0.0.1", "[::1]", "10.0.2.2"].includes(host)
}
