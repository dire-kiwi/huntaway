import { DateTime, Option, Result, Schema } from "effect"
import { Base64Url } from "effect/encoding"
import type { GoogleAccount, GoogleFile, GoogleServer, GoogleStatus } from "@huntaway/contracts"

// Google Workspace for the assistant, its plain parts (huntaway's agent/assistant/google.ts and google/consent.ts):
// Gmail, Calendar and Drive through a Google Workspace MCP server on the assistant's host, with an OAuth client the
// user makes, rather than the claude.ai connectors, which come with the Claude login and so would reach every agent on
// it. The server is workspace-mcp (`uvx workspace-mcp`), a global MCP server of the host named `google`, which the
// profile switches on; only the assistant and its routine threads get it (`agents/agentTools/effective.ts`). It reads
// its OAuth client from `client_secret.json` and its refresh token from `credentials/<email>.json`, both in
// `~/.google_workspace_mcp`. The consent step is `huntaway google-auth` (`cli/googleAuth.ts`).

/** The MCP server's name, so its tools are `mcp__google__<tool>` (the approval rules' Google defaults are for it). */
export const SERVER = "google"
/** The package `uvx` runs, pinned: a new release has to be picked, rather than run with the user's mail the day it's out. */
export const PACKAGE = "workspace-mcp@2.3.0"
/** What it serves: Gmail, Calendar and Drive, at the tier with drafts, labels and Drive's listing. */
export const SERVER_ARGS: ReadonlyArray<string> = ["--single-user", "--tools", "gmail", "calendar", "drive", "--tool-tier", "extended"]
/** Where workspace-mcp looks for its OAuth client and credentials, and the account it acts as. */
export const CLIENT_SECRET_ENV = "GOOGLE_CLIENT_SECRET_PATH"
export const CREDENTIALS_ENV = "WORKSPACE_MCP_CREDENTIALS_DIR"
export const EMAIL_ENV = "USER_GOOGLE_EMAIL"
/** The port `huntaway google-auth` listens on by default (on 127.0.0.1), which `ssh -L` forwards. */
export const CONSENT_PORT = 8765

export const AUTH_URI = "https://accounts.google.com/o/oauth2/auth"
export const TOKEN_URI = "https://oauth2.googleapis.com/token"

/** The scopes workspace-mcp asks for with Gmail, Calendar and Drive, so its tools don't ask to sign in again. */
export const SCOPES: ReadonlyArray<string> = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.labels",
  "https://www.googleapis.com/auth/gmail.settings.basic",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive.file",
]

/** The scopes the brief can't do without: reading mail, the calendar and Drive (a broader one covers each). */
const NEEDED: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  ["https://www.googleapis.com/auth/gmail.readonly", ["https://www.googleapis.com/auth/gmail.modify", "https://mail.google.com/"]],
  ["https://www.googleapis.com/auth/calendar.readonly", ["https://www.googleapis.com/auth/calendar"]],
  ["https://www.googleapis.com/auth/drive.readonly", ["https://www.googleapis.com/auth/drive"]],
]

/** What the brief needs that `scopes` doesn't grant. */
export const missingScopes = (scopes: ReadonlyArray<string>): ReadonlyArray<string> =>
  NEEDED.filter(([s, broader]) => !scopes.some((g) => g === s || broader.includes(g))).map(([s]) => s)

/** workspace-mcp's own folder, `~/.google_workspace_mcp`, and its defaults there. */
export const homeDir = (home: string): string => `${home}/.google_workspace_mcp`
export const defaultClientSecret = (home: string): string => `${homeDir(home)}/client_secret.json`
export const defaultCredentialsDir = (home: string): string => `${homeDir(home)}/credentials`

/** The server's `mcpServers` entry: `uvx` running workspace-mcp, with absolute paths, and the account when it's known. */
export const serverConfig = (home: string, email: string | null) => {
  const env: Record<string, string> = { [CLIENT_SECRET_ENV]: defaultClientSecret(home), [CREDENTIALS_ENV]: defaultCredentialsDir(home) }
  if (email !== null) env[EMAIL_ENV] = email
  return { type: "stdio", command: "uvx", args: [PACKAGE, ...SERVER_ARGS], env }
}

const utf8 = new TextEncoder()
const SAFE = /^[A-Za-z0-9@._-]$/

