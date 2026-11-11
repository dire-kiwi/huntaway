import { Config, Console, Effect, FileSystem, Layer, Option, Path, Runtime, Schema, SchemaAST, Stream } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { FetchHttpClient, Headers } from "effect/http"
import { RpcClient, RpcMiddleware, RpcSerialization } from "effect/rpc"
import { Auth, Forbidden, HostRpcs, PublicRpcs, Unauthorized } from "@huntaway/contracts"

// `huntaway rpc <method> [json]` (docs/plan/05-protocol.md, The CLI as a client): one call to a test server over
// `POST /api/rpc` with the typed client, for scripts and agents trying a change. It takes the place of the old
// `scripts/ia-api get|post|…`, and like it touches nothing but a test server on this machine.

/** Every method `huntaway rpc` can call: what a client of its own board can. */
export const CliRpcs = PublicRpcs.merge(HostRpcs)

/** What the typed client needs to reach a server at `url` (`http://host:port`) over HTTP, with its board token. */
export const httpRpcClientLayer = (url: string, token: string) =>
  Layer.mergeAll(
    RpcClient.layerProtocolHttp({ url: `${url.replace(/\/+$/, "")}/api/rpc` }).pipe(
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(RpcSerialization.layerNdjson),
    ),
    RpcMiddleware.layerClient(Auth, ({ next, request }) => next({ ...request, headers: Headers.set(request.headers, "authorization", `Bearer ${token}`) })),
  )

/** The command's own way out: what it says is already on stderr, so the runtime only takes its exit code. */
class RpcCliExit extends Schema.TaggedError<RpcCliExit, { readonly brand: unique symbol }>()("RpcCliExit", { code: Schema.Int }) {
  readonly [Runtime.errorReported] = false
  get [Runtime.errorExitCode](): number {
    return this.code
  }
}

/** Says why on stderr, then exits with `code`: 1 for a server, its answer or its env file, 2 for the command line. */
const fail = (code: 1 | 2, message: string) => Console.error(`huntaway rpc: ${message}`).pipe(Effect.andThen(Effect.fail(new RpcCliExit({ code }))))

/** The live boards' ports: the old server's and the new one's defaults. */
const LIVE_PORTS = new Set(["7878", "7879"])

const MessageJson = Schema.fromJsonString(Schema.Unknown)

const ENV_LINE = /^\s*(?:export\s+)?(HUNTAWAY_TEST_\w+)=(.*)$/

/** The worktree's `.huntaway-test-env`, which `scripts/test-server.sh` points at the latest server's env file. */
const worktreeEnv = new URL("../../../../.huntaway-test-env", import.meta.url)

