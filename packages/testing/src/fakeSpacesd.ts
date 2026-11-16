import { Effect, Option, Schema } from "effect"
import { createHash } from "node:crypto"
import { createServer } from "node:http"

// A fake spacesd for tests (HE-37): its health check, a viewer ticket, and its `POST /mcp` (Cua Driver over streamable-HTTP MCP) with a
// few of the driver's tools, the ones that only look saying so, and one of spacesd's own Spaces tools, which the board
// hides. It answers `tools/list` as JSON and `tools/call` as an event stream, as the transport allows either. As
// spacesd does, it opens an MCP session on `initialize`, answers 404 for one it doesn't know and 400 for one without
// `mcp-protocol-version`, and answers a request without a session too. It never touches a desktop.
//
// HE-48: its browser tools act on one scripted tab (`browser`): a page whose path is `/login` shows a login form (an
// email input, a password input, a submit button); clicking submit sends the form by GET, so the address after has the
// password in it, as a real GET form's would.
//
// HE-49: it also takes teleports (`cua.env.v1.TeleportService` over gRPC-Web): `GetManifest` says it supports `chrome`
// and `firefox` at bundle version 1; `ImportSession` gathers the chunks of each import (refusing an offset that isn't
// where the last ended) and, on the committing chunk, checks the bundle's SHA-256 and keeps it in `teleports`;
// `WipeImport` records the id in `wiped`, answering NOT_FOUND for one it never took.

/** A tool call it was given, with the bearer token and the MCP session it came with. */
export interface FakeSpacesdCall {
  readonly tool: string
  readonly args: unknown
  readonly token: string
  readonly session: string | null
}

export interface FakeSpacesd {
  readonly port: number
  /** The tool calls it was given, in order. */
  readonly calls: Array<FakeSpacesdCall>
  /** How many times it was asked for its tools. */
  readonly listed: { count: number }
  /** The MCP sessions it has opened (`initialize`), which it forgets as a restarted spacesd would (`clear`). */
  readonly sessions: Set<string>
  /** Its one browser tab. */
  readonly browser: FakeBrowser
  /** The teleports committed, in order: the import's id, the app, the whole bundle and its self-wipe time (0: none). */
  readonly teleports: Array<FakeTeleport>
  /** The imports wiped (`WipeImport`), in order. */
  readonly wiped: Array<string>
}

/** A teleport the fake took. */
export interface FakeTeleport {
  readonly importId: string
  readonly app: string
  readonly bundle: Uint8Array
  readonly expiresAtMs: number
}

/** A protobuf message's fields by number: varints as numbers, length-delimited ones as bytes. Enough for the teleport's. */
const protoFields = (b: Uint8Array): Map<number, number | Uint8Array> => {
  const out = new Map<number, number | Uint8Array>()
  let i = 0
  const varint = () => {
    let v = 0
    let mul = 1
    for (;;) {
      const x = b[i++] ?? 0
      v += (x & 0x7f) * mul
      if (x < 0x80 || i >= b.length) return v
      mul *= 0x80
    }
  }
  while (i < b.length) {
    const key = varint()
    const no = Math.floor(key / 8)
    if (key % 8 === 0) out.set(no, varint())
    else if (key % 8 === 2) {
      const len = varint()
      out.set(no, b.subarray(i, i + len))
      i += len
    } else break
  }
  return out
}
const textOf = (v: number | Uint8Array | undefined) => (v instanceof Uint8Array ? new TextDecoder().decode(v) : "")
const intOf = (v: number | Uint8Array | undefined) => (typeof v === "number" ? v : 0)
const pbVarint = (n: number): Array<number> => {
  const out: Array<number> = []
  let v = n
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80)
    v = Math.floor(v / 0x80)
  }
  out.push(v)
  return out
}
const pbText = (no: number, s: string) => {
  const b = [...new TextEncoder().encode(s)]
  return [no * 8 + 2, ...pbVarint(b.length), ...b]
}
const pbMessage = (no: number, m: ReadonlyArray<number>) => [no * 8 + 2, ...pbVarint(m.length), ...m]
/** A gRPC-Web answer: one data frame, then trailers with grpc-status 0. */
const grpcAnswer = (message: ReadonlyArray<number>): Buffer => {
  const trailer = [...new TextEncoder().encode("grpc-status: 0\r\n")]
  return Buffer.from([0, 0, 0, (message.length >> 8) & 0xff, message.length & 0xff, ...message, 0x80, 0, 0, 0, trailer.length, ...trailer])
}
/** A gRPC-Web refusal, in the headers. */
const grpcRefusal = (status: number, message: string): readonly [number, Record<string, string>, Buffer] => [
  200,
  { "content-type": "application/grpc-web+proto", "grpc-status": String(status), "grpc-message": encodeURIComponent(message) },
  Buffer.alloc(0),
]