/** A credentials file's name for an account, as workspace-mcp makes it (Python's `quote(email, safe="@._-")`). */
export const credentialsFile = (email: string): string => {
  let name = ""
  for (const b of utf8.encode(email)) {
    const ch = String.fromCharCode(b)
    name += b < 0x80 && SAFE.test(ch) ? ch : `%${b.toString(16).toUpperCase().padStart(2, "0")}`
  }
  return `${name}.json`
}

/** The account a credentials file is for, from its name (undoing `credentialsFile`), if it's one. */
export const accountOf = (file: string): string | null => {
  if (!file.endsWith(".json")) return null
  const bytes = utf8.encode(file.slice(0, -5))
  const out: Array<number> = []
  let i = 0
  while (i < bytes.length) {
    const h = bytes[i] === 0x25 && i + 3 <= bytes.length ? String.fromCharCode(bytes[i + 1] ?? 0, bytes[i + 2] ?? 0) : null
    if (h !== null && /^[0-9A-Fa-f]{2}$/.test(h)) {
      out.push(parseInt(h, 16))
      i += 3
    } else {
      out.push(bytes[i] ?? 0)
      i += 1
    }
  }
  const email = Result.try({ try: () => new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(out)), catch: () => null })
  return Result.isSuccess(email) && email.success.includes("@") ? email.success : null
}

/** A credentials file as workspace-mcp keeps it (each field as it may or may not be there). */
export const CredentialsJson = Schema.Struct({
  token: Schema.optional(Schema.NullOr(Schema.String)),
  refresh_token: Schema.optional(Schema.NullOr(Schema.String)),
  token_uri: Schema.optional(Schema.NullOr(Schema.String)),
  client_id: Schema.optional(Schema.NullOr(Schema.String)),
  client_secret: Schema.optional(Schema.NullOr(Schema.String)),
  scopes: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
  expiry: Schema.optional(Schema.NullOr(Schema.String)),
})
export type CredentialsJson = typeof CredentialsJson.Type
export const decodeCredentials = Schema.decodeUnknownOption(Schema.fromJsonString(CredentialsJson))

/** An account's file as read: its name, whether it's readable by its owner alone, and what it says (if it's JSON). */
export interface AccountFile {
  readonly email: string
  readonly file: string
  readonly private: boolean
  readonly credentials: CredentialsJson | null
}

export const accountFrom = (a: AccountFile): GoogleAccount => {
  const scopes = (a.credentials?.scopes ?? []).filter((s): s is string => typeof s === "string")
  return {
    email: a.email,
    file: a.file,
    refresh_token: typeof a.credentials?.refresh_token === "string" && a.credentials.refresh_token !== "",
    private: a.private,
    scopes,
    missing_scopes: missingScopes(scopes),
  }
}

/** What the card's status is made from. */
export interface StatusFacts {
  /** The host's `google` server and whether the profile switches it on. */
  readonly server: GoogleServer | null
  /** The server's `env` (what it sets of CLIENT_SECRET_ENV, CREDENTIALS_ENV, EMAIL_ENV and the client in env). */
  readonly env: Readonly<Record<string, string>>
  readonly clientSecret: GoogleFile
  readonly credentialsDir: string
  readonly accounts: ReadonlyArray<GoogleAccount>
  readonly host: string
}

/** A config's env value, if it sets it (and it isn't blank). */
export const envOf = (env: Readonly<Record<string, string>>, key: string): string | null => {
  const v = env[key]
  return v !== undefined && v.trim() !== "" ? v.trim() : null
}

