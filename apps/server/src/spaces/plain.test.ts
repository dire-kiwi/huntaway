import { assert, describe, it } from "@effect/vitest"
import { Option, Schema } from "effect"
import { AgentConfigId, Timestamp } from "@huntaway/contracts"
import { claudeCredentials, claudeFiles, claudeSettings, codexAuth } from "./agentFiles.ts"
import { imageTag, LABEL, nameProblem, parseInspect, portOf, runArgs, tokenOf, toSpace } from "./containers.ts"
import {
  headerStatus,
  parseViewerTicket,
  POLICY_ALLOW_ACTIVATION,
  requestHeaders,
  responseHeaders,
  SANDBOX,
  sandboxedCsp,
  viewerTicketRequest,
} from "./spacesd.ts"

// Spaces' plain parts (HE-35): the containers' arguments and what's read of them, the one gRPC-Web message, the relay's
// headers, and what of a config goes into a Space.

const Json = Schema.fromJsonString(Schema.Unknown)
const json = (v: unknown) => Option.getOrThrow(Schema.encodeOption(Json)(v))
const parse = (s: string) => Option.getOrThrow(Schema.decodeOption(Json)(s))

const frame = (flag: number, payload: ReadonlyArray<number>) => {
  const n = payload.length
  return [flag, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff, ...payload]
}
const str = (no: number, s: string) => {
  const b = [...new TextEncoder().encode(s)]
  return [no * 8 + 2, b.length, ...b]
}

describe("spacesd's viewer ticket", () => {
  it("writes CreateViewerTicket's request in a gRPC-Web frame", () => {
    const req = viewerTicketRequest({ ttlSeconds: 3600, policy: POLICY_ALLOW_ACTIVATION, clipboard: true, filesRoot: "~" })
    // ttl { seconds: 3600 }, policy 3, clipboard true, files_root "~", after the five-byte frame header.
    assert.deepStrictEqual([...req], [0, 0, 0, 0, 12, 0x0a, 3, 0x08, 0x90, 0x1c, 0x10, 3, 0x18, 1, 0x22, 1, 0x7e])
  })

  it("gives up on a frame longer than the answer, rather than looping", () => {
    // A length with its top bit set read as signed was negative, and the loop never moved on.
    assert.strictEqual(parseViewerTicket(Uint8Array.from([0, 0xff, 0xff, 0xff, 0xfb])), "spacesd's answer didn't parse")
    assert.strictEqual(parseViewerTicket(Uint8Array.from([0, 0, 0, 0, 9, 1, 2])), "spacesd's answer didn't parse")
  })

  it("keeps a refusal's text that isn't percent-encoded as it came", () => {
    assert.strictEqual(headerStatus({ "grpc-status": "7", "grpc-message": "100% denied" }), "spacesd refused a viewer ticket (7: 100% denied)")
    assert.strictEqual(headerStatus({ "grpc-status": "7", "grpc-message": "no%20way" }), "spacesd refused a viewer ticket (7: no way)")
    assert.isNull(headerStatus({ "grpc-status": "0" }))
  })

  it("reads the ticket and its expiry, and a refusal from the trailers", () => {
    const expires = [0x12, 3, 0x08, 0x90, 0x1c]
    const body = Uint8Array.from([
      ...frame(0, [...str(1, "v1.abc"), ...expires, ...str(3, "/viewer/#ticket=v1.abc")]),
      ...frame(0x80, [...new TextEncoder().encode("grpc-status:0\r\n")]),
    ])
    assert.deepStrictEqual(parseViewerTicket(body), { ticket: "v1.abc", expiresAt: 3600 })
    const refused = Uint8Array.from(frame(0x80, [...new TextEncoder().encode("grpc-status:16\r\ngrpc-message:bad%20token\r\n")]))
    assert.strictEqual(parseViewerTicket(refused), "spacesd refused a viewer ticket (16: bad token)")
    assert.strictEqual(parseViewerTicket(Uint8Array.from([])), "spacesd answered without a viewer ticket")
  })
})

describe("the relay's headers", () => {
  it("lets the board frame the viewer, sandboxed, and keeps redirects under the relay", () => {
    const out = responseHeaders(
      {
        "content-security-policy": "default-src 'self'; frame-ancestors 'none'; base-uri 'none'",
        location: "/viewer/",
        "content-length": "12",
        "content-encoding": "gzip",
        "x-content-type-options": "nosniff",
      },
      "/api/spaces/v/t",
    )
    assert.deepStrictEqual(out, {
      "content-security-policy": `default-src 'self'; base-uri 'none', frame-ancestors 'self'; ${SANDBOX}`,
      location: "/api/spaces/v/t/viewer/",
      "x-content-type-options": "nosniff",
    })
  })

  it("sandboxes every answer, whatever the Space serves, and lets none of them touch the board's origin", () => {
    // Something else listening on the Space's port: no CSP, its own sandbox with allow-same-origin, cookies, a service
    // worker for the whole origin, and the board's storage cleared.
    const out = responseHeaders(
      {
        "Content-Type": "text/html",
        "Set-Cookie": "ia.token=x; Path=/",
        "service-worker-allowed": "/",
        "clear-site-data": '"storage"',
      },
      "/api/spaces/v/t",
    )
    assert.deepStrictEqual(out, { "content-type": "text/html", "content-security-policy": `frame-ancestors 'self'; ${SANDBOX}` })
    const own = responseHeaders({ "Content-Security-Policy": "sandbox allow-scripts allow-same-origin; script-src *" }, "/p")
    assert.strictEqual(own["content-security-policy"], `script-src *, frame-ancestors 'self'; ${SANDBOX}`)
    assert.notInclude(SANDBOX, "allow-same-origin")
  })

  it("strips a sandbox from every policy of the Space's, so none but the relay's is left", () => {
    // A comma starts another policy, whose first `sandbox` would win over the relay's had it been added to that one.
    assert.strictEqual(
      sandboxedCsp("script-src * 'unsafe-inline', sandbox allow-scripts allow-same-origin"),
      `script-src * 'unsafe-inline', frame-ancestors 'self'; ${SANDBOX}`,
    )
    // Repeated headers, joined with a comma.
    const joined = responseHeaders(
      { "content-security-policy": "img-src *", "Content-Security-Policy": "sandbox allow-same-origin allow-scripts; frame-ancestors *" },
      "/p",
    )
    assert.strictEqual(joined["content-security-policy"], `img-src *, frame-ancestors 'self'; ${SANDBOX}`)
    assert.strictEqual(sandboxedCsp(" , ;SANDBOX allow-same-origin, "), `frame-ancestors 'self'; ${SANDBOX}`)
  })

  it("passes on the viewer's own headers, not the board's cookies or the connection's", () => {
    const out = requestHeaders({
      "x-cua-env-authorization": "Bearer v1.x",
      cookie: "a=b",
      host: "board",
      connection: "keep-alive",
      "content-type": "application/grpc-web+proto",
    })
    assert.deepStrictEqual(out, { "x-cua-env-authorization": "Bearer v1.x", "content-type": "application/grpc-web+proto" })
  })
})

