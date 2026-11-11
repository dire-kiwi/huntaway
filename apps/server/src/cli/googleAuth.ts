import { Clock, Config, Console, Context, Deferred, Effect, FileSystem, Layer, Option, Result, Schema } from "effect"
import type { Scope } from "effect"
import { Command, Flag } from "effect/cli"
import { Digest, SecureRandom } from "effect/crypto"
import { Base64Url } from "effect/encoding"
import { HttpClient, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import type { HttpServerError } from "effect/http"
import { tokenRequest } from "../assistant/Google.ts"
import {
  CONSENT_PORT,
  consentUrl,
  credentialsFile,
  credentialsJson,
  defaultClientSecret,
  defaultCredentialsDir,
  readCallback,
  readClient,
  SCOPES,
} from "../assistant/googleText.ts"
import type { Callback, Client } from "../assistant/googleText.ts"

// `huntaway google-auth [--client-secret <file>] [--credentials-dir <dir>] [--port <port>]` (docs/plan/inventory/02-agent-support.md
// 2.12; huntaway's agent/assistant/google/consent.ts): the Google consent step on a headless assistant host. Google's
// loopback flow for a Desktop app client, with PKCE: it listens on `127.0.0.1:<port>` (8765), which `ssh -L` brings to the
// machine the user's browser is on, prints the consent URL, waits (15 minutes at most) for the browser to come back with
// a code, swaps it for tokens and writes them as workspace-mcp keeps its credentials (`<credentials dir>/<email>.json`,
// readable by the host's user alone), so the assistant's Google server uses them from its next start.

/** How long it waits for the browser to come back. */
const WAIT = "15 minutes"

/** Why signing in stopped, as the command says it. */
export class GoogleAuthFailed extends Schema.TaggedError<GoogleAuthFailed, { readonly brand: unique symbol }>()("GoogleAuthFailed", {
  reason: Schema.String,
}) {}

const failed = (reason: string) => new GoogleAuthFailed({ reason })

/** Who signing in signed in, where their credentials are, and the scopes Google didn't grant. */
export interface SignedIn {
  readonly email: string
  readonly file: string
  readonly missing: ReadonlyArray<string>
}

const page = (body: string) => `<!doctype html><meta charset=utf-8><title>Huntaway</title><p style="font:16px system-ui;margin:3em">${body}</p>`

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

/**
 * Writes `content` to `path` readable by its owner alone, by way of a file beside it (so a reader never sees half of it),
 * in a folder made for the owner alone if it isn't there.
 */
export const writePrivate = Effect.fnUntraced(function* (path: string, content: string) {
  const fs = yield* FileSystem.FileSystem
  const dir = path.slice(0, path.lastIndexOf("/"))
  if (!(yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false)))) {
    yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 }).pipe(Effect.mapError((e) => failed(`making ${dir}: ${e.message}`)))
  }
  const tmp = `${dir}/.${path.slice(path.lastIndexOf("/") + 1)}.tmp`
  yield* fs.remove(tmp, { force: true }).pipe(Effect.ignore)
  yield* fs.writeFileString(tmp, content, { flag: "wx", mode: 0o600 }).pipe(Effect.mapError((e) => failed(`writing ${tmp}: ${e.message}`)))
  yield* fs.chmod(tmp, 0o600).pipe(Effect.mapError((e) => failed(`writing ${tmp}: ${e.message}`)))
  yield* fs.rename(tmp, path).pipe(Effect.mapError((e) => failed(`writing ${path}: ${e.message}`)))
})

/** PKCE's S256 challenge for a verifier. */
export const challenge = Effect.fnUntraced(function* (verifier: string) {
  const digest = yield* Digest.Digest
  return Base64Url.encode(yield* digest.digest(Digest.sha256, new TextEncoder().encode(verifier)))
})

/**
 * The flow itself, on the server it's given (its address is the redirect): `show` is given the consent URL and the
 * redirect, then it waits for the browser, swaps the code for tokens and writes them to `credentialsDir`.
 */
export const signIn = Effect.fnUntraced(function* (client: Client, credentialsDir: string, show: (url: string, redirect: string) => Effect.Effect<void>) {
  const server = yield* HttpServer.HttpServer
  const random = yield* SecureRandom.SecureRandom
  const http = yield* HttpClient.HttpClient
  const address = server.address
  const port = address._tag === "UnixPathAddress" ? CONSENT_PORT : address.port
  const redirect = `http://127.0.0.1:${port}/`
  const state = Base64Url.encode(yield* random.randomBytes(24))
  const verifier = Base64Url.encode(yield* random.randomBytes(48))
  const answered = yield* Deferred.make<Callback>()
  // Each request is answered; only this flow's redirect ends the wait.
  yield* server.serve(
    Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest
      const cb = req.method === "GET" ? readCallback(req.url, state) : { kind: "other" as const }
      if (cb.kind === "other") return HttpServerResponse.html(page("Not found.")).pipe(HttpServerResponse.setStatus(404))
      yield* Deferred.succeed(answered, cb)
      return HttpServerResponse.html(
        page(cb.kind === "code" ? "Signed in. You can close this tab and go back to the terminal." : "Google didn't sign you in. See the terminal."),
      )
    }),
  )
  yield* show(consentUrl(client, redirect, state, yield* challenge(verifier)), redirect)
  const cb = yield* Deferred.await(answered).pipe(
    Effect.timeoutOrElse({ duration: WAIT, orElse: () => Effect.fail(failed("gave up waiting for the browser")) }),
  )
  if (cb.kind !== "code") return yield* failed(`Google said: ${cb.kind === "denied" ? cb.error : "nothing"}`)
  const token = yield* tokenRequest(http, client.token_uri, [
    ["code", cb.code],
    ["client_id", client.client_id],
    ["client_secret", client.client_secret],
    ["redirect_uri", redirect],
    ["grant_type", "authorization_code"],
    ["code_verifier", verifier],
  ]).pipe(Effect.mapError((e) => failed(`exchanging Google's code for tokens: ${e}`)))
  const made = credentialsJson(client, token, yield* Clock.currentTimeMillis)
  if (Result.isFailure(made)) return yield* failed(made.failure)
  const [email, creds] = made.success
  const file = `${credentialsDir}/${credentialsFile(email)}`
  yield* writePrivate(file, yield* encodeJson(creds).pipe(Effect.orDie))
  const granted = new Set((creds.scopes ?? []).filter((s): s is string => typeof s === "string"))
  const out: SignedIn = { email, file, missing: SCOPES.filter((s) => !granted.has(s)) }
  return out
})

