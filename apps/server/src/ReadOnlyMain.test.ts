import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Cause, Context, Deferred, Effect, Exit, FileSystem, Layer, Ref, Schema } from "effect"
import { Headers, HttpClient, HttpClientError } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { RpcMessage, RpcServer } from "effect/rpc"
import { Auth, GitStatus, HostInfo, RequiredScope, Session } from "@huntaway/contracts"
import type { Scope } from "@huntaway/contracts"
import { importedFolder } from "@huntaway/testing"
import type { ImportedFolder } from "@huntaway/testing"
import { ImportGuard } from "./platform/ImportGuard.ts"
import { isReadingGit } from "./platform/ReadOnly.ts"
import { ServerConfig } from "./platform/ServerConfig.ts"
import { ReadOnlyAreas, ReadOnlyHandlers, ReadOnlyRpcHandlers, ReadOnlyServed } from "./ReadOnlyMain.ts"
import { isRead } from "./rpc/readOnly.ts"

// The read-only server's service test (docs/plan/11-migration.md, Rehearsal): a rehearsal board whose stored paths point
// at a real repository and an old board's folder; every reading RPC is called and every changing RPC attempted, the list
// taken from the contract; then the repository and the old folder are byte for byte what they were, the processes
// started were reading git commands only, and nothing was asked of the network.
//
// The folder is `@huntaway/testing`'s `importedFolder`: an old board (the old schema) whose task has a worktree in the
// old folder, imported with `import-legacy --rehearsal --check`, as a host's rehearsal is made.

process.env["GIT_CONFIG_GLOBAL"] = "/dev/null"
process.env["GIT_CONFIG_NOSYSTEM"] = "1"

/** Every entry under `dir`, with a file's bytes (as hex) and mode, so that any change shows. */
const snapshot = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const entries = (yield* fs.readDirectory(dir, { recursive: true })).toSorted()
    const out: Array<string> = []
    for (const entry of entries) {
      const path = `${dir}/${entry}`
      const link = yield* fs.readLink(path).pipe(Effect.option)
      if (link._tag === "Some") {
        out.push(`${entry} -> ${link.value}`)
        continue
      }
      const info = yield* fs.stat(path)
      const bytes = info.type === "File" ? Buffer.from(yield* fs.readFile(path)).toString("hex") : ""
      out.push(`${entry} ${info.type} ${info.mode.toString(8)} ${bytes}`)
    }
    return out
  }).pipe(Effect.orDie)

interface Spawned {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly locks: string | undefined
}

/**
 * The machine as the read-only server meets it: the real file system and processes, with every process started and
 * every HTTP request recorded. The read-only server puts its own spawner over this one and its own HTTP client in
 * place of this one: what is recorded here is what got past them.
 */
const recordingMachine = (spawned: Ref.Ref<ReadonlyArray<Spawned>>, requests: Ref.Ref<ReadonlyArray<string>>) =>
  Layer.mergeAll(
    Layer.effect(
      ChildProcessSpawner.ChildProcessSpawner,
      Effect.gen(function* () {
        const real = yield* ChildProcessSpawner.ChildProcessSpawner
        return ChildProcessSpawner.make((command) =>
          Effect.andThen(
            Ref.update(spawned, (all) => [
              ...all,
              command._tag === "StandardCommand"
                ? {
                    command: command.command,
                    args: command.args.map((a) => (typeof a === "string" ? a : "<redacted>")),
                    locks: typeof command.options.env?.["GIT_OPTIONAL_LOCKS"] === "string" ? command.options.env["GIT_OPTIONAL_LOCKS"] : undefined,
                  }
                : { command: "<pipeline>", args: [], locks: undefined },
            ]),
            real.spawn(command),
          ),
        )
      }),
    ),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Ref.update(requests, (all) => [...all, `${request.method} ${request.url}`]).pipe(
          Effect.andThen(
            Effect.fail(new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request, description: "recorded, not sent" }) })),
          ),
        ),
      ),
    ),
  ).pipe(Layer.provideMerge(NodeServices.layer))

