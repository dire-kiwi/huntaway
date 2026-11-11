import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { RpcClient } from "effect/rpc"
import { CliRpcs, httpRpcClientLayer } from "../../src/cli/rpc.ts"
import { socketRpcClientLayer, startServer } from "./launch.ts"

// 6.5: an automation's webhook over HTTP on a whole server (docs/plan/10-testing.md: "a webhook over HTTP"): the route
// takes no board token, answers a delivery once its run is recorded, turns away a wrong token as no such webhook and a
// body over 1 MiB with a 413, and the run it made makes its task.

describe("webhooks over HTTP", () => {
  it.live("a delivery to an automation's URL makes its task; a wrong token or a big body is turned away", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const { port, token } = yield* startServer(["--no-agents"])
      const repo = yield* fs.makeTempDirectoryScoped({ prefix: "huntaway-e2e-repo-" })
      const rpc = yield* RpcClient.make(CliRpcs).pipe(Effect.provide(httpRpcClientLayer(`http://127.0.0.1:${port}`, token)))
      const profile = yield* rpc["profiles.create"]({ profile: { name: "me" } })
      const project = yield* rpc["projects.create"]({ project: { profile_id: profile.id, repo_path: repo, name: "Web" } })
      const a = yield* rpc["automations.create"]({
        project_id: project.id,
        automation: { name: "Triage", trigger: { kind: "webhook" }, action: { kind: "create_task", title: "Issue: {{body.title}}" } },
      })
      assert.isString(a.hook_path)
      const client = yield* HttpClient.HttpClient
      const post = (path: string, body: string) =>
        client
          .execute(HttpClientRequest.post(`http://127.0.0.1:${port}${path}`).pipe(HttpClientRequest.bodyText(body, "application/json")))
          .pipe(Effect.flatMap((r) => Effect.map(r.json, (json) => ({ status: r.status, json }))))

      // No board token: the token in the path is the automation's own.
      const answered = yield* post(a.hook_path ?? "", `{"title": "Login broken"}`)
      assert.strictEqual(answered.status, 202)
      assert.deepInclude(answered.json, { status: "running" })
      assert.strictEqual((yield* post(`${a.hook_path ?? ""}x`, "{}")).status, 404)
      assert.strictEqual((yield* post(a.hook_path ?? "", `{"pad": "${"x".repeat(1 << 20)}"}`)).status, 413)
      // Its run made the task (it goes on by itself after the answer): in the board's snapshot, or an event after it.
      const made = yield* Effect.gen(function* () {
        const watch = yield* RpcClient.make(CliRpcs)
        return yield* watch["board.watch"]({}).pipe(
          Stream.flatMap((m) =>
            Stream.fromIterable(m.type === "snapshot" ? m.tasks : m.type === "task" ? [m.task] : []).pipe(Stream.filter((t) => t.title.startsWith("Issue:"))),
          ),
          Stream.runHead,
        )
      }).pipe(Effect.scoped, Effect.provide(socketRpcClientLayer(port, token)))
      assert.strictEqual(made._tag === "Some" ? made.value.title : null, "Issue: Login broken")
      // One run: the wrong token and the big body made none.
      assert.lengthOf((yield* rpc["automations.runs"]({ id: a.id })).runs, 1)
    }).pipe(Effect.scoped, Effect.provide([NodeServices.layer, FetchHttpClient.layer])),
  )
})