/** The fake's browser tab: where it is, and what was typed and clicked in it. */
export interface FakeBrowser {
  url: string
  readonly typed: Array<{ readonly ref: string; readonly text: string }>
  readonly clicked: Array<string>
  /** `browser_type` into the password field refuses, saying what it was given. */
  refuseType: boolean
}

/** The login form's refs, as `get_browser_state` gives a `dom_refs_v1` snapshot's. */
export const LOGIN_REFS = [
  { frame: "main", label: null, node: "label", ref: "p1:0" },
  { frame: "main", label: "name=email id=email type=email", node: "input", ref: "p1:1" },
  { frame: "main", label: "name=pw id=pw type=password", node: "input", ref: "p1:3" },
  { frame: "main", label: "type=button", node: "button", ref: "p1:4" },
  { frame: "main", label: "type=submit", node: "button", ref: "p1:5" },
]

/** A one-pixel PNG. */
export const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

const look = { readOnlyHint: true, destructiveHint: false }
const act = { readOnlyHint: false, destructiveHint: true }
const TOOLS = [
  {
    name: "get_desktop_state",
    description: "A screenshot of the whole desktop. And its windows.",
    annotations: look,
    inputSchema: { type: "object", properties: { session: { type: "string" } } },
  },
  {
    name: "list_windows",
    description: "Open windows.",
    annotations: look,
    inputSchema: { type: "object", properties: { pid: { type: "integer" }, session: { type: "string" } } },
  },
  {
    name: "click",
    description: "Click an element or a point.",
    annotations: act,
    inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, pid: { type: "integer" } }, required: ["pid"] },
  },
  { name: "create_space", description: "Create a Cua Space.", inputSchema: { type: "object", properties: { name: { type: "string" } } } },
]

const Request = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.optional(Schema.Union([Schema.Finite, Schema.String])),
    method: Schema.String,
    params: Schema.optional(Schema.Struct({ name: Schema.optional(Schema.String), arguments: Schema.optional(Schema.Unknown) })),
  }),
)
const decode = Schema.decodeUnknownOption(Request)
const json = (v: unknown) => Option.getOrElse(Schema.encodeOption(Schema.fromJsonString(Schema.Unknown))(v), () => "{}")

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> => typeof v === "object" && v !== null && !Array.isArray(v)
const arg = (args: unknown, key: string): unknown => (isRecord(args) ? args[key] : undefined)
const argText = (args: unknown, key: string): string => {
  const v = arg(args, key)
  return typeof v === "string" ? v : ""
}
const onLogin = (url: string) => URL.canParse(url) && new URL(url).pathname === "/login"
const ok = (structuredContent: Record<string, unknown>, text = "ok") => ({
  content: [{ type: "text", text }],
  structuredContent: { status: "ok", ...structuredContent },
})