/** The read-only server's handlers over its services on `folder`, on the recording machine. */
const readOnlyOn = <A, E>(
  handlers: Layer.Layer<A, E, Layer.Success<typeof ReadOnlyAreas>>,
  folder: ImportedFolder,
  machine: ReturnType<typeof recordingMachine>,
) =>
  handlers.pipe(
    Layer.provideMerge(ReadOnlyAreas),
    Layer.provideMerge(Layer.mergeAll(ServerConfig.layerTest({ dataDir: folder.dataDir, token: null }), ImportGuard.layerOf(folder.record))),
    Layer.provideMerge(machine),
  )

type Outcome =
  | { readonly _tag: "Chunk"; readonly values: ReadonlyArray<unknown> }
  | { readonly _tag: "Exit"; readonly exit: Exit.Exit<unknown, unknown> }
  | { readonly _tag: "Defect"; readonly defect: unknown }

/**
 * The RPC server in process, without serialization: a request reaches `Auth` with its payload as given, so a change can
 * be attempted without a payload of its own (`Auth` refuses it before the payload is looked at). A stream's first chunk
 * is its outcome, and the stream is then interrupted.
 */
const inProcess = Effect.gen(function* () {
  const waiting = new Map<string, Deferred.Deferred<Outcome>>()
  const settle = (requestId: RpcMessage.RequestId, outcome: Outcome) => {
    const deferred = waiting.get(String(requestId))
    return deferred === undefined ? Effect.void : Deferred.succeed(deferred, outcome).pipe(Effect.asVoid)
  }
  const server = yield* RpcServer.makeNoSerialization(ReadOnlyServed, {
    disableClientAcks: true,
    onFromServer: (message) =>
      message._tag === "Chunk"
        ? settle(message.requestId, { _tag: "Chunk", values: message.values })
        : message._tag === "Exit"
          ? settle(message.requestId, { _tag: "Exit", exit: message.exit })
          : message._tag === "Defect"
            ? Effect.forEach([...waiting.values()], (d) => Deferred.succeed(d, { _tag: "Defect", defect: message.defect }), { concurrency: 1 }).pipe(
                Effect.asVoid,
              )
            : Effect.void,
  })
  let next = 0
  return Effect.fnUntraced(function* (rpc: AnyRpc, payload: unknown, token: string | null) {
    next++
    const id = RpcMessage.RequestId(next)
    const outcome = yield* Deferred.make<Outcome>()
    waiting.set(String(id), outcome)
    const headers = Headers.fromInput(token === null ? {} : { authorization: `Bearer ${token}` })
    // A read's payload is decoded as the server would; a change's is none (`Auth` refuses it before it is looked at).
    const decoded = payload === undefined ? undefined : yield* Schema.decodeUnknownEffect(rpc.payloadSchema)(payload).pipe(Effect.orDie)
    yield* server.write(0, { _tag: "Request", id, tag: rpc._tag, payload: decoded, headers })
    const result = yield* Deferred.await(outcome)
    if (result._tag === "Chunk") yield* server.write(0, { _tag: "Interrupt", requestId: id, interruptors: [] })
    return result
  })
})

/** How an outcome reads in a failure message: its error's tag, a defect, or what it answered. */
const failureOf = (outcome: Outcome): string | null => {
  if (outcome._tag === "Defect") return `defect: ${String(outcome.defect)}`
  if (outcome._tag === "Chunk" || Exit.isSuccess(outcome.exit)) return null
  const error = Cause.findErrorOption(outcome.exit.cause)
  if (error._tag === "Some") {
    const e = error.value
    return typeof e === "object" && e !== null && "_tag" in e ? String(e._tag) : String(e)
  }
  return `defect: ${Cause.pretty(outcome.exit.cause).split("\n")[0]}`
}