describe("what of a config goes into a Space", () => {
  it("leaves the refresh tokens out", () => {
    const claude = claudeCredentials(json({ claudeAiOauth: { accessToken: "at", refreshToken: "rt", expiresAt: 5 } }))
    assert.isNotNull(claude)
    assert.notInclude(claude ?? "", "rt")
    assert.include(claude ?? "", '"accessToken": "at"')
    const codex = codexAuth(json({ tokens: { access_token: "at", refresh_token: "rt" } }))
    assert.include(codex ?? "", '"refresh_token": ""')
    assert.isNull(claudeCredentials("not json"))
  })

  it("keeps the settings but not the hooks, and adds the config's proxy", () => {
    const s = claudeSettings(json({ model: "opus", hooks: { Stop: [] }, statusLine: { command: "x" }, env: { A: "1" } }), [["ANTHROPIC_BASE_URL", "http://p"]])
    assert.deepStrictEqual(parse(s), { model: "opus", env: { A: "1", ANTHROPIC_BASE_URL: "http://p" } })
    assert.deepStrictEqual(parse(claudeSettings(null, [])), {})
  })

  it("gives no credentials file for a config folder without one", () => {
    const files = claudeFiles({ credentials: null, settings: null, memory: "be kind", proxyEnv: [] })
    assert.deepStrictEqual(
      files.map((f) => f.path),
      [".claude/settings.json", ".claude/CLAUDE.md"],
    )
  })
})

describe("a Space's container", () => {
  const claude = AgentConfigId.make("cfg-1")
  const args = runArgs({
    id: "abc123",
    name: " Tests ",
    image: "img:1",
    hostId: "h1",
    token: "tok",
    direct: false,
    claude,
    codex: null,
    createdAt: "2026-11-15T00:00:00.000Z",
  })

  it("is run with its token, a loopback port unless direct, and its labels", () => {
    assert.includeMembers(
      [...args],
      ["--name", "huntaway-space-abc123", "CUA_ENV_TOKEN=tok", "127.0.0.1::3211", `${LABEL.host}=h1`, `${LABEL.name}=Tests`, `${LABEL.claude}=cfg-1`],
    )
    assert.strictEqual(args.at(-1), "img:1")
    assert.notInclude(args.join(" "), LABEL.codex)
    const direct = runArgs({ id: "abc123", name: "x", image: "i", hostId: "h", token: "t", direct: true, claude: null, codex: null, createdAt: "" })
    assert.include([...direct], ":3211")
  })

  it("is read back from docker inspect", () => {
    const inspect = json([
      {
        Name: "/huntaway-space-abc123",
        State: { Status: "running" },
        Config: {
          Image: "img:1",
          Env: ["PATH=/bin", "CUA_ENV_TOKEN=tok"],
          Labels: { [LABEL.name]: "Tests", [LABEL.claude]: "cfg-1", [LABEL.direct]: "0", [LABEL.created]: "2026" },
        },
        NetworkSettings: { Ports: { "3211/tcp": [{ HostIp: "127.0.0.1", HostPort: "40123" }], "3212/udp": null } },
      },
      { Name: "/something-else", State: { Status: "exited" }, Config: { Image: "x" } },
    ])
    const [c, other] = parseInspect(inspect)
    assert.isDefined(c)
    assert.isDefined(other)
    if (c === undefined || other === undefined) return
    assert.strictEqual(portOf(c), 40123)
    assert.strictEqual(tokenOf(c), "tok")
    assert.deepStrictEqual(toSpace(c, "Up 2 minutes"), {
      id: "abc123",
      name: "Tests",
      image: "img:1",
      state: "running",
      detail: "Up 2 minutes",
      direct: false,
      claude_config_id: claude,
      codex_config_id: null,
      created_at: Timestamp.make("2026"),
    })
    assert.isNull(toSpace(other, null))
    assert.deepStrictEqual(parseInspect("nonsense"), [])
  })

  it("has a name the board can show, and an image tag Docker takes", () => {
    assert.isNull(nameProblem("Browser tests"))
    assert.strictEqual(nameProblem("  "), "a Space needs a name")
    assert.strictEqual(nameProblem("a\u0007b"), "no control characters")
    assert.match(imageTag("ghcr.io/trycua/linux:24.04"), /^huntaway-space:\d+-ghcr\.io_trycua_linux_24\.04$/u)
  })
})
