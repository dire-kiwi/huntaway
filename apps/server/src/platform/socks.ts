import { Effect } from "effect"
import type { Scope } from "effect"
import { HttpClient } from "effect/http"
import type { buildConnector } from "undici"
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
    return refuse("give a SOCKS5 proxy's address, like socks5://127.0.0.1:1080")
  }
  if (url.username !== "" || url.password !== "") return refuse("no user or password: the browser can't sign in to a SOCKS proxy")
  if ((url.pathname !== "" && url.pathname !== "/") || url.search !== "" || url.hash !== "") {
    return refuse("a host and port only, like socks5://127.0.0.1:1080")
  }
  return Effect.succeed(`socks5://${url.hostname}:${url.port === "" ? SOCKS_PORT : url.port}`)
}

/** A URL's host name without the brackets an IPv6 address has there (`[::1]` is `::1`). */
const bare = (hostname: string) => hostname.replace(/^\[(.*)\]$/u, "$1")

/** Whether a host name is this machine's (localhost, 127.0.0.0/8, ::1): its pages aren't proxied. */
export const isLoopback = (hostname: string): boolean => {
  const h = bare(hostname.toLowerCase())
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(h)
}

/** Whether a request to `url` goes through `proxy`: there is one, and the page isn't on this machine. */
export const proxiedTo = (proxy: string | null | undefined, url: string): proxy is string => {
  if (proxy == null) return false
  const to = URL.parse(url)
  return to !== null && !isLoopback(to.hostname)
}

/** How long the proxy has to take a connection (undici's default for its SOCKS5 agent). */
const CONNECT_MS = 5000

/** How many redirects a request follows, as `fetch` does for the checks that don't go through the proxy. */
const REDIRECTS = 20

/**
 * The connection to the proxy itself: undici's, given the proxy's host without the brackets an IPv6 address has in a URL
 * (`[::1]`), which undici's SOCKS5 agent passes on as they are.
 */
const toProxy = (build: typeof buildConnector): buildConnector.connector => {
  const connect = build({ timeout: CONNECT_MS })
  return (options, callback) =>
    connect({ ...options, hostname: bare(options.hostname), ...(options.host === undefined ? {} : { host: bare(options.host) }) }, callback)
}

/**
 * An HTTP client whose requests all go through the SOCKS5 proxy `proxy` (as `checkSocksProxy` stores it), for the
 * scope. It follows redirects, as the server's own client (`fetch`) does. undici and platform-node's client on it are
 * loaded here, the first time a host with a proxy needs them, not as the server starts (HE-71: about 230 modules).
 */
export const socksClient = (proxy: string): Effect.Effect<HttpClient.HttpClient, never, Scope.Scope> =>
  Effect.gen(function* () {
    const [{ buildConnector, Socks5ProxyAgent }, NodeHttpClient] = yield* Effect.promise(() =>
      Promise.all([import("undici"), import("@effect/platform-node/NodeHttpClient")]),
    )
    const agent = yield* Effect.acquireRelease(
      Effect.sync(() => new Socks5ProxyAgent(proxy, { connect: toProxy(buildConnector) })),
      (made) => Effect.promise(() => made.destroy().catch(() => undefined)),
    )
    return HttpClient.followRedirects(yield* Effect.provideService(NodeHttpClient.makeUndici, NodeHttpClient.Dispatcher, agent), REDIRECTS)
  })

/** Chrome's flags for `proxy`: none without one. Chrome itself leaves this machine's pages out of it. */
export const chromeProxyArgs = (proxy: string | null): ReadonlyArray<string> => (proxy === null ? [] : [`--proxy-server=${proxy}`])
