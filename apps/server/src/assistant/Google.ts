import { Config, Context, Effect, FileSystem, Layer, Option, Result, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { Invalid, Unavailable } from "@huntaway/contracts"
import type { Conflict, NotFound } from "@huntaway/contracts"
import type { GoogleAccount, GoogleFile, GoogleServer, GoogleStatus, ProfileId } from "@huntaway/contracts"
import { AgentTools } from "../agents/AgentTools.ts"
import { Identity } from "../platform/Identity.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { Assistant } from "./Assistant.ts"
import {
  accountFrom,
  accountOf,
  CLIENT_SECRET_ENV,
  CREDENTIALS_ENV,
  decodeCredentials,
  defaultClientSecret,
  defaultCredentialsDir,
  envOf,
  readClient,
  SERVER,
  serverConfig,
  statusLine,
  statusOf,
  TOKEN_URI,
  TokenAnswer,
  tokenError,
} from "./googleText.ts"

// The assistant's Google card (docs/plan/inventory/02-agent-support.md 2.12; huntaway's agent/assistant/google.ts): a
// set-up helper around a global MCP server named `google` (`AgentTools.addServer`, `setSwitch`), and what the card shows
// of it, read from the server's config and the files it reads, on this host. With `check`, the account's refresh token is
// tried with Google once (the token it gets isn't kept).

const decodeAnswer = Schema.decodeUnknownOption(Schema.fromJsonString(TokenAnswer))

/** Posts a form to a token endpoint: its answer, or why it failed. */
export const tokenRequest = (client: HttpClient.HttpClient, uri: string, form: ReadonlyArray<readonly [string, string]>) =>
  client.execute(HttpClientRequest.post(uri, { headers: { accept: "application/json" } }).pipe(HttpClientRequest.bodyUrlParams(form))).pipe(
    Effect.flatMap((res) =>
      Effect.map(res.text.pipe(Effect.orElseSucceed(() => "")), (text) => ({ status: res.status, answer: Option.getOrNull(decodeAnswer(text)) })),
    ),
    Effect.mapError((e) => `reaching ${uri}: ${e.message}`),
    Effect.timeoutOrElse({ duration: "30 seconds", orElse: () => Effect.fail(`reaching ${uri}: it took too long to answer`) }),
    Effect.flatMap(({ status, answer }) =>
      status >= 200 && status < 300 && answer !== null ? Effect.succeed(answer) : Effect.fail(tokenError(status, answer)),
    ),
  )

const EnvOf = Schema.Struct({ env: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)), command: Schema.optional(Schema.Unknown) })
const decodeConfig = Schema.decodeUnknownOption(EnvOf)

export interface GoogleShape {
  /** The card's status for the profile's assistant here; `check` also tries the refresh token with Google. */
  readonly status: (profile: ProfileId, check: boolean) => Effect.Effect<GoogleStatus, NotFound | Conflict>
  /** Adds the host's Google server (unless it has one called `google`) and switches it on for the profile. */
  readonly setup: (profile: ProfileId) => Effect.Effect<GoogleStatus, NotFound | Conflict | Invalid | Unavailable>
  /** What a routine's `{{google}}` says: `connected as <email>`, or `not connected: <why>`. */
  readonly line: (profile: ProfileId) => Effect.Effect<string>
}

