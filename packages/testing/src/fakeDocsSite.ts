import { Effect, Option, Schema } from "effect"
import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

// A fake hosted docs site (dire-kiwi/docs) for the docs area's tests (docs/plan/10-testing.md; the old
// integrations/docs_site.test.ts's `Site`): an HTTP server in this process, on a free port of 127.0.0.1, with the OAuth
// endpoints a profile connects through (metadata, dynamic client registration, the device authorization grant and its
// token endpoint, refresh tokens that rotate) and the MCP endpoint's `list_documents`, `get_document` and
// `publish_document`. Nothing under test reaches a real docs site: a test gives the server this one's `url`.

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"

export interface FakeDevice {
  state: "pending" | "approved" | "denied" | "expired"
  readonly user_code: string
  readonly client_id: string
  polls: number
  /** How many more polls are answered `slow_down`. */
  slow_down: number
}

export interface FakeSiteDoc {
  readonly owner: string
  /** Who else can see it. */
  readonly shared?: ReadonlyArray<string>
  readonly title: string
  readonly folder?: string
  readonly versions: Array<{ readonly message: string | null; readonly pages: ReadonlyArray<unknown> }>
}

/** What the site holds and was asked: a test reads and changes it. */
export interface FakeDocsSiteState {
  /** Registered clients, by id: their grant types. */
  readonly clients: Map<string, ReadonlyArray<string>>
  readonly devices: Map<string, FakeDevice>
  /** Valid access tokens → user; refresh tokens → user (each works once). */
  readonly access: Map<string, string>
  readonly refresh: Map<string, string>
  readonly docs: Map<string, FakeSiteDoc>
  /** Each publish_document call's `folder`, `labels` and `images` arguments, in order. */
  readonly folders: Array<unknown>
  readonly labels: Array<unknown>
  readonly images: Array<unknown>
  /** Every request (`POST /oauth/token`), and what it did (`registered …`, `token <grant>`, `tool <name> as <user>`). */
  readonly log: Array<string>
  expires_in: number
  /** Answer with `javascript:` URLs where the board would open or link them. */
  evil: boolean
}

export interface FakeDocsSite {
  readonly url: string
  readonly state: FakeDocsSiteState
  /** Approve (or deny, or expire) the latest device sign-in, as the user would on `/device`. */
  readonly decide: (state: "approved" | "denied" | "expired") => void
  /** Done once the log has a line that `test` takes (at once if it has one already). */
  readonly logged: (test: (line: string) => boolean) => Effect.Effect<void>
}

const Json = Schema.fromJsonString(Schema.Unknown)
const parse = (text: string): unknown => Option.getOrNull(Schema.decodeOption(Json)(text))
const text = (v: unknown): string => Option.getOrElse(Schema.encodeUnknownOption(Json)(v), () => "null")
const field = (v: unknown, k: string): unknown =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? Object.entries(v).find(([n]) => n === k)?.[1] : undefined
const str = (v: unknown, k: string): string | undefined => {
  const x = field(v, k)
  return typeof x === "string" ? x : undefined
}

/** An OAuth error answer. */
const err = (status: number, error: string, d = error): readonly [number, unknown] => [status, { error, error_description: d }]