/** What a tool call answers. */
const resultOf = (tool: string, args: unknown, browser: FakeBrowser) => {
  switch (tool) {
    case "browser_prepare":
      return ok({ prepared: true, prepared_pid: 349 })
    case "get_browser_state":
      if (arg(args, "pid") !== undefined) return ok({ target_id: "bt-1", tabs: [{ tab_id: "tab-1", active: true, url: browser.url }] })
      return ok({ url: browser.url, refs: onLogin(browser.url) ? LOGIN_REFS : [] })
    case "browser_navigate":
      browser.url = argText(args, "url")
      return ok({ url: browser.url })
    case "browser_type": {
      const text = argText(args, "text")
      if (browser.refuseType && argText(args, "ref") === "p1:3") {
        return {
          content: [{ type: "text", text: `refused: could not type ${text}` }],
          structuredContent: { status: "refused", effect: "refused" },
          isError: true,
        }
      }
      browser.typed.push({ ref: argText(args, "ref"), text })
      return ok({}, `typed ${text.length} char(s)`)
    }
    case "browser_click": {
      const ref = argText(args, "ref")
      browser.clicked.push(ref)
      if (ref === "p1:5" && onLogin(browser.url)) {
        const pw = browser.typed.findLast((t) => t.ref === "p1:3")?.text ?? ""
        // As a browser sends a GET form: application/x-www-form-urlencoded.
        browser.url = `${new URL(browser.url).origin}/done?${new URLSearchParams({ pw }).toString()}`
      }
      return ok({}, "clicked")
    }
    case "get_desktop_state":
      return {
        content: [
          { type: "image", data: PIXEL, mimeType: "image/png" },
          { type: "text", text: 'Desktop screenshot 1280x800\n- pid=226 window_id=7 "Desktop"' },
        ],
        structuredContent: { screen_width: 1280, screen_height: 800 },
      }
    case "list_windows":
      return {
        content: [{ type: "text", text: 'window_id=7 pid=226 "Desktop"' }],
        structuredContent: {
          windows: [
            { pid: 226, window_id: 7 },
            { pid: 349, window_id: 9 },
          ],
        },
      }
    case "click":
      return { content: [{ type: "text", text: "clicked" }] }
    default:
      return { content: [{ type: "text", text: `no tool ${tool}` }], isError: true }
  }
}