/** Whether Google is connected for a profile's assistant here, and if not, why not. */
export const statusOf = (f: StatusFacts): GoogleStatus => {
  // The client's id and secret can be given in the env instead of a file.
  const secretInEnv = envOf(f.env, "GOOGLE_OAUTH_CLIENT_ID") !== null && envOf(f.env, "GOOGLE_OAUTH_CLIENT_SECRET") !== null
  const wanted = envOf(f.env, EMAIL_ENV)
  const accounts = f.accounts
  const account =
    wanted !== null ? accounts.find((a) => a.email.toLowerCase() === wanted.toLowerCase()) : (accounts.find((a) => a.refresh_token) ?? accounts[0])
  const consent = `huntaway google-auth --client-secret ${f.clientSecret.path}`
  const s = f.server
  let problem: string | null = null
  if (s === null) problem = "There's no Google server on this host yet: add it here."
  else if (!s.enabled) problem = "The Google server is switched off (Settings → Agent tools)."
  else if (!s.on) problem = "The Google server isn't switched on for this profile: switch it on here."
  else if (!s.command_found) problem = `${s.command} isn't on this host's PATH: install uv (https://docs.astral.sh/uv/) for the user the host runs as.`
  else if (!f.clientSecret.exists && !secretInEnv) problem = `There's no OAuth client at ${f.clientSecret.path}: download your Desktop app client's JSON there.`
  else if (account === undefined && wanted !== null) problem = `There are no credentials for ${wanted} in ${f.credentialsDir}: sign in with ${consent}.`
  else if (account === undefined) problem = `Not signed in to Google yet: run ${consent} on this host (see An assistant host in docs/guide/assistant.md).`
  else if (!account.refresh_token) {
    problem = `${account.email}'s credentials have no refresh token, so they stop working within the hour: sign in again with ${consent}.`
  }
  const warnings: Array<string> = []
  if (account !== undefined) {
    if (!account.private) warnings.push(`${account.file} can be read by other users on this host: chmod 600 it.`)
    if (account.missing_scopes.length > 0) {
      warnings.push(`${account.email} wasn't given everything the brief reads (${account.missing_scopes.join(", ")}): sign in again and tick every box.`)
    }
  }
  if (f.clientSecret.exists && !f.clientSecret.private) warnings.push(`${f.clientSecret.path} can be read by other users on this host: chmod 600 it.`)
  if (wanted === null && accounts.length > 1)
    warnings.push(`There are credentials for ${accounts.length} accounts: set ${EMAIL_ENV} in the server's env to pick one.`)
  return {
    connected: problem === null,
    account: problem === null && account !== undefined ? account.email : null,
    problem,
    warnings,
    server: s,
    client_secret: f.clientSecret,
    credentials_dir: f.credentialsDir,
    accounts,
    consent_command: consent,
    host: f.host,
    consent_port: CONSENT_PORT,
  }
}

/** What a routine's `{{google}}` says: `connected as <email>`, or `not connected: <why>`. */
export const statusLine = (st: GoogleStatus): string => (st.connected ? `connected as ${st.account ?? ""}` : `not connected: ${st.problem ?? ""}`)

// ---- the consent flow (`huntaway google-auth`) ----

/** An OAuth client, from the JSON Google Cloud's console downloads for it. `web`: a Web application client, not a Desktop app one. */
export interface Client {
  readonly client_id: string
  readonly client_secret: string
  readonly auth_uri: string
  readonly token_uri: string
  readonly web: boolean
}

const ClientFields = Schema.Struct({
  client_id: Schema.optional(Schema.Unknown),
  client_secret: Schema.optional(Schema.Unknown),
  auth_uri: Schema.optional(Schema.Unknown),
  token_uri: Schema.optional(Schema.Unknown),
})
const ClientFile = Schema.Union([Schema.Struct({ installed: ClientFields }), Schema.Struct({ web: ClientFields })])
const decodeClientJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const decodeClientFile = Schema.decodeUnknownOption(ClientFile)

const field = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null)

/** The client in a `client_secret.json` (`{"installed": {…}}` for a Desktop app client, `{"web": {…}}` for a Web one). */
export const readClient = (text: string): Result.Result<Client, string> => {
  const json = decodeClientJson(text)
  if (Option.isNone(json)) return Result.fail("the client secret file isn't JSON")
  const file = decodeClientFile(json.value)
  if (Option.isNone(file)) return Result.fail('the client secret file has no "installed" (Desktop app) or "web" client in it')
  const [c, web] = "installed" in file.value ? [file.value.installed, false] : [file.value.web, true]
  const id = field(c.client_id)
  if (id === null) return Result.fail("the client secret file has no client_id")
  const secret = field(c.client_secret)
  if (secret === null) return Result.fail("the client secret file has no client_secret")
  return Result.succeed({ client_id: id, client_secret: secret, auth_uri: field(c.auth_uri) ?? AUTH_URI, token_uri: field(c.token_uri) ?? TOKEN_URI, web })
}

/** The consent URL: offline access (for a refresh token), the consent screen every time, and PKCE's S256 `challenge`. */
export const consentUrl = (c: Client, redirect: string, state: string, challenge: string): string => {
  const q = new URLSearchParams([
    ["client_id", c.client_id],
    ["redirect_uri", redirect],
    ["response_type", "code"],
    ["scope", SCOPES.join(" ")],
    ["access_type", "offline"],
    ["prompt", "consent"],
    ["include_granted_scopes", "true"],
    ["state", state],
    ["code_challenge", challenge],
    ["code_challenge_method", "S256"],
  ])
  return `${c.auth_uri}?${q.toString()}`
}

