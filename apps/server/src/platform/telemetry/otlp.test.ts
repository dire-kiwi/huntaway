import { NodeHttpServer } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/http"
import { SqlClient } from "effect/sql"
import { RunId } from "@huntaway/contracts"
import { fakeClickHouse, TestPlatform } from "@huntaway/testing"
import { OtlpRoute } from "../../http/otlp.ts"
import { Identity } from "../Identity.ts"
import { Telemetry } from "../Telemetry.ts"
import { mapRequest } from "./otlp.ts"

// The agents' own OpenTelemetry (the old telemetry.test.ts's cases): how their records map onto `agent_events`, without
// who they are or what their tools saw, and the receiver, which takes a run's events only with its own secret.

const NOW = "2026-11-08T10:00:00.000Z"
const AT = NOW

const kv = (o: Record<string, string | number | boolean>) =>
  Object.entries(o).map(([key, v]) => ({
    key,
    value:
      typeof v === "number"
        ? Number.isInteger(v)
          ? { intValue: String(v) }
          : { doubleValue: v }
        : typeof v === "boolean"
          ? { boolValue: v }
          : { stringValue: v },
  }))

/** An ExportLogsServiceRequest as Claude Code sends one. */
const claudeRequest = () => ({
  resourceLogs: [
    {
      resource: { attributes: kv({ "service.name": "claude-code", "service.version": "2.1.300", "host.name": "laptop" }) },
      scopeLogs: [
        {
          logRecords: [
            {
              timeUnixNano: "1762596000000000000",
              body: { stringValue: "claude_code.api_request" },
              attributes: kv({
                "event.name": "api_request",
                "event.timestamp": "2026-11-08T10:00:00.000Z",
                "session.id": "sess-1",
                "prompt.id": "prompt-1",
                "user.email": "me@example.com",
                "user.account_uuid": "acct",
                "organization.id": "org",
                model: "claude-opus-5-5",
                cost_usd: 0.25,
                duration_ms: 1200,
                input_tokens: 10,
                output_tokens: 20,
                cache_read_tokens: 300,
                cache_creation_tokens: 40,
                request_id: "req_1",
              }),
            },
            {
              body: { stringValue: "claude_code.tool_result" },
              attributes: kv({ "event.name": "tool_result", tool_name: "Bash", success: "false", duration_ms: 50, error: "rm: /home/me/secret: denied" }),
            },
            { body: { stringValue: "claude_code.user_prompt" }, attributes: kv({ "event.name": "user_prompt", prompt_length: 12, prompt: "my secret" }) },
          ],
        },
      ],
    },
  ],
})

/** One as Codex sends one. */
const codexRequest = () => ({
  resourceLogs: [
    {
      resource: { attributes: kv({ "service.name": "codex_app_server", "service.version": "0.200.0" }) },
      scopeLogs: [
        {
          logRecords: [
            {
              attributes: kv({
                "event.name": "codex.tool_result",
                "conversation.id": "conv-1",
                "user.email": "me@example.com",
                "user.account_id": "acct",
                tool_name: "shell",
                arguments: "cat ~/.ssh/id_rsa",
                output: "-----BEGIN",
                success: "true",
                duration_ms: 7,
              }),
            },
            {
              attributes: kv({
                "event.name": "codex.sse_event",
                "conversation.id": "conv-1",
                "event.kind": "response.completed",
                model: "gpt-5.5",
                input_token_count: 100,
                output_token_count: 5,
                cached_token_count: 80,
                reasoning_token_count: 2,
              }),
            },
          ],
        },
      ],
    },
  ],
})

const Json = Schema.fromJsonString(Schema.Unknown)
const text = (v: unknown) => Option.getOrElse(Schema.encodeOption(Json)(v), () => "")