/** The test server's URL and token, from `--env` (a file or a data dir), `$HUNTAWAY_TEST_ENV` or `.huntaway-test-env`. */
const findServer = Effect.fn("rpc.findServer")(function* (given: Option.Option<string>) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const fromVariable = yield* Config.String("HUNTAWAY_TEST_ENV").pipe(Config.option)
  const candidates = Option.isSome(given)
    ? [given.value]
    : Option.isSome(fromVariable)
      ? [fromVariable.value]
      : [path.resolve(".huntaway-test-env"), yield* path.fromFileUrl(worktreeEnv).pipe(Effect.orDie)]
  let file: string | undefined
  for (const candidate of candidates) {
    const info = yield* fs.stat(candidate).pipe(Effect.option)
    if (Option.isNone(info)) continue
    file = info.value.type === "Directory" ? path.join(candidate, "env") : candidate
    break
  }
  if (file === undefined) {
    return yield* fail(
      1,
      Option.isSome(given) || Option.isSome(fromVariable)
        ? `no env file at ${candidates.join(" or ")} (is the test server stopped?)`
        : "no test server: start one with scripts/test-server.sh, or pass --env <data dir>/env",
    )
  }
  const text = yield* fs.readFileString(file).pipe(Effect.catch(() => fail(1, `can't read ${file} (is the test server stopped?)`)))
  const vars = new Map<string, string>()
  for (const line of text.split("\n")) {
    const match = ENV_LINE.exec(line)
    if (match?.[1] !== undefined && match[2] !== undefined) vars.set(match[1], match[2].trim().replace(/^(['"])(.*)\1$/, "$2"))
  }
  const url = vars.get("HUNTAWAY_TEST_URL")
  const token = vars.get("HUNTAWAY_TEST_TOKEN")
  if (url === undefined || token === undefined || token === "") return yield* fail(1, `${file} has no HUNTAWAY_TEST_URL or HUNTAWAY_TEST_TOKEN`)
  // Test servers only: never a live board, a hub or another machine's server.
  const parsed = URL.canParse(url) ? new URL(url) : null
  if (parsed === null || parsed.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(parsed.hostname)) {
    return yield* fail(1, `${url} isn't a test server: only servers on http://127.0.0.1 are allowed`)
  }
  if (LIVE_PORTS.has(parsed.port)) return yield* fail(1, `${url} is a live board's port, not a test server's`)
  return { url, token }
})

/** The JSON argument as the method's payload: absent is no payload, or `{}` for one whose fields are all optional. */
const payloadText = (schema: Schema.Top, json: Option.Option<string>): string | undefined =>
  SchemaAST.isVoid(schema.ast) ? (Option.isNone(json) || json.value.trim() === "{}" ? undefined : json.value) : Option.getOrElse(json, () => "{}")

const call = Effect.fn("rpc.call")(
  function* (method: string, json: Option.Option<string>, env: Option.Option<string>) {
    const rpc = CliRpcs.requests.get(method)
    if (rpc === undefined) return yield* fail(2, `no method ${method} (huntaway rpc --list lists them)`)
    const text = payloadText(rpc.payloadSchema, json)
    const payload =
      text === undefined
        ? undefined
        : yield* Schema.decodeEffect(Schema.fromJsonString(rpc.payloadSchema))(text).pipe(
            Effect.catch((e) => fail(2, `${method} doesn't take that payload: ${e.message}`)),
          )
    const server = yield* findServer(env)
    const context = yield* Layer.build(httpRpcClientLayer(server.url, server.token))
    const client = yield* RpcClient.make(CliRpcs, { flatten: true }).pipe(Effect.provideContext(context))
    const errorJson = Schema.fromJsonString(Schema.Union([rpc.errorSchema, Unauthorized, Forbidden]))
    const failed = (error: unknown) =>
      Schema.encodeUnknownEffect(errorJson)(error).pipe(
        Effect.flatMap(Console.error),
        Effect.catch(() => Console.error(`huntaway rpc: ${String(error)} (is the test server running?)`)),
        Effect.andThen(Effect.fail(new RpcCliExit({ code: 1 }))),
      )
    const result = client(rpc._tag, payload)
    if (Stream.isStream(result)) {
      // A subscription: one line of JSON per message, until the server ends it or the command is stopped. Its messages
      // are wire types, whose encoded form is the decoded one (docs/effect.md, Schemas).
      return yield* result.pipe(
        Stream.mapEffect((value) => Schema.encodeEffect(MessageJson)(value).pipe(Effect.flatMap(Console.log)), { concurrency: 1 }),
        Stream.runDrain,
        Effect.catch(failed),
      )
    }
    const value = yield* result.pipe(Effect.catch(failed))
    return yield* Schema.encodeUnknownEffect(Schema.fromJsonString(rpc.successSchema, { space: 2 }))(value).pipe(Effect.flatMap(Console.log), Effect.orDie)
  },
  Effect.scoped,
  // A defect on either side (a handler that died, a server without the method): on stderr, as the result is on stdout.
  Effect.catchDefect((defect) => fail(1, `the call failed: ${String(defect)}`)),
)

export const rpcCommand = Command.make(
  "rpc",
  {
    method: Argument.String("method").pipe(Argument.withDescription("The method, as `huntaway rpc --list` names it (host.info)"), Argument.optional),
    json: Argument.String("json").pipe(Argument.withDescription("Its payload as JSON (default none, or {})"), Argument.optional),
    env: Flag.String("env").pipe(
      Flag.withDescription("scripts/test-server.sh's env file or data dir (default $HUNTAWAY_TEST_ENV, then .huntaway-test-env)"),
      Flag.optional,
    ),
    list: Flag.Boolean("list").pipe(Flag.withDescription("Print the method names"), Flag.withDefault(false)),
  },
  ({ method, json, env, list }) =>
    list
      ? Console.log([...CliRpcs.requests.keys()].toSorted().join("\n"))
      : Option.isNone(method)
        ? fail(2, "usage: huntaway rpc <method> [json], or huntaway rpc --list")
        : call(method.value, json, env),
).pipe(
  Command.withDescription(
    "Call a test server's RPC over HTTP and print the result as JSON (exit 1 with the tagged error on stderr; 2 for a bad method or payload)",
  ),
)