/** What the reads are called with: the rehearsal's own profile, project and task where they take one. */
const readPayloads = (f: ImportedFolder): Readonly<Record<string, unknown>> => {
  const profile = f.profile
  const day = { profile_id: profile, from: "2026-11-01T00:00:00Z", to: "2026-11-30T00:00:00Z" }
  return {
    "host.info": undefined,
    "host.settings": undefined,
    "host.usage": { refresh: true },
    "host.defaultPrompts": undefined,
    "board.watch": {},
    "board.previewStatus": { url: "https://example.com/preview" },
    "profiles.list": undefined,
    "configs.list": undefined,
    "configs.models": { id: "none" },
    "projects.list": { profile_id: profile },
    "projects.get": { id: f.project },
    "projects.systemPrompt": { id: f.project, options: {} },
    "projects.branches": { id: f.project },
    "tasks.list": { filter: { _tag: "ByProject", project_id: f.project } },
    "tasks.get": { id: f.task },
    "tasks.context": { id: f.task },
    "tasks.unmerged": { id: f.task },
    "tasks.skills": { id: f.task },
    "tasks.fanout": { id: f.task },
    "tasks.document": { id: f.task },
    "pens.list": { profile_id: profile },
    "attachments.get": { id: "none", name: "none.txt" },
    "approvalRules.get": { profile_id: profile },
    "approvalRules.log": { profile_id: profile },
    "threads.watch": { task_id: f.task, limit: 50 },
    "threads.page": { task_id: f.task, before: 10, limit: 50 },
    "permissions.pending": {},
    "permissions.approvals": undefined,
    "checkpoints.turns": { task_id: f.task },
    "checkpoints.turnDiff": { task_id: f.task, from: 0, to: 1 },
    "git.taskDiff": { id: f.task },
    "git.status": { id: f.task },
    "git.diff": { id: f.task, path: "notes.txt", untracked: true },
    "git.show": { id: f.task, rev: f.head },
    "profiles.asanaTasks": { profile_id: profile, q: "x" },
    "profiles.githubAccounts": undefined,
    "profiles.githubRepos": {},
    "agentTools.get": undefined,
    "agentTools.project": { project_id: f.project },
    "hub.push.info": undefined,
    "automations.list": { project_id: f.project },
    "automations.get": { id: "none" },
    "automations.runs": { id: "none" },
    "docs.list": { profile_id: profile },
    "docs.get": { profile_id: profile, slug: "none" },
    "docs.labels": { profile_id: profile },
    "docs.image": { profile_id: profile, sha256: "0".repeat(64) },
    "docs.version": { profile_id: profile, slug: "none", version: 1 },
    "docs.comments": { profile_id: profile, slug: "none" },
    "docs.hostedStatus": { profile_id: profile },
    "assistant.get": { profile_id: profile },
    "assistant.memory": { profile_id: profile },
    "assistant.memoryFile": { profile_id: profile, path: "MEMORY.md" },
    "assistant.memoryHistory": { profile_id: profile },
    "assistant.memoryDiff": { profile_id: profile, rev: "HEAD" },
    "assistant.google": { profile_id: profile, check: true },
    "workflows.list": { project_id: f.project },
    "workflows.get": { id: "none" },
    "workflows.runsOfTask": { task_id: f.task },
    "analytics.report": day,
    "analytics.contextStats": day,
    "analytics.tokenStats": day,
    "analytics.diskUsage": { profile_id: profile },
    "hub.hosts.watch": undefined,
    "hub.hosts.list": undefined,
    "hub.hosts.openRelay": { host_id: "elsewhere" },
  }
}

const rpcs = [...ReadOnlyServed.requests.values()]
type AnyRpc = (typeof rpcs)[number]
const reads = rpcs.filter(isRead)
const byTag = (tag: string) => rpcs.filter((rpc) => rpc._tag === tag)
const changes = rpcs.filter((rpc) => !isRead(rpc) && Context.get(rpc.annotations, RequiredScope) !== null)