/** A fake spacesd on 127.0.0.1, for the scope. */
export const fakeSpacesd = Effect.acquireRelease(
  Effect.callback<{ readonly fake: FakeSpacesd; readonly close: () => void }>((resume) => {
    const calls: Array<FakeSpacesdCall> = []
    const browser: FakeBrowser = { url: "about:blank", typed: [], clicked: [], refuseType: false }
    const listed = { count: 0 }
    /** What a request is answered with: its status, headers and body. */
    const sessions = new Set<string>()
    const teleports: Array<FakeTeleport> = []
    const wiped: Array<string> = []
    /** Imports being received: their app and the chunks so far. */
    const importing = new Map<string, { app: string; chunks: Array<Uint8Array>; received: number }>()
    const teleport = (rpc: string, raw: Uint8Array): readonly [number, Record<string, string>, string | Buffer] => {
      const f = protoFields(raw.subarray(5))
      const grpc = { "content-type": "application/grpc-web+proto" }
      if (rpc === "GetManifest") {
        const app = textOf(f.get(1))
        const supported = app === "chrome" || app === "firefox"
        return [200, grpc, grpcAnswer([8, supported ? 1 : 0, 40, 1, ...pbText(7, "chrome"), ...pbText(7, "firefox")])]
      }
      if (rpc === "ImportSession") {
        const id = textOf(f.get(1))
        const offset = intOf(f.get(4))
        const chunk = f.get(5)
        const data = chunk instanceof Uint8Array ? Uint8Array.from(chunk) : new Uint8Array(0)
        const held = importing.get(id) ?? { app: textOf(f.get(2)), chunks: [], received: 0 }
        if (offset !== held.received) return grpcRefusal(9, `offset ${offset} isn't ${held.received}`)
        held.chunks.push(data)
        held.received += data.length
        importing.set(id, held)
        if (intOf(f.get(6)) !== 1) return [200, grpc, grpcAnswer([8, ...pbVarint(held.received)])]
        importing.delete(id)
        const bundle = Buffer.concat(held.chunks)
        if (createHash("sha256").update(bundle).digest("hex") !== textOf(f.get(7))) return grpcRefusal(9, "bundle sha256 doesn't match")
        const options = f.get(8)
        const expiresAtMs = options instanceof Uint8Array ? intOf(protoFields(options).get(4)) : 0
        teleports.push({ importId: id, app: held.app, bundle: Uint8Array.from(bundle), expiresAtMs })
        const result = [...pbText(1, "cookies.json"), ...pbText(1, "localstorage.json")]
        return [200, grpc, grpcAnswer([8, ...pbVarint(held.received), ...pbMessage(3, result)])]
      }
      if (rpc === "WipeImport") {
        const id = textOf(f.get(1))
        if (!teleports.some((t) => t.importId === id) || wiped.includes(id)) return grpcRefusal(5, `no import ${id}`)
        wiped.push(id)
        return [200, grpc, grpcAnswer(pbText(1, id))]
      }
      return grpcRefusal(12, `no method ${rpc}`)
    }
    const answer = (
      method: string,
      url: string,
      headers: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>,
      raw: Buffer,
    ): readonly [number, Record<string, string>, string | Buffer] => {
      const body = raw.toString("utf8")
      const header = (name: string) => {
        const v = headers[name]
        return typeof v === "string" ? v : null
      }
      const auth = header("authorization") ?? ""
      if (method === "GET" && url === "/health") return [204, {}, ""]
      // A viewer ticket, `v1.tick`, in a gRPC-Web frame.
      if (method === "POST" && url === "/cua.env.v1.SystemService/CreateViewerTicket") {
        const ticket = [...new TextEncoder().encode("v1.tick")]
        const message = [0x0a, ticket.length, ...ticket]
        return [200, { "content-type": "application/grpc-web+proto" }, Buffer.from([0, 0, 0, 0, message.length, ...message])]
      }
      if (method === "POST" && url.startsWith("/cua.env.v1.TeleportService/")) {
        if (!auth.startsWith("Bearer ") || auth.length <= 7) return grpcRefusal(16, "unauthenticated")
        return teleport(url.slice("/cua.env.v1.TeleportService/".length), Uint8Array.from(raw))
      }
      if (method !== "POST" || url !== "/mcp") return [404, {}, ""]
      if (!auth.startsWith("Bearer ") || auth.length <= 7) return [401, {}, "unauthorized"]
      const session = header("mcp-session-id")
      if (session !== null && !sessions.has(session)) return [404, {}, ""]
      if (session !== null && header("mcp-protocol-version") === null) return [400, {}, ""]
      const request = decode(body)
      if (Option.isNone(request)) return [400, {}, ""]
      const { id, method: rpc, params } = request.value
      if (id === undefined) return [202, {}, ""]
      if (rpc === "initialize") {
        const opened = `mcp-fake-${sessions.size + 1}`
        sessions.add(opened)
        return [200, { "content-type": "application/json", "mcp-session-id": opened }, json({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18" } })]
      }
      if (rpc === "tools/list") {
        listed.count++
        return [200, { "content-type": "application/json" }, json({ jsonrpc: "2.0", id, result: { tools: TOOLS } })]
      }
      if (rpc === "tools/call") {
        const tool = params?.name ?? ""
        calls.push({ tool, args: params?.arguments ?? {}, token: auth.slice(7), session })
        return [
          200,
          { "content-type": "text/event-stream" },
          `event: message\ndata: ${json({ jsonrpc: "2.0", id, result: resultOf(tool, params?.arguments ?? {}, browser) })}\n\n`,
        ]
      }
      return [200, { "content-type": "application/json" }, json({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } })]
    }
    const server = createServer((req, res) => {
      const chunks: Array<Buffer> = []
      req.on("data", (c: Buffer) => chunks.push(c))
      req.on("end", () => {
        const [status, headers, body] = answer(req.method ?? "", req.url ?? "", req.headers, Buffer.concat(chunks))
        res.writeHead(status, headers).end(body)
      })
    })
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address !== null ? address.port : 0
      resume(Effect.succeed({ fake: { port, calls, listed, sessions, browser, teleports, wiped }, close: () => server.close() }))
    })
  }),
  ({ close }) => Effect.sync(close),
).pipe(Effect.map(({ fake }) => fake))
