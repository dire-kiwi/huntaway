import { NodeHttpClient } from "@effect/platform-node"
import { Effect } from "effect"
import type { Scope } from "effect"
import type { HttpClient } from "effect/http"
import { Socks5ProxyAgent } from "undici"
import { Invalid } from "@huntaway/contracts"

// HE-67: the host's SOCKS proxy (Settings → the host's page, `socks_proxy`), which its preview checks
// (`PullRequests.previewStatus`) and its tasks' headless browser (`--proxy-server`) reach pages through: for previews
// only reachable over a VPN or an SSH tunnel (`ssh -D 1080 jumphost`). Names are resolved at the proxy, as Chrome does
// with a SOCKS5 proxy. Pages on this machine never go through it, as Chrome doesn't send them there either.

/** The port a SOCKS proxy given without one is on. */
const SOCKS_PORT = "1080"

const SCHEMES: ReadonlySet<string> = new Set(["socks5:", "socks5h:", "socks:"])

const refuse = (reason: string) => Effect.fail(new Invalid({ field: "socks_proxy", reason }))

/**
 * A SOCKS proxy as stored: `socks5://host:port`, from `socks5://`, `socks5h://` or `socks://` (each resolves names at
 * the proxy here), on port 1080 when it has none. Blank is none. Without a user or password, which Chrome can't give.
 */
export const checkSocksProxy = (given: string): Effect.Effect<string | null, Invalid> => {
  const text = given.trim()
  if (text === "") return Effect.succeed(null)
  const url = URL.parse(text)
  if (url === null || !SCHEMES.has(url.protocol) || url.hostname === "") {
    return refuse("socks_proxy must be a SOCKS5 proxy's address, like socks5://127.0.0.1:1080")
  }
  if (url.username !== "" || url.password !== "") return refuse("socks_proxy can't have a user or password: the browser can't sign in to a SOCKS proxy")
  if ((url.pathname !== "" && url.pathname !== "/") || url.search !== "" || url.hash !== "") {
    return refuse("socks_proxy is a host and port only, like socks5://127.0.0.1:1080")
  }
  return Effect.succeed(`socks5://${url.hostname}:${url.port === "" ? SOCKS_PORT : url.port}`)
}

/** Whether a host name is this machine's (localhost, 127.0.0.0/8, ::1): its pages aren't proxied. */
export const isLoopback = (hostname: string): boolean => {
  const h = hostname.toLowerCase().replace(/^\[(.*)\]$/u, "$1")
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(h)
}

/** Whether a request to `url` goes through `proxy`: there is one, and the page isn't on this machine. */
export const proxiedTo = (proxy: string | null | undefined, url: string): proxy is string => {
  if (proxy == null) return false
  const to = URL.parse(url)
  return to !== null && !isLoopback(to.hostname)
}

/** An HTTP client whose requests all go through the SOCKS5 proxy `proxy` (as `checkSocksProxy` stores it), for the scope. */
export const socksClient = (proxy: string): Effect.Effect<HttpClient.HttpClient, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => new Socks5ProxyAgent(proxy)),
    (agent) => Effect.promise(() => agent.destroy().catch(() => undefined)),
  ).pipe(Effect.flatMap((agent) => Effect.provideService(NodeHttpClient.makeUndici, NodeHttpClient.Dispatcher, agent)))

/** Chrome's flags for `proxy`: none without one. Chrome itself leaves this machine's pages out of it. */
export const chromeProxyArgs = (proxy: string | null): ReadonlyArray<string> => (proxy === null ? [] : [`--proxy-server=${proxy}`])