/** This host's name, for the ssh command. */
const hostName = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const h = (yield* fs.readFileString("/etc/hostname").pipe(Effect.orElseSucceed(() => ""))).trim()
  return h === "" ? "<this host>" : h
})

/**
 * The command, with `listen`: the HTTP server on 127.0.0.1 and a port (Node's, from the entry point). It needs an HTTP
 * client, `SecureRandom` and `Digest`, which the entry point provides.
 */
export const googleAuthCommand = (listen: (port: number) => Layer.Layer<HttpServer.HttpServer, HttpServerError.ServeError, Scope.Scope>) =>
  Command.make(
    "google-auth",
    {
      clientSecret: Flag.String("client-secret").pipe(
        Flag.withDescription("The OAuth client's JSON, downloaded from Google Cloud (a Desktop app client)"),
        Flag.optional,
      ),
      credentialsDir: Flag.String("credentials-dir").pipe(
        Flag.withDescription("Where to keep the credentials (workspace-mcp's WORKSPACE_MCP_CREDENTIALS_DIR)"),
        Flag.optional,
      ),
      port: Flag.Int("port").pipe(Flag.withDescription(`The port to listen on (default ${CONSENT_PORT})`), Flag.withDefault(CONSENT_PORT)),
    },
    ({ clientSecret, credentialsDir, port }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const home = yield* Config.String("HOME").pipe(Config.withDefault("/"))
        const secretPath = Option.getOrElse(clientSecret, () => defaultClientSecret(home))
        const text = yield* fs.readFileString(secretPath).pipe(Effect.mapError((e) => failed(`reading the OAuth client from ${secretPath}: ${e.message}`)))
        const client = readClient(text)
        if (Result.isFailure(client)) return yield* failed(`in ${secretPath}: ${client.failure}`)
        const dir = Option.getOrElse(credentialsDir, () => defaultCredentialsDir(home))
        const host = yield* hostName
        yield* Console.log(`Signing in to Google for the assistant's Google server, with the OAuth client in ${secretPath}.`)
        // The loopback listener, on the port given (so it's built here, not at the entry point).
        const listening = yield* Layer.build(listen(port)).pipe(
          Effect.mapError(() => failed(`listening on 127.0.0.1:${port} (pick another with --port, and forward that one)`)),
        )
        const done = yield* signIn(client.success, dir, (url, redirect) =>
          Effect.gen(function* () {
            const at = redirect.replace(/\/$/u, "").split(":").at(-1) ?? String(port)
            if (client.success.web) {
              yield* Console.log(
                `\nThat's a Web application client: Google sends the browser back only to its registered redirect URIs, so add ${redirect} to them (or use a Desktop app client).`,
              )
            }
            yield* Console.log(
              `\n1. Forward this port from the machine your browser is on, if you haven't (in another terminal there):\n\n     ssh -N -L ${at}:127.0.0.1:${at} ${host}\n`,
            )
            yield* Console.log(`2. Open this in that browser, sign in and allow access:\n\n     ${url}\n`)
            yield* Console.log(`Waiting for Google to send the browser back to ${redirect} (up to 15 minutes)…`)
          }),
        ).pipe(Effect.provideService(HttpServer.HttpServer, Context.get(listening, HttpServer.HttpServer)))
        yield* Console.log(`\nSigned in as ${done.email}. Its credentials are in ${done.file} (readable by you alone).`)
        if (done.missing.length > 0) {
          yield* Console.log(
            `Google didn't grant all it was asked for (some boxes were left unticked): ${done.missing.join(", ")}. Run this again to give them.`,
          )
        }
        return yield* Console.log("The assistant's Google card shows it as connected. The Google server picks it up from its next run.")
      }).pipe(
        Effect.scoped,
        Effect.catchTag("GoogleAuthFailed", (e) => Console.error(`huntaway google-auth: ${e.reason}`).pipe(Effect.andThen(Effect.fail(e)))),
      ),
  ).pipe(Command.withDescription("Sign in to Google for the assistant's Google server (Gmail, Calendar, Drive), on a headless host"))
