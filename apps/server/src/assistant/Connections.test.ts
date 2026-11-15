import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Result, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { TaskId, Timestamp } from "@huntaway/contracts"
import type { Profile, Task } from "@huntaway/contracts"
import { fakeAgent, TestMcp } from "@huntaway/testing"
import type { FakeAgent } from "@huntaway/testing"
import { AgentTools } from "../agents/AgentTools.ts"
import { NOT_THE_ASSISTANT } from "../mcp/tools/connections.ts"
import { agentOf, agentOn, call, err, ok, profile, project, task } from "../mcp/tools/tests/board.ts"
import { Questions, SETTLED } from "../permissions/Questions.ts"
import { RunRepo } from "../runs/RunRepo.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { Threads } from "../threads/Threads.ts"
import { Connections } from "./Connections.ts"
import { alreadyConnected, ASKED, connectedResolution, connectedText, movedOnResolution, skippedResolution, skippedText, unattended } from "./connectionText.ts"
import { Google } from "./Google.ts"
import { CLIENT_SECRET_ENV, CREDENTIALS_ENV, SCOPES, SERVER, serverConfig } from "./googleText.ts"

// The assistant's connection cards (HE-28): `request_connection` with the fake agent, over a Google state of the test's
// own (a server pointed at a temp folder, its files written there, a token endpoint on 127.0.0.1 that takes refresh
// token "good" only), and how a card settles: Check again, Skip, the board's sweep, a reply in the thread.

const encodeJson = Schema.encodeResult(Schema.fromJsonString(Schema.Unknown))
const json = (v: unknown): string => Result.getOrElse(encodeJson(v), () => "")

const CLIENT = '{"installed": {"client_id": "id.apps.googleusercontent.com", "client_secret": "shh"}}'

/** A token endpoint of the test's own: it takes refresh token "good" only. Its URL, and how many requests it has had. */
const tokenEndpoint = Effect.gen(function* () {
  let asked = 0
  const server = createServer((req, res) => {
    asked += 1
    let body = ""
    req.on("data", (c: Buffer) => (body += c.toString()))
    req.on("end", () => {
      const good = new URLSearchParams(body).get("refresh_token") === "good"
      res.writeHead(good ? 200 : 400, { "content-type": "application/json" })
      res.end(good ? '{"access_token": "at", "expires_in": 3599}' : '{"error": "invalid_grant", "error_description": "Token has been expired or revoked."}')
    })
  })
  yield* Effect.callback<void>((resume) => {
    server.listen(0, "127.0.0.1", () => resume(Effect.void))
  })
  yield* Effect.addFinalizer(() => Effect.sync(() => server.close()))
  const address = server.address()
  return { uri: `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}/token`, asked: () => asked }
})

/** The profile's Google, set up step by step in a folder of the test's own. */
const stubGoogle = (p: Profile) =>
  Effect.gen(function* () {
    const dir = mkdtempSync(`${tmpdir()}/huntaway-connections-`)
    const { uri, asked } = yield* tokenEndpoint
    const bin = `${dir}/uvx`
    writeFileSync(bin, "#!/bin/sh\n")
    chmodSync(bin, 0o755)
    const base = serverConfig("/home/nobody", null)
    const config = { ...base, command: bin, env: { ...base.env, [CLIENT_SECRET_ENV]: `${dir}/client_secret.json`, [CREDENTIALS_ENV]: `${dir}/credentials` } }
    return {
      /** How many times Google's (the test's) token endpoint has been asked. */
      asked,
      /** The server added, switched on, and its OAuth client there: not signed in yet. */
      server: Effect.gen(function* () {
        yield* (yield* Google).setup(p.id)
        const tools = yield* AgentTools
        const id = (yield* tools.global).mcp_servers.find((s) => s.name === SERVER)?.id ?? assert.fail("no google server")
        yield* tools.updateServer(null, id, { config }).pipe(Effect.orDie)
        writeFileSync(`${dir}/client_secret.json`, CLIENT)
        chmodSync(`${dir}/client_secret.json`, 0o600)
      }),
      /** Signed in as sam@example.com, with refresh token `refresh` ("good" is taken). */
      signIn: (refresh: string) =>
        Effect.sync(() => {
          mkdirSync(`${dir}/credentials`, { recursive: true })
          const file = `${dir}/credentials/sam@example.com.json`
          writeFileSync(
            file,
            json({ token: "at", refresh_token: refresh, token_uri: uri, client_id: "id", client_secret: "shh", scopes: SCOPES, expiry: null }),
          )
          chmodSync(file, 0o600)
        }),
    }
  })

