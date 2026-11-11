import { NodeHttpServer, NodeRuntime, NodeServices } from "@effect/platform-node"
import { Context, Effect, Layer, Schema } from "effect"
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/ai"
import { HttpRouter } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { createServer } from "node:http"

class Caller extends Context.Service<Caller, { readonly taskId: string; readonly kind: "task" | "reviewer" }>()("huntaway/mcp/Caller") {}

const GetTask = Tool.make("get_task", {
  description: "Get a bounded overview of a task.",
  parameters: Schema.Struct({ task_id: Schema.String }),
  success: Schema.Struct({ key: Schema.String, caller: Schema.String, git: Schema.String }),
  dependencies: [Caller]
})
const FinishWork = Tool.make("finish_work", { description: "Say the work is done.", success: Schema.String, dependencies: [Caller] })

const TaskTools = Toolkit.make(GetTask)
const WorkerTools = Toolkit.make(FinishWork)

const Auth = McpServer.middleware<{ provides: Caller }>()((effect, { headers }) =>
  Effect.provideService(effect, Caller, { taskId: headers["x-run"] ?? "?", kind: headers["x-kind"] === "reviewer" ? "reviewer" : "task" }))
const NotReviewer = McpServer.visibility(() => Effect.map(Caller, (c) => c.kind !== "reviewer"))

const Registrations = Layer.mergeAll(
  McpServer.toolkit(TaskTools).pipe(
    Layer.provide(Auth.layer),
    Layer.provide(TaskTools.toLayer(Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      return {
        get_task: ({ task_id }) => Effect.gen(function*() {
          const caller = yield* Caller
          const git = yield* spawner.string(ChildProcess.make("git", ["--version"])).pipe(Effect.orDie)
          return { key: task_id, caller: caller.taskId, git: git.trim() }
        })
      }
    })))
  ),
  McpServer.toolkit(WorkerTools).pipe(
    Layer.provide(NotReviewer.combine(Auth).layer),
    Layer.provide(WorkerTools.toLayer({ finish_work: () => Effect.succeed("ok") }))
  )
)

const Mcp = McpServer.layerHttp({ name: "huntaway", version: "0.0.0", path: "/mcp", protocols: [McpProtocol.v2025_06_18], registrations: Registrations })

NodeRuntime.runMain(Layer.launch(HttpRouter.serve(Mcp).pipe(
  Layer.provide(NodeServices.layer),
  Layer.provide(NodeHttpServer.layer(createServer, { port: Number(process.env.PORT), host: "127.0.0.1" }))
)))