export class Google extends Context.Service<Google, GoogleShape>()("huntaway-server/assistant/Google") {
  static readonly layer = Layer.effect(
    Google,
    Effect.gen(function* () {
      const tools = yield* AgentTools
      const assistant = yield* Assistant
      const config = yield* ServerConfig
      const identity = yield* Identity
      const fs = yield* FileSystem.FileSystem
      const http = yield* HttpClient.HttpClient
      // Whether the server's command can be run is looked for on this PATH.
      const path = Option.getOrElse(yield* Config.String("PATH").pipe(Config.option), () => "")

      const expand = (p: string) => (p === "~" ? config.home : p.startsWith("~/") ? `${config.home}${p.slice(1)}` : p)
      const statOf = (p: string) => Effect.option(fs.stat(p))

      const runnable = (p: string) => Effect.map(statOf(p), (m) => Option.isSome(m) && m.value.type === "File" && (m.value.mode & 0o111) !== 0)

      /** Whether `cmd` can be run: a path to a file, or a name found on PATH. */
      const commandFound = Effect.fnUntraced(function* (cmd: string) {
        const c = cmd.trim()
        if (c === "") return false
        if (c.includes("/")) return yield* runnable(expand(c))
        for (const d of path.split(":")) if (yield* runnable(`${d === "" ? "." : d}/${c}`)) return true
        return false
      })

      const fileState = Effect.fnUntraced(function* (p: string) {
        const m = yield* statOf(p)
        const out: GoogleFile = { path: p, exists: Option.isSome(m) && m.value.type === "File", private: Option.isSome(m) && (m.value.mode & 0o077) === 0 }
        return out
      })

      /** The accounts with credentials in `dir`, by email. */
      const accounts = Effect.fnUntraced(function* (dir: string) {
        const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
        const out: Array<GoogleAccount> = []
        for (const name of names) {
          const email = accountOf(name)
          if (email === null) continue
          const file = `${dir}/${name}`
          const m = yield* statOf(file)
          if (Option.isNone(m) || m.value.type !== "File") continue
          const text = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))
          out.push(accountFrom({ email, file, private: (m.value.mode & 0o077) === 0, credentials: Option.getOrNull(decodeCredentials(text)) }))
        }
        return out.toSorted((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0))
      })

      /** The host's `google` server, if it has one, and whether the profile switches it on. */
      const serverOf = Effect.fnUntraced(function* (profile: ProfileId) {
        const all = yield* tools.global
        const server = all.mcp_servers.find((s) => s.name === SERVER) ?? null
        const on = server !== null && all.profile_switches[profile]?.[server.id] === true
        return { server, on }
      })

      /** The profile's assistant's Google is here: refused when its assistant runs on another host (and this one has none). */
      const here = assistant.here

      const read = Effect.fnUntraced(function* (profile: ProfileId) {
        const { server, on } = yield* serverOf(profile)
        const decoded = server === null ? Option.none() : decodeConfig(server.config)
        const rawEnv = Option.isSome(decoded) ? (decoded.value.env ?? {}) : {}
        const env: Record<string, string> = Object.fromEntries(Object.entries(rawEnv).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : [])))
        const secret = Option.match(Option.fromNullishOr(envOf(env, CLIENT_SECRET_ENV)), { onNone: () => defaultClientSecret(config.home), onSome: expand })
        const creds = Option.match(Option.fromNullishOr(envOf(env, CREDENTIALS_ENV)), { onNone: () => defaultCredentialsDir(config.home), onSome: expand })
        let state: GoogleServer | null = null
        if (server !== null) {
          const command = Option.isSome(decoded) && typeof decoded.value.command === "string" ? decoded.value.command : ""
          state = { id: server.id, enabled: server.enabled, on, command, command_found: yield* commandFound(command) }
        }
        return statusOf({
          server: state,
          env,
          clientSecret: yield* fileState(secret),
          credentialsDir: creds,
          accounts: yield* accounts(creds),
          host: identity.hostName,
        })
      })

      /** Uses the account's refresh token once. */
      const verify = Effect.fnUntraced(function* (credentials: string, clientSecret: string | null) {
        const text = yield* fs.readFileString(credentials).pipe(Effect.mapError((e) => `reading ${credentials}: ${e.message}`))
        const v = decodeCredentials(text)
        const refresh = Option.isSome(v) && typeof v.value.refresh_token === "string" ? v.value.refresh_token : null
        if (refresh === null) return yield* Effect.fail("its credentials have no refresh token")
        const fromFile =
          clientSecret === null
            ? null
            : Option.getOrNull(Option.flatMap(yield* Effect.option(fs.readFileString(clientSecret)), (t) => Result.getSuccess(readClient(t))))
        const id = (Option.isSome(v) ? v.value.client_id : null) ?? fromFile?.client_id ?? null
        if (id === null) return yield* Effect.fail("no client id")
        const secret = (Option.isSome(v) ? v.value.client_secret : null) ?? fromFile?.client_secret ?? null
        if (secret === null) return yield* Effect.fail("no client secret")
        const uri = (Option.isSome(v) ? v.value.token_uri : null) ?? TOKEN_URI
        return yield* tokenRequest(http, uri, [
          ["refresh_token", refresh],
          ["client_id", id],
          ["client_secret", secret],
          ["grant_type", "refresh_token"],
        ]).pipe(
          Effect.mapError((e) => `Google turned its refresh token away: sign in again: ${e}`),
          Effect.asVoid,
        )
      })

      const status = Effect.fn("Google.status")(function* (profile: ProfileId, check: boolean) {
        yield* here(profile)
        const st = yield* read(profile)
        if (!check || !st.connected) return st
        const file = st.accounts.find((a) => a.email === st.account)?.file ?? null
        if (file === null) return { ...st, verified: false }
        const tried = yield* Effect.result(verify(file, st.client_secret.exists ? st.client_secret.path : null))
        return Result.isSuccess(tried) ? { ...st, verified: true } : { ...st, verified: false, verify_error: tried.failure }
      })

      const setup = Effect.fn("Google.setup")(function* (profile: ProfileId) {
        yield* here(profile)
        let { server } = yield* serverOf(profile)
        if (server === null) {
          // The account to act as, if there's one signed in already.
          const signedIn = (yield* accounts(defaultCredentialsDir(config.home))).filter((a) => a.refresh_token)
          const email = signedIn.length === 1 ? (signedIn[0]?.email ?? null) : null
          server = yield* tools.addServer(null, { name: SERVER, config: serverConfig(config.home, email) }).pipe(
            Effect.catchTags({
              ToolInvalid: (e) => Effect.fail(new Invalid({ field: "config", reason: e.reason })),
              ToolConflict: (e) => Effect.fail(new Unavailable({ what: "google server", reason: e.detail })),
              ToolNotFound: Effect.die,
            }),
          )
        }
        yield* tools
          .setSwitch({ scope: "profile", scope_id: profile, item_id: server.id, enabled: true })
          .pipe(Effect.catchTags({ ToolInvalid: (e) => Effect.fail(new Invalid({ field: "switch", reason: e.reason })), ToolNotFound: Effect.die }))
        return yield* read(profile)
      })

      const line = Effect.fn("Google.line")(function* (profile: ProfileId) {
        const st = yield* Effect.result(read(profile))
        return Result.isSuccess(st) ? statusLine(st.success) : "not connected: its status couldn't be read"
      })

      return Google.of({ status, setup, line })
    }),
  )
}