/** A fake docs site, listening until the scope closes. */
export const fakeDocsSite = Effect.gen(function* () {
  const state: FakeDocsSiteState = {
    clients: new Map(),
    devices: new Map(),
    access: new Map(),
    refresh: new Map(),
    docs: new Map(),
    folders: [],
    labels: [],
    images: [],
    log: [],
    expires_in: 3600,
    evil: false,
  }
  let n = 0
  let url = ""
  const waiters: Array<{ readonly test: (line: string) => boolean; readonly done: () => void }> = []
  const log = (line: string) => {
    state.log.push(line)
    for (const w of waiters.splice(0)) {
      if (w.test(line)) w.done()
      else waiters.push(w)
    }
  }
  const issue = (user: string) => {
    const [a, r] = [`at-${++n}`, `rt-${++n}`]
    state.access.set(a, user)
    state.refresh.set(r, user)
    return { access_token: a, token_type: "Bearer", expires_in: state.expires_in, refresh_token: r, scope: "docs" }
  }

  const handle = (req: IncomingMessage, raw: string): readonly [number, unknown] => {
    const path = new URL(req.url ?? "/", "http://x").pathname
    log(`${req.method ?? ""} ${path}`)
    const form = Object.fromEntries(new URLSearchParams(raw))
    if (path === "/.well-known/oauth-authorization-server") {
      return [
        200,
        {
          issuer: url,
          token_endpoint: `${url}/oauth/token`,
          registration_endpoint: `${url}/oauth/register`,
          device_authorization_endpoint: `${url}/oauth/device_authorization`,
        },
      ]
    }
    if (path === "/oauth/register") {
      const b = parse(raw)
      const grants = field(b, "grant_types")
      const id = `client-${++n}`
      state.clients.set(id, Array.isArray(grants) ? grants.map(String) : [])
      log(`registered ${str(b, "client_name") ?? ""} ${text(grants)} redirect_uris=${text(field(b, "redirect_uris") ?? null)}`)
      return [201, { client_id: id, grant_types: grants }]
    }
    if (path === "/oauth/device_authorization") {
      const client = form["client_id"] ?? ""
      if (!state.clients.has(client)) return err(401, "invalid_client", "unknown client; register it first")
      const code = `dc-${++n}`
      const user_code = `BCDF-${String(n).padStart(4, "G")}`
      state.devices.set(code, { state: "pending", user_code, client_id: client, polls: 0, slow_down: 0 })
      return [
        200,
        {
          device_code: code,
          user_code,
          verification_uri: `${url}/device`,
          verification_uri_complete: state.evil ? "javascript:alert(1)" : `${url}/device?user_code=${user_code}`,
          expires_in: 600,
          interval: 0.02,
        },
      ]
    }
    if (path === "/oauth/token") {
      log(`token ${form["grant_type"] ?? ""}`)
      if (form["grant_type"] === DEVICE_GRANT) {
        if (form["client_id"] === undefined) return err(400, "invalid_request", "device_code and client_id are required")
        const d = state.devices.get(form["device_code"] ?? "")
        if (d === undefined) return err(400, "invalid_grant", "unknown device code")
        if (d.client_id !== form["client_id"]) return err(400, "invalid_grant", "device code was issued to another client")
        d.polls++
        log(`poll ${d.polls}`)
        if (d.slow_down > 0) {
          d.slow_down--
          return err(400, "slow_down")
        }
        if (d.state === "pending") return err(400, "authorization_pending")
        if (d.state === "denied") return err(400, "access_denied", "the user denied access")
        if (d.state === "expired") return err(400, "expired_token")
        state.devices.delete(form["device_code"] ?? "")
        return [200, issue("ivan")]
      }
      if (form["grant_type"] === "refresh_token") {
        const user = state.refresh.get(form["refresh_token"] ?? "")
        if (user === undefined) return err(400, "invalid_grant", "unknown or expired refresh token")
        state.refresh.delete(form["refresh_token"] ?? "")
        return [200, issue(user)]
      }
      return err(400, "unsupported_grant_type")
    }
    if (path === "/mcp") {
      const token = (req.headers.authorization ?? "").replace(/^Bearer /, "")
      const user = state.access.get(token)
      if (user === undefined) return [401, { error: "invalid_token", error_description: "token is invalid or expired" }]
      const m = parse(raw)
      const params = field(m, "params")
      const name = str(params, "name")
      const a = field(params, "arguments")
      const id = field(m, "id")
      log(`tool ${name ?? ""} as ${user}`)
      const ok = (v: unknown): readonly [number, unknown] => [
        200,
        { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: text(v) }], structuredContent: v } },
      ]
      const fail = (t: string): readonly [number, unknown] => [200, { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: t }], isError: true } }]
      const slug = str(a, "slug") ?? ""
      if (name === "list_documents") {
        return ok({ documents: [...state.docs].map(([s, d]) => ({ slug: s, title: d.title, owner: d.owner, shared_with_you: d.owner !== user })) })
      }
      if (name === "get_document") {
        // As the site does: only a document the user can see, with its sharing for its owner only.
        const d = state.docs.get(slug)
        if (d === undefined || (d.owner !== user && !(d.shared ?? []).includes(user)))
          return fail(`no document "${slug}"; call list_documents to see what exists`)
        const sharing = d.owner === user ? { shared_with: d.shared ?? [] } : null
        return ok({ sharing, slug, title: d.title, owner: d.owner, url: `${url}/d/${slug}/`, latest_version: d.versions.length })
      }
      if (name === "publish_document") {
        let d = state.docs.get(slug)
        if (d !== undefined && d.owner !== user) return fail(`the slug "${slug}" is taken by another user's document; choose a different slug, or omit it`)
        state.folders.push(field(a, "folder"))
        state.labels.push(field(a, "labels"))
        state.images.push(field(a, "images"))
        // As the site does: a folder files a document it creates, and is ignored after.
        if (d === undefined) {
          d = { owner: user, title: str(a, "title") ?? slug, folder: str(a, "folder") ?? "", versions: [] }
          state.docs.set(slug, d)
        }
        const pages = field(a, "pages")
        d.versions.push({ message: str(a, "message") ?? null, pages: Array.isArray(pages) ? pages : [] })
        const version = d.versions.length
        const at = state.evil ? "javascript:alert(1)//" : `${url}/d/${slug}/`
        return ok({
          slug,
          version,
          url: at,
          version_url: `${at}-/v/${version}/`,
          pages: [],
          warnings: version === 1 ? [{ page: "index", warning: "a warning" }] : [],
        })
      }
      return [200, { jsonrpc: "2.0", id, error: { code: -32602, message: "unknown tool" } }]
    }
    return [404, "not found"]
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Array<Buffer> = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      const [status, body] = handle(req, Buffer.concat(chunks).toString("utf8"))
      res.writeHead(status, { "content-type": typeof body === "string" ? "text/plain" : "application/json" })
      res.end(typeof body === "string" ? body : text(body))
    })
  })
  yield* Effect.acquireRelease(
    Effect.callback<void>((resume) => {
      server.listen(0, "127.0.0.1", () => resume(Effect.void))
    }),
    () =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void))
      }),
  )
  const address: AddressInfo | string | null = server.address()
  url = typeof address === "object" && address !== null ? `http://127.0.0.1:${address.port}` : ""

  const site: FakeDocsSite = {
    url,
    state,
    decide: (to) => {
      const last = [...state.devices.values()].at(-1)
      if (last !== undefined) last.state = to
    },
    logged: (test) =>
      Effect.callback<void>((resume) => {
        if (state.log.some(test)) resume(Effect.void)
        else waiters.push({ test, done: () => resume(Effect.void) })
      }),
  }
  return site
})