/** What the browser brought back to the redirect: the code, Google's error, or `other` (not the redirect, or another flow's). */
export type Callback = { readonly kind: "code"; readonly code: string } | { readonly kind: "denied"; readonly error: string } | { readonly kind: "other" }

/** Reads a request (its path and query, `/?state=…&code=…`) for the redirect's answer, if its state is `state`. */
export const readCallback = (target: string, state: string): Callback => {
  const i = target.indexOf("?")
  const [path, query] = i < 0 ? [target, ""] : [target.slice(0, i), target.slice(i + 1)]
  if (path !== "/") return { kind: "other" }
  const q = new URLSearchParams(query)
  if (q.get("state") !== state) return { kind: "other" }
  const code = q.get("code")
  const error = q.get("error")
  if (code !== null && code !== "") return { kind: "code", code }
  if (error !== null) return { kind: "denied", error }
  return { kind: "other" }
}

const IdTokenPayload = Schema.Struct({ email: Schema.optional(Schema.Unknown) })
const decodePayload = Schema.decodeUnknownOption(Schema.fromJsonString(IdTokenPayload))

/** The account an ID token is for: its `email` claim (it came from Google's token endpoint over TLS, so it isn't checked again). */
export const idTokenEmail = (idToken: string): string | null => {
  const payload = idToken.split(".")[1]
  if (payload === undefined) return null
  const b64 = payload.replace(/=+$/u, "")
  if (!/^[A-Za-z0-9_-]*$/.test(b64)) return null
  const bytes = Base64Url.decode(b64)
  if (Result.isFailure(bytes)) return null
  const v = decodePayload(new TextDecoder().decode(bytes.success))
  return Option.isSome(v) && typeof v.value.email === "string" ? v.value.email : null
}

/** What Google's token endpoint answers. */
export const TokenAnswer = Schema.Struct({
  access_token: Schema.optional(Schema.NullOr(Schema.String)),
  refresh_token: Schema.optional(Schema.NullOr(Schema.String)),
  id_token: Schema.optional(Schema.NullOr(Schema.String)),
  scope: Schema.optional(Schema.NullOr(Schema.String)),
  expires_in: Schema.optional(Schema.NullOr(Schema.Finite)),
  error: Schema.optional(Schema.NullOr(Schema.String)),
  error_description: Schema.optional(Schema.NullOr(Schema.String)),
})
export type TokenAnswer = typeof TokenAnswer.Type

/**
 * The credentials workspace-mcp reads (auth/credential_store.py): the tokens, the client, the scopes granted and when
 * the access token expires (a naive UTC time, as google-auth keeps it, from `now` in milliseconds). The account's email.
 */
export const credentialsJson = (c: Client, token: TokenAnswer, now: number): Result.Result<readonly [string, CredentialsJson], string> => {
  const refresh = typeof token.refresh_token === "string" && token.refresh_token !== "" ? token.refresh_token : null
  if (refresh === null)
    return Result.fail("Google gave no refresh token. Remove the app's access at https://myaccount.google.com/permissions and sign in again.")
  const email = typeof token.id_token === "string" ? idTokenEmail(token.id_token) : null
  if (email === null) return Result.fail("Google didn't say which account this is (no email in its ID token)")
  const scopes = typeof token.scope === "string" ? token.scope.split(/\s+/).filter((s) => s !== "") : [...SCOPES]
  const expiresIn = token.expires_in
  const expiry = typeof expiresIn === "number" && Number.isInteger(expiresIn) ? isoSeconds(now + expiresIn * 1000) : null
  return Result.succeed([
    email,
    {
      token: token.access_token ?? null,
      refresh_token: refresh,
      token_uri: c.token_uri,
      client_id: c.client_id,
      client_secret: c.client_secret,
      scopes,
      expiry,
    },
  ])
}

/** `YYYY-MM-DDTHH:MM:SS` (UTC, no zone) at `ms` milliseconds since the epoch. */
const isoSeconds = (ms: number): string => DateTime.formatIso(DateTime.makeUnsafe(ms)).slice(0, 19)

/** Why the token endpoint said no, from its status and answer. */
export const tokenError = (status: number, answer: TokenAnswer | null): string => {
  const why = [answer?.error, answer?.error_description].filter((x): x is string => typeof x === "string").join(": ")
  return `Google said ${status}${why === "" ? "" : ` (${why})`}`
}