describe("the read-only server", () => {
  it.live(
    "on a rehearsal: every read is served, every change refused, and the repository, the old folder, processes and network untouched",
    () =>
      Effect.gen(function* () {
        const folder = yield* importedFolder({ rehearsal: true })
        const before = { repo: yield* snapshot(folder.repo), old: yield* snapshot(folder.oldDir) }
        const spawned = yield* Ref.make<ReadonlyArray<Spawned>>([])
        const requests = yield* Ref.make<ReadonlyArray<string>>([])
        const payloads = readPayloads(folder)

        const outcomes = yield* Effect.gen(function* () {
          const call = yield* inProcess
          const read = new Map<string, Outcome>()
          for (const rpc of reads) {
            assert.isTrue(rpc._tag in payloads, `${rpc._tag} is a read with no payload in this test: give it one`)
            read.set(rpc._tag, yield* call(rpc, payloads[rpc._tag], folder.token))
          }
          const changed = new Map<string, Outcome>()
          for (const rpc of changes) changed.set(rpc._tag, yield* call(rpc, undefined, folder.token))
          // The token is still required: none, or a wrong one, is refused for a read as for a change.
          const anonymous = [
            ...(yield* Effect.forEach(byTag("host.info"), (rpc) => call(rpc, undefined, null), { concurrency: 1 })),
            ...(yield* Effect.forEach(byTag("tasks.get"), (rpc) => call(rpc, { id: folder.task }, "not-the-token"), { concurrency: 1 })),
          ]
          return { read, changed, anonymous }
        }).pipe(Effect.scoped, Effect.provide(readOnlyOn(ReadOnlyHandlers, folder, recordingMachine(spawned, requests))))

        // Every read reached its handler: none was refused, none is missing a handler.
        const readFailures = [...outcomes.read].flatMap(([tag, o]) => {
          const failure = failureOf(o)
          return failure !== null && (failure.includes("RefusedOnReadOnly") || failure === "Forbidden" || failure === "Unauthorized")
            ? [`${tag}: ${failure}`]
            : []
        })
        assert.deepStrictEqual(readFailures, [])
        // The ones that read the rehearsal's own rows and repository answer.
        const answered = (tag: string) => {
          const o = outcomes.read.get(tag)
          return o !== undefined && failureOf(o) === null
        }
        for (const tag of [
          "host.info",
          "board.watch",
          "profiles.list",
          "projects.get",
          "tasks.get",
          "tasks.list",
          "threads.watch",
          "threads.page",
          "git.status",
          "git.diff",
          "git.show",
          "git.taskDiff",
          "projects.branches",
          "hub.hosts.list",
          "permissions.pending",
          "analytics.report",
          "checkpoints.turns",
        ])
          assert.isTrue(answered(tag), `${tag} answered: ${String(failureOf(outcomes.read.get(tag) ?? { _tag: "Defect", defect: "not called" }))}`)
        const info = outcomes.read.get("host.info")
        const infoValue = info?._tag === "Exit" && Exit.isSuccess(info.exit) ? yield* Schema.decodeUnknownEffect(HostInfo)(info.exit.value) : null
        assert.deepStrictEqual(
          [infoValue?.read_only, infoValue?.rehearsal, infoValue?.agents, infoValue?.capabilities],
          [true, { from: folder.oldDir, imported_at: folder.record.at }, false, ["read_only"]],
        )
        const status = outcomes.read.get("git.status")
        const statusValue = status?._tag === "Exit" && Exit.isSuccess(status.exit) ? yield* Schema.decodeUnknownEffect(GitStatus)(status.exit.value) : null
        assert.deepStrictEqual(
          (statusValue?.files ?? []).map((f) => f.path),
          ["notes.txt"],
        )

        // Every change was refused by the session's scope.
        assert.isAbove(changes.length, 100)
        assert.deepStrictEqual(
          [...outcomes.changed].flatMap(([tag, o]) => (failureOf(o) === "Forbidden" ? [] : [`${tag}: ${failureOf(o)}`])),
          [],
        )
        assert.deepStrictEqual(outcomes.anonymous.map(failureOf), ["Unauthorized", "Unauthorized"])

        // Nothing outside its folder changed; only reading git ran, without locks; nothing went to the network.
        assert.deepStrictEqual(yield* snapshot(folder.repo), before.repo)
        assert.deepStrictEqual(yield* snapshot(folder.oldDir), before.old)
        const ran = yield* Ref.get(spawned)
        assert.isAbove(ran.length, 0)
        assert.deepStrictEqual(
          ran.filter((s) => !isReadingGit(s.command, s.args) || s.locks !== "0"),
          [],
        )
        assert.deepStrictEqual(yield* Ref.get(requests), [])
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    60_000,
  )

  it.live("a change that got past Auth meets a handler that dies without acting", () =>
    Effect.gen(function* () {
      const folder = yield* importedFolder({ rehearsal: true })
      const spawned = yield* Ref.make<ReadonlyArray<Spawned>>([])
      const requests = yield* Ref.make<ReadonlyArray<string>>([])
      // An `Auth` that lets everything through with every scope: the one place that is not held here.
      const Open = Layer.succeed(
        Auth,
        Auth.of((effect) =>
          Effect.provideService(effect, Session, {
            kind: "board",
            scopes: new Set<Scope>(["read", "operate", "git", "terminal", "settings", "admin", "link"]),
            device_id: null,
            via_link: null,
          }),
        ),
      )
      const before = yield* snapshot(folder.repo)
      const outcomes = yield* Effect.gen(function* () {
        const call = yield* inProcess
        const out: Array<string> = []
        for (const rpc of changes) {
          const o = yield* call(rpc, undefined, folder.token)
          const failure = failureOf(o) ?? "answered"
          if (!failure.includes("RefusedOnReadOnly")) out.push(`${rpc._tag}: ${failure}`)
        }
        return out
      }).pipe(Effect.scoped, Effect.provide(readOnlyOn(ReadOnlyRpcHandlers.pipe(Layer.provideMerge(Open)), folder, recordingMachine(spawned, requests))))
      assert.deepStrictEqual(outcomes, [])
      assert.deepStrictEqual(yield* snapshot(folder.repo), before)
      assert.deepStrictEqual(yield* Ref.get(requests), [])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.live("its spawner starts reading git only, and its HTTP client sends nothing", () =>
    Effect.gen(function* () {
      const folder = yield* importedFolder({ rehearsal: true })
      const spawned = yield* Ref.make<ReadonlyArray<Spawned>>([])
      const requests = yield* Ref.make<ReadonlyArray<string>>([])
      const results = yield* Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const http = yield* HttpClient.HttpClient
        const run = (command: string, args: ReadonlyArray<string>) =>
          spawner.string(ChildProcess.make(command, args, { cwd: folder.repo })).pipe(
            Effect.as("ran"),
            Effect.catch((e) => Effect.succeed(e.message.includes("read-only") ? "refused" : e.message)),
          )
        return {
          status: yield* run("git", ["status", "--porcelain"]),
          commit: yield* run("git", ["commit", "--allow-empty", "-m", "x"]),
          output: yield* run("git", ["diff", "--output=/tmp/x"]),
          config: yield* run("git", ["-c", "core.fsmonitor=touch /tmp/x", "status"]),
          shell: yield* run("sh", ["-c", "true"]),
          http: yield* http.get("http://127.0.0.1:9/").pipe(
            Effect.as("sent"),
            Effect.orElseSucceed(() => "refused"),
          ),
        }
      }).pipe(Effect.scoped, Effect.provide(readOnlyOn(Layer.empty, folder, recordingMachine(spawned, requests))))
      assert.deepStrictEqual(results, { status: "ran", commit: "refused", output: "refused", config: "refused", shell: "refused", http: "refused" })
      assert.deepStrictEqual(
        (yield* Ref.get(spawned)).map((s) => ({ command: s.command, args: s.args, locks: s.locks })),
        [{ command: "git", args: ["status", "--porcelain"], locks: "0" }],
      )
      assert.deepStrictEqual(yield* Ref.get(requests), [])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})