describe("the agents' OpenTelemetry", () => {
  it("their events map onto columns, without who they are or what their tools saw", () => {
    const rows = mapRequest(claudeRequest(), NOW)
    assert.strictEqual(rows.length, 3)
    const [api, tool, prompt] = rows
    assert.strictEqual(api?.["event"], "api_request")
    assert.strictEqual(api?.["runtime"], "claude")
    assert.strictEqual(api?.["agent_version"], "2.1.300")
    assert.strictEqual(api?.["session_id"], "sess-1")
    assert.strictEqual(api?.["prompt_id"], "prompt-1")
    assert.strictEqual(api?.["model"], "claude-opus-5-5")
    assert.strictEqual(api?.["cost_usd"], 0.25)
    assert.strictEqual(api?.["cache_write_tokens"], 40)
    assert.deepStrictEqual(api?.["attrs"], { request_id: "req_1" })
    assert.strictEqual(tool?.["tool"], "Bash")
    assert.strictEqual(tool?.["success"], 0)
    assert.strictEqual(tool?.["error"], "", "a tool's error can say what it ran")
    assert.deepStrictEqual(prompt?.["attrs"], { prompt_length: 12 })
    const all = text(rows)
    for (const secret of ["me@example.com", "acct", "org", "laptop", "my secret", "/home/me/secret"]) assert.notInclude(all, secret, secret)

    const codex = mapRequest(codexRequest(), NOW)
    assert.strictEqual(codex.length, 2)
    assert.strictEqual(codex[0]?.["event"], "tool_result")
    assert.strictEqual(codex[0]?.["runtime"], "codex")
    assert.strictEqual(codex[0]?.["session_id"], "conv-1")
    assert.strictEqual(codex[0]?.["success"], 1)
    assert.strictEqual(codex[0]?.["ts"], NOW, "no time of its own: now")
    assert.strictEqual(codex[1]?.["input_tokens"], 100)
    assert.strictEqual(codex[1]?.["cache_read_tokens"], 80)
    assert.strictEqual(codex[1]?.["reasoning_tokens"], 2)
    assert.deepStrictEqual(codex[1]?.["attrs"], { "event.kind": "response.completed" })
    const cAll = text(codex)
    for (const secret of ["me@example.com", "acct", "id_rsa", "BEGIN"]) assert.notInclude(cAll, secret, secret)
    assert.deepStrictEqual(mapRequest({ nonsense: true }, NOW), [])
  })

  const served = HttpRouter.serve(OtlpRoute, { disableListenLog: true, disableLogger: true }).pipe(
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provideMerge(TestPlatform()),
  )

  it.effect("the receiver takes a run's events only with its own secret", () =>
    Effect.gen(function* () {
      const f = yield* fakeClickHouse
      const sql = yield* SqlClient.SqlClient
      const telemetry = yield* Telemetry
      const identity = yield* Identity
      const client = yield* HttpClient.HttpClient
      yield* sql`INSERT INTO profiles (id, name, created_at, telemetry, telemetry_titles) VALUES ('p', 'personal', ${AT}, 1, 1)`
      yield* sql`INSERT INTO profiles (id, name, created_at) VALUES ('w', 'work', ${AT})`
      yield* sql`INSERT INTO projects (id, profile_id, name, key, repo_path, scratch_path, worktrees_root, created_at)
        VALUES ('proj', 'p', 'Huntaway', 'HA', '/tmp/x', '/tmp/x', '/tmp/x', ${AT})`
      yield* sql`INSERT INTO tasks (id, profile_id, project_id, number, title, status, last_activity_at, created_at, updated_at)
        VALUES ('t', 'p', 'proj', 1, 'Secret plans', 'todo', ${AT}, ${AT}, ${AT})`
      yield* sql`INSERT INTO tasks (id, profile_id, title, status, last_activity_at, created_at, updated_at) VALUES ('wt', 'w', 'Work', 'todo', ${AT}, ${AT}, ${AT})`
      for (const [id, task] of [
        ["run", "t"],
        ["other", "t"],
        ["work-run", "wt"],
      ] as const) {
        yield* sql`INSERT INTO runs (id, task_id, status, created_at) VALUES (${id}, ${task}, 'running', ${AT})`
      }
      yield* telemetry.update({ url: f.url })
      const post = (run: string, secret: string, body: unknown, headers: Record<string, string> = {}) =>
        client
          .execute(
            HttpClientRequest.post(`/api/otlp/${run}/v1/logs`).pipe(
              HttpClientRequest.bodyText(text(body), headers["content-type"] ?? "application/json"),
              HttpClientRequest.setHeaders({ authorization: `Bearer ${secret}` }),
            ),
          )
          .pipe(Effect.orDie)
      const secret = (run: string) => identity.runSecret(RunId.make(run))
      const agentRows = sql<{ readonly row: string }>`SELECT row FROM telemetry_outbox WHERE target = 'agent_events' ORDER BY id`
      assert.strictEqual((yield* post("run", yield* secret("other"), claudeRequest())).status, 401, "another run's secret")
      assert.strictEqual((yield* post("run", "test-token", claudeRequest())).status, 401, "the host's token")
      assert.strictEqual((yield* post("run", yield* secret("run"), claudeRequest(), { "content-type": "application/x-protobuf" })).status, 415, "JSON only")
      const ok = yield* post("run", yield* secret("run"), claudeRequest())
      assert.strictEqual(ok.status, 200)
      assert.deepStrictEqual(yield* ok.json.pipe(Effect.orDie), {})
      let rows = yield* agentRows
      assert.strictEqual(rows.length, 3)
      assert.include(rows[0]?.row ?? "", '"run_id":"run"')
      assert.include(rows[0]?.row ?? "", '"task_key":"HA-1"')
      // A run of a profile that doesn't send: taken, and dropped.
      assert.strictEqual((yield* post("work-run", yield* secret("work-run"), claudeRequest())).status, 200)
      // Metrics and traces: taken, and dropped, so the agent doesn't retry.
      const metrics = yield* client
        .execute(
          HttpClientRequest.post("/api/otlp/run/v1/metrics").pipe(
            HttpClientRequest.setHeaders({ "content-type": "application/json", authorization: `Bearer ${yield* secret("run")}` }),
            HttpClientRequest.bodyText("{}", "application/json"),
          ),
        )
        .pipe(Effect.orDie)
      assert.strictEqual(metrics.status, 200)
      rows = yield* agentRows
      assert.strictEqual(rows.length, 3)
    }).pipe(Effect.scoped, Effect.provide(served)),
  )
})
