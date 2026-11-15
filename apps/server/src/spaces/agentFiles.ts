import { Option, Schema } from "effect"

// What of a host's Claude Code and Codex configs goes into a Space (HE-35), plainly. Their sign-ins go in without their
// refresh tokens: Anthropic and OpenAI rotate a refresh token when it is used, so a Space that refreshed would sign the
// host out. A Space's agents use the access token until it expires, and the board copies a fresh one in when asked
// (`spaces.syncAgents`) and whenever the Space starts. Cua Spaces does the same (`CLAUDE_CODE_OAUTH_TOKEN`, the access
// token alone). No I/O here.

/** A file to write in the desktop user's home: its path under it and its contents. */
export interface HomeFile {
  readonly path: string
  readonly contents: string
  /** Readable by its owner only. */
  readonly secret: boolean
}

const Json = Schema.fromJsonString(Schema.Unknown)
const JsonObject = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
const decodeObject = Schema.decodeUnknownOption(JsonObject)
const encode = (v: unknown): string => Option.getOrElse(Schema.encodeOption(Schema.fromJsonString(Schema.Unknown, { space: 2 }))(v), () => "{}")
const isObject = (v: unknown): v is Readonly<Record<string, unknown>> => Schema.is(Schema.Record(Schema.String, Schema.Unknown))(v)

/** Claude Code's `.credentials.json` without its refresh token; null if it isn't one. */
export const claudeCredentials = (text: string): string | null => {
  const creds = Option.getOrNull(decodeObject(text))
  if (creds === null) return null
  const oauth = creds["claudeAiOauth"]
  if (!isObject(oauth)) return encode(creds)
  const { refreshToken: _, ...rest } = oauth
  return encode({ ...creds, claudeAiOauth: rest })
}

/** Codex's `auth.json` with its refresh token emptied (kept as a field, which Codex expects); null if it isn't one. */
export const codexAuth = (text: string): string | null => {
  const auth = Option.getOrNull(decodeObject(text))
  if (auth === null) return null
  const tokens = auth["tokens"]
  if (!isObject(tokens)) return encode(auth)
  return encode({ ...auth, tokens: { ...tokens, refresh_token: "" } })
}

/**
 * Claude Code's `settings.json` for a Space: the host's (if it has one), with the config's proxy in its `env` so the
 * Space's agents go through it too. Hooks and status lines that run programs are left out: they name the host's paths.
 */
export const claudeSettings = (text: string | null, proxyEnv: ReadonlyArray<readonly [string, string]>): string => {
  const host = text === null ? {} : (Option.getOrNull(decodeObject(text)) ?? {})
  const { hooks: _hooks, statusLine: _statusLine, apiKeyHelper: _helper, ...settings } = host
  const env = isObject(settings["env"]) ? settings["env"] : {}
  return encode(proxyEnv.length === 0 ? settings : { ...settings, env: { ...env, ...Object.fromEntries(proxyEnv) } })
}

/** `~/.claude.json` for a Space whose Claude Code hasn't run: past its first-run questions. */
export const CLAUDE_STATE = encode({ hasCompletedOnboarding: true, theme: "dark", bypassPermissionsModeAccepted: false })

/** Whether `text` is JSON at all (a file that isn't is not copied). */
export const isJson = (text: string): boolean => Option.isSome(Schema.decodeOption(Json)(text))

/** What a Claude Code config folder gives a Space, from the files read in it (null where one isn't there). */
export const claudeFiles = (read: {
  readonly credentials: string | null
  readonly settings: string | null
  readonly memory: string | null
  readonly proxyEnv: ReadonlyArray<readonly [string, string]>
}): ReadonlyArray<HomeFile> => {
  const creds = read.credentials === null ? null : claudeCredentials(read.credentials)
  return [
    ...(creds === null ? [] : [{ path: ".claude/.credentials.json", contents: creds, secret: true }]),
    { path: ".claude/settings.json", contents: claudeSettings(read.settings, read.proxyEnv), secret: read.proxyEnv.length > 0 },
    ...(read.memory === null ? [] : [{ path: ".claude/CLAUDE.md", contents: read.memory, secret: false }]),
  ]
}

/** What a Codex config folder gives a Space. */
export const codexFiles = (read: { readonly auth: string | null; readonly config: string | null }): ReadonlyArray<HomeFile> => {
  const auth = read.auth === null ? null : codexAuth(read.auth)
  return [
    ...(auth === null ? [] : [{ path: ".codex/auth.json", contents: auth, secret: true }]),
    ...(read.config === null ? [] : [{ path: ".codex/config.toml", contents: read.config, secret: false }]),
  ]
}