const requests = (t: TaskId) =>
  Effect.map(
    Effect.flatMap(Threads, (threads) => threads.stored(t)),
    (s) => s.requests,
  )

/** The agent asks for Google; what it was told, and the card's request id. */
const askGoogle = (agent: FakeAgent, id?: string) =>
  Effect.gen(function* () {
    const told = ok(yield* call(agent, "request_connection", { connection: "google", reason: "To find the flight confirmation in your mail" }, id))
    return { told, card: (yield* requests(agent.run.task_id)).at(-1)?.id ?? "" }
  })

/** Whether the task was sent `text`: steered into its run, or queued for after it. */
const sent = (t: Task, text: string) => t.steering.some((s) => s.text === text) || t.queued_message === text
const taskOf = (id: TaskId) => Effect.flatMap(TaskRepo, (r) => r.get(id)).pipe(Effect.map((t) => t ?? assert.fail("no task")))

const failure = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) => Effect.map(Effect.flip(effect), (e) => e._tag)

describe("request_connection", () => {
  it.effect("puts up a card for what's missing; Check again settles it once Google is connected, and the agent carries on", () =>
    Effect.gen(function* () {
      const p = yield* profile("personal")
      const google = yield* stubGoogle(p)
      const me = yield* agentOf(p)
      const thread = me.run.task_id
      const connections = yield* Connections

      const { told, card } = yield* askGoogle(me, "c1")
      assert.deepStrictEqual([told["ok"], told["connected"], told["note"]], [true, false, ASKED])
      assert.include(String(told["problem"]), "no Google server")
      // Once per call: one cut short by a restart and run again makes no second card.
      yield* (yield* SqlClient.SqlClient)`UPDATE mcp_calls SET status = 'executing' WHERE id = 'c1'`.pipe(Effect.orDie)
      ok(yield* call(me, "request_connection", { connection: "google", reason: "To find the flight confirmation in your mail" }, "c1"))
      const [asked] = yield* requests(thread)
      assert.strictEqual((yield* requests(thread)).length, 1)
      assert.deepStrictEqual(
        [asked?.metadata?.["connection"], asked?.metadata?.["reason"], asked?.metadata?.["call_id"], asked?.resolution],
        ["google", "To find the flight confirmation in your mail", "c1", undefined],
      )
      assert.include(String(asked?.metadata?.["problem"]), "no Google server")
      assert.strictEqual((yield* me.row).attention, "Connect Google")
      // It isn't answered as a question is.
      assert.strictEqual(yield* failure((yield* Questions).answer(thread, card, { choices: ["Skip"] })), "QuestionNotFound")

      // Check again: not yet, and the card stays open with what's missing now.
      yield* google.server
      let now = yield* connections.check(thread, card)
      assert.deepStrictEqual([now.connected, now.account], [false, null])
      assert.include(now.problem, "Not signed in to Google yet")
      // A refresh token Google turns away isn't connected.
      yield* google.signIn("revoked")
      now = yield* connections.check(thread, card)
      assert.isFalse(now.connected)
      assert.include(now.problem, "invalid_grant")
      assert.isUndefined((yield* requests(thread))[0]?.resolution)

      // Signed in: connected as the account, the card settles, and the agent is told to carry on.
      yield* google.signIn("good")
      now = yield* connections.check(thread, card)
      assert.deepStrictEqual(now, { connected: true, account: "sam@example.com", problem: null })
      assert.deepStrictEqual((yield* requests(thread))[0]?.resolution, connectedResolution("sam@example.com"))
      assert.isTrue(sent(yield* taskOf(thread), connectedText("google", "sam@example.com")))
      // An answer counts once.
      assert.strictEqual(yield* failure(connections.check(thread, card)), "QuestionClosed")
      assert.strictEqual(yield* failure(connections.skip(thread, card)), "QuestionClosed")

      // Asked again once it's there: no card.
      const again = ok(yield* call(me, "request_connection", { connection: "google", reason: "To read today's mail" }))
      assert.deepStrictEqual(again, { ok: true, connected: true, account: "sam@example.com", note: alreadyConnected("google", "sam@example.com") })
      assert.strictEqual((yield* requests(thread)).length, 1)
    }).pipe(Effect.scoped, Effect.provide(TestMcp())),
  )

  it.effect("Skip carries on without it, a reply settles it, and the board notices a connection on its own", () =>
    Effect.gen(function* () {
      const p = yield* profile("personal")
      const google = yield* stubGoogle(p)
      const me = yield* agentOf(p)
      const thread = me.run.task_id
      const connections = yield* Connections

      // Skip.
      let { card } = yield* askGoogle(me)
      const skipped = yield* connections.skip(thread, card)
      assert.isTrue(sent(skipped, skippedText("google")))
      assert.deepStrictEqual((yield* requests(thread)).at(-1)?.resolution, skippedResolution)

      // A message from the user settles it, as for questions.
      ;({ card } = yield* askGoogle(me))
      yield* (yield* Questions).settle(thread, "replied")
      assert.deepStrictEqual((yield* requests(thread)).at(-1)?.resolution, { outcome: "cancel", message: SETTLED.replied })
      assert.strictEqual(yield* failure(connections.check(thread, card)), "QuestionClosed")

      // The sweep: nothing while it isn't connected; once it is, the card settles and the agent carries on; then nothing.
      ;({ card } = yield* askGoogle(me))
      assert.strictEqual(yield* connections.sweep, 0)
      yield* google.server
      yield* google.signIn("good")
      assert.strictEqual(yield* connections.sweep, 1)
      assert.deepStrictEqual((yield* requests(thread)).at(-1)?.resolution, connectedResolution("sam@example.com"))
      assert.isTrue(sent(yield* taskOf(thread), connectedText("google", "sam@example.com")))
      assert.strictEqual(yield* connections.sweep, 0)
      assert.strictEqual(yield* failure(connections.check(thread, "legacy:999999")), "QuestionNotFound")

      // A card the conversation moved past without settling it (a routine's message, which doesn't settle questions) is
      // closed by the sweep, unanswered and without asking Google, and isn't read again.
      yield* google.signIn("revoked")
      yield* askGoogle(me)
      yield* (yield* Threads).userMessage(thread, "the daily check", { routine: true })
      yield* google.signIn("good")
      const before = google.asked()
      assert.strictEqual(yield* connections.sweep, 0)
      assert.deepStrictEqual((yield* requests(thread)).at(-1)?.resolution, movedOnResolution)
      assert.strictEqual(yield* connections.sweep, 0)
      assert.strictEqual(google.asked(), before)
    }).pipe(Effect.scoped, Effect.provide(TestMcp())),
  )

  it.effect("is the assistant's and its routines'; a routine's run gets no card, and is told to report it", () =>
    Effect.gen(function* () {
      const p = yield* profile("personal")
      const ha = yield* project(p, "huntaway", "HA")
      const a = yield* agentOf(p)
      // A project's agent can't.
      const worker = yield* agentOn(yield* task(ha, "Worker"))
      assert.strictEqual(err(yield* call(worker, "request_connection", { connection: "google", reason: "x" })), NOT_THE_ASSISTANT)
      assert.include(err(yield* call(a, "request_connection", { connection: "slack", reason: "x" })), "schema")
      assert.strictEqual(err(yield* call(a, "request_connection", { connection: "google", reason: " " })), "request_connection needs a reason")

      // A routine's thread, in a turn a routine started.
      const AT = Timestamp.make("2026-11-12T00:00:00.000Z")
      const routine = TaskId.make("routine-1")
      yield* (yield* SqlClient.SqlClient)`INSERT INTO tasks (id, profile_id, parent_id, title, status, task_type, kind, number, last_activity_at, created_at, updated_at)
        VALUES (${routine}, ${p.id}, ${a.run.task_id}, 'Inbox', 'todo', 'routine', 'task', 2, ${AT}, ${AT}, ${AT})`.pipe(Effect.orDie)
      const r = yield* fakeAgent({ task: routine })
      const n = yield* (yield* Threads).userMessage(routine, "check the mail", { routine: true })
      yield* (yield* RunRepo).update(r.run.id, { write_no: n })
      const told = ok(yield* call(r, "request_connection", { connection: "google", reason: "To read the mail" }))
      assert.deepStrictEqual([told["ok"], told["connected"]], [false, false])
      assert.strictEqual(told["note"], unattended("google", typeof told["problem"] === "string" ? told["problem"] : null))
      assert.include(String(told["note"]), "say in your report")
      assert.deepStrictEqual(yield* requests(routine), [])
      assert.isNull((yield* r.row).attention)
      // The same thread in a turn of the user's own gets its card.
      const m = yield* (yield* Threads).userMessage(routine, "and now?", {})
      yield* (yield* RunRepo).update(r.run.id, { write_no: m })
      assert.strictEqual(ok(yield* call(r, "request_connection", { connection: "google", reason: "To read the mail" }))["note"], ASKED)
      assert.strictEqual((yield* requests(routine)).length, 1)
    }).pipe(Effect.provide(TestMcp())),
  )
})
