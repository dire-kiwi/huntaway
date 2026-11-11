import { assert, describe, it } from "@effect/vitest"
import { Result, Schema } from "effect"
import {
  accountOf,
  consentUrl,
  credentialsFile,
  credentialsJson,
  CLIENT_SECRET_ENV,
  CREDENTIALS_ENV,
  EMAIL_ENV,
  readCallback,
  readClient,
  SCOPES,
  serverConfig,
} from "./googleText.ts"

/** JSON text, through a schema (the global `JSON` throws). */
const encodeJson = Schema.encodeResult(Schema.fromJsonString(Schema.Unknown))
const json = (v: unknown): string => Result.getOrElse(encodeJson(v), () => "")

// Google's plain parts (the old agent/assistant/google/tests.test.ts's cases with no board or network).

const CLIENT = '{"installed": {"client_id": "id.apps.googleusercontent.com", "client_secret": "shh", "redirect_uris": ["http://localhost"]}}'

const b64 = (t: string) => Buffer.from(t).toString("base64url")

export const idToken = (email: string): string => {
  const b = b64
  return `${b('{"alg":"RS256"}')}.${b(json({ email, sub: "1" }))}.sig`
}

describe("google text", () => {
  it("credentials files are named as workspace-mcp names them", () => {
    assert.strictEqual(credentialsFile("sam@example.com"), "sam@example.com.json")
    assert.strictEqual(credentialsFile("sam+news@example.com"), "sam%2Bnews@example.com.json")
    assert.strictEqual(accountOf("sam%2Bnews@example.com.json"), "sam+news@example.com")
    assert.strictEqual(accountOf("sam@example.com.json"), "sam@example.com")
    // Its other files aren't accounts.
    assert.isNull(accountOf("oauth_states.json"))
    assert.isNull(accountOf("notes.txt"))
    assert.strictEqual(accountOf("a%2@b.json"), "a%2@b")
  })

  it("the server runs workspace-mcp pinned with Gmail, Calendar and Drive", () => {
    const c = serverConfig("/home/sam", "sam@example.com")
    assert.deepStrictEqual([c.type, c.command], ["stdio", "uvx"])
    assert.deepStrictEqual(c.args, ["workspace-mcp@2.3.0", "--single-user", "--tools", "gmail", "calendar", "drive", "--tool-tier", "extended"])
    assert.strictEqual(c.env[EMAIL_ENV], "sam@example.com")
    // Absolute paths, as an MCP config doesn't expand ~.
    assert.strictEqual(c.env[CLIENT_SECRET_ENV], "/home/sam/.google_workspace_mcp/client_secret.json")
    assert.strictEqual(c.env[CREDENTIALS_ENV], "/home/sam/.google_workspace_mcp/credentials")
    assert.notProperty(serverConfig("/home/sam", null).env, EMAIL_ENV)
  })

  it("the client file is read as Google Cloud downloads it", () => {
    const c = Result.getOrThrow(readClient(CLIENT))
    assert.deepStrictEqual([c.client_id, c.client_secret, c.web], ["id.apps.googleusercontent.com", "shh", false])
    assert.deepStrictEqual([c.auth_uri, c.token_uri], ["https://accounts.google.com/o/oauth2/auth", "https://oauth2.googleapis.com/token"])
    const web = Result.getOrThrow(readClient('{"web": {"client_id": "w", "client_secret": "s", "token_uri": "http://127.0.0.1:1/token"}}'))
    assert.isTrue(web.web && web.token_uri === "http://127.0.0.1:1/token")
    for (const bad of ["nope", "{}", '{"installed": {"client_id": "x"}}', '{"installed": {"client_secret": "x"}}']) {
      assert.isTrue(Result.isFailure(readClient(bad)), bad)
    }
  })

  it("the consent URL asks for offline access with PKCE", () => {
    const c = Result.getOrThrow(readClient(CLIENT))
    const url = consentUrl(c, "http://127.0.0.1:8765/", "st", "the-challenge")
    const [base, qs] = url.split("?")
    assert.strictEqual(base, "https://accounts.google.com/o/oauth2/auth")
    const q = new URLSearchParams(qs)
    const get = (k: string) => q.get(k) ?? ""
    assert.strictEqual(get("redirect_uri"), "http://127.0.0.1:8765/")
    assert.deepStrictEqual([get("access_type"), get("prompt"), get("response_type"), get("state")], ["offline", "consent", "code", "st"])
    assert.deepStrictEqual([get("code_challenge"), get("code_challenge_method")], ["the-challenge", "S256"])
    assert.deepStrictEqual(get("scope").split(" "), SCOPES)
  })

  it("only the flow's own redirect is taken", () => {
    assert.deepStrictEqual(readCallback("/?state=st&code=4%2Fabc&scope=x", "st"), { kind: "code", code: "4/abc" })
    assert.deepStrictEqual(readCallback("/?state=st&error=access_denied", "st"), { kind: "denied", error: "access_denied" })
    // Another flow's state, a favicon, no state.
    for (const target of ["/?state=other&code=abc", "/favicon.ico", "/?code=abc", ""])
      assert.deepStrictEqual(readCallback(target, "st"), { kind: "other" }, target)
  })

  it("credentials are written as workspace-mcp reads them", () => {
    const c = Result.getOrThrow(readClient(CLIENT))
    const now = 1_793_775_600_000 // 2026-11-04T07:00:00Z
    const token = {
      access_token: "at",
      expires_in: 3599,
      refresh_token: "rt",
      scope: "openid https://www.googleapis.com/auth/gmail.readonly",
      id_token: idToken("sam@example.com"),
    }
    const [email, v] = Result.getOrThrow(credentialsJson(c, token, now))
    assert.strictEqual(email, "sam@example.com")
    assert.deepStrictEqual(v, {
      token: "at",
      refresh_token: "rt",
      token_uri: "https://oauth2.googleapis.com/token",
      client_id: "id.apps.googleusercontent.com",
      client_secret: "shh",
      scopes: ["openid", "https://www.googleapis.com/auth/gmail.readonly"],
      expiry: "2026-11-04T07:59:59",
    })
    // Without a refresh token it's no use to a server that runs for longer than an hour.
    const failed = credentialsJson(c, { ...token, refresh_token: null }, now)
    assert.isTrue(Result.isFailure(failed) && failed.failure.includes("no refresh token"))
  })
})
