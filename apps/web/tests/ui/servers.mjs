// What the server and host checks fake (hostRelease, hostUpdate, releaseUpdate): a host's `admin.*` and what the hub
// says of its hosts, where the old checks routed `/api/admin/*`, `/api/h/<host>/admin/*` and `/api/hosts` with
// `page.route`. A test server never reaches GitHub or a real release, and its Rebuild & restart would rebuild this
// checkout: every `admin.*` call that would start one is answered here.
import { success } from "./harness.mjs"

/**
 * Sits between the page and its servers on every RPC socket: the page's own (`/api/rpc`) and the relays to linked hosts
 * (`/api/relay/<ticket>`). `handle(request, via)` (`via` "rpc" or "relay") returns undefined to let a request through,
 * or an answer (`success(…)`, `failure(…)`) to give instead. `rewrite(tag, value, via)` may change what the server
 * answers to a request of `tag` (each of a stream's values), returning the value to give. Every request is recorded in
 * `calls` (`{ tag, payload, via }`). `push(event)` sends the page an event on its own board stream (`board.watch`):
 * give it a `seq` past the board's (1_000_000 and up), after which the server's own events are behind it and dropped.
 * Call it before the page opens.
 */
export async function routeSockets(page, { handle = () => undefined, rewrite = (_tag, value, _via) => value } = {}) {
  const calls = []
  const sockets = []
  const route = (via) => (ws) => {
    const at = { ws, watch: null, acks: 0, tags: new Map() }
    if (via === "rpc") sockets.push(at)
    const upstream = ws.connectToServer()
    upstream.onMessage((message) => {
      const lines = String(message)
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const m = JSON.parse(line)
          const tag = at.tags.get(m.requestId)
          if (tag === undefined) return line
          if (m._tag === "Chunk") return JSON.stringify({ ...m, values: m.values.map((v) => rewrite(tag, v, via)) })
          if (m._tag === "Exit" && m.exit?._tag === "Success") return JSON.stringify({ ...m, exit: { ...m.exit, value: rewrite(tag, m.exit.value, via) } })
          return line
        })
      ws.send(`${lines.join("\n")}\n`)
    })
    ws.onMessage((message) => {
      for (const line of String(message).split("\n").filter(Boolean)) {
        const r = JSON.parse(line)
        // The page's acknowledgement of a chunk this gave it, which its server never sent.
        if (r._tag === "Ack" && r.requestId === at.watch && at.acks > 0) {
          at.acks--
          continue
        }
        if (r._tag !== "Request") {
          upstream.send(`${line}\n`)
          continue
        }
        at.tags.set(r.id, r.tag)
        if (r.tag === "board.watch") at.watch = r.id
        calls.push({ tag: r.tag, payload: r.payload, via })
        void Promise.resolve(handle(r, via)).then((exit) => {
          if (exit === undefined) upstream.send(`${line}\n`)
          else ws.send(`${JSON.stringify({ _tag: "Exit", requestId: r.id, exit })}\n`)
        })
      }
    })
  }
  await page.routeWebSocket(/\/api\/rpc$/, route("rpc"))
  await page.routeWebSocket(/\/api\/relay\//, route("relay"))
  const push = (event) => {
    const at = sockets.findLast((s) => s.watch !== null)
    at.acks++
    at.ws.send(`${JSON.stringify({ _tag: "Chunk", requestId: at.watch, values: [event] })}\n`)
  }
  return { calls, push }
}

const ago = (s) => new Date(Date.now() - s * 1000).toISOString()

/** A release block of `admin.status`: a server with `--release-updates` running 0.1.0, with 0.2.0 staged. */
export function release(over = {}) {
  return {
    repo: "dire-kiwi/huntaway",
    running: "0.1.0",
    exe: "/srv/huntaway/app/0.1.0/huntaway",
    latest: {
      version: "0.2.0",
      prerelease: false,
      published_at: ago(86400),
      notes: "## What's new\n\n- **Faster** boards",
      url: "https://github.com/dire-kiwi/huntaway/releases/tag/v0.2.0",
      asset: { name: "huntaway-server-0.2.0-linux-x64.tar.gz", url: "https://example.invalid/s.tar.gz", size: 40e6, sha256: "ab" },
      newer: true,
    },
    prereleases: false,
    checked_at: ago(300),
    error: null,
    rate_limit_reset: null,
    shell: null,
    bundled_server: "/opt/huntaway-server/huntaway",
    staged: "0.2.0",
    download: null,
    previous: null,
    bad: [],
    rollback_to: "bundled",
    ...over,
  }
}

/** An `admin.status` answer: a server started an hour ago with no checkout, then `over`. */
export const serverStatus = (over = {}) => ({
  boot_id: "b1",
  started_at: ago(3600),
  version: "0.1.0",
  updates_from: over.release ? "releases" : null,
  source_dir: null,
  running_commit: null,
  running_agents: 1,
  restart: null,
  ...over,
})

/**
 * Answers `admin.status` (with `state()` over `serverStatus`), `admin.checkRelease`, `admin.updateRelease`,
 * `admin.rollback`, `admin.restart` and `admin.update` on the sockets `via` says (the page's own, "rpc", or the relays
 * to linked hosts, "relay"), recording what they were sent, and the `host.updateSettings` patches that go through.
 * `rewrite` is routeSockets'.
 */
export async function fakeAdmin(page, via, state, { rewrite } = {}) {
  const calls = { check: 0, update: [], rollback: 0, restart: [], settings: [] }
  const { push } = await routeSockets(page, {
    rewrite,
    handle: (r, on) => {
      if (on !== via) return undefined
      switch (r.tag) {
        case "admin.status":
          return success(serverStatus(state()))
        case "admin.checkRelease":
          calls.check++
          return success(serverStatus(state()))
        case "admin.updateRelease":
          calls.update.push(r.payload)
          return success(null)
        case "admin.rollback":
          calls.rollback++
          return success(null)
        case "admin.restart":
          calls.restart.push(r.payload)
          return success(null)
        case "admin.update":
          calls.update.push(r.payload)
          return success({ ok: true })
        case "host.updateSettings":
          calls.settings.push(r.payload.patch)
          return undefined
        default:
          return undefined
      }
    },
  })
  return { calls, push }
}
