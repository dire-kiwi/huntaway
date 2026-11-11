import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import { Context, DateTime, Effect, Layer, PubSub, Ref, Schema, Stream } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { SqlClient, SqlSchema } from "effect/sql"
import { createServer } from "node:http"
import { Auth, type BoardEvent, BoardRpcs, Session, Task, TaskId, TaskNotFound, Unauthorized, type Status } from "./contracts.ts"

export const migrations = SqliteMigrator.fromRecord({
    "0001_tasks": Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL)`
    })
})

const SqlLive = SqliteMigrator.layer({ loader: migrations }).pipe(
  Layer.provideMerge(SqliteClient.layer({ filename: process.env.DB ?? ":memory:" }))
)

export class Events extends Context.Service<Events, {
  publish(make: (seq: number) => BoardEvent): Effect.Effect<void>
  readonly subscribe: Stream.Stream<BoardEvent>
}>()("huntaway/Events") {
  static readonly layer = Layer.effect(Events, Effect.gen(function*() {
    const pubsub = yield* PubSub.unbounded<BoardEvent>()
    const seq = yield* Ref.make(0)
    return Events.of({
      publish: (make) => Ref.updateAndGet(seq, (n) => n + 1).pipe(Effect.flatMap((n) => PubSub.publish(pubsub, make(n))), Effect.asVoid),
      subscribe: Stream.fromPubSub(pubsub)
    })
  }))
}

const TaskRow = Schema.Struct({ id: TaskId, title: Schema.String, status: Task.fields.status, created_at: Schema.Number })

export class Tasks extends Context.Service<Tasks, {
  get(id: TaskId): Effect.Effect<Task, TaskNotFound>
  create(title: string): Effect.Effect<Task>
  setStatus(id: TaskId, status: Status): Effect.Effect<Task, TaskNotFound>
}>()("huntaway/Tasks") {
  static readonly layer = Layer.effect(Tasks, Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const events = yield* Events
    const toTask = (r: typeof TaskRow.Type) => new Task({ id: r.id, title: r.title, status: r.status, createdAt: DateTime.makeUnsafe(r.created_at) })
    const find = SqlSchema.findOneOption({
      Request: TaskId,
      Result: TaskRow,
      execute: (id) => sql`SELECT * FROM tasks WHERE id = ${id}`
    })
    const get = Effect.fn("Tasks.get")(function*(id: TaskId) {
      const row = yield* find(id).pipe(Effect.orDie)
      if (row._tag === "None") return yield* new TaskNotFound({ id })
      return toTask(row.value)
    })
    const create = Effect.fn("Tasks.create")(function*(title: string) {
      const now = yield* DateTime.now
      const task = new Task({ id: TaskId.make(crypto.randomUUID()), title, status: "todo", createdAt: now })
      yield* sql`INSERT INTO tasks ${sql.insert({ id: task.id, title, status: task.status, created_at: DateTime.toEpochMillis(now) })}`.pipe(Effect.orDie)
      yield* events.publish((seq) => ({ _tag: "TaskUpserted", seq, task }))
      return task
    })
    const setStatus = Effect.fn("Tasks.setStatus")(function*(id: TaskId, status: Status) {
      const task = yield* sql.withTransaction(Effect.gen(function*() {
        const t = yield* get(id)
        yield* sql`UPDATE tasks SET status = ${status} WHERE id = ${id}`
        return new Task({ ...t, status })
      })).pipe(Effect.catchTag("SqlError", Effect.die))
      yield* events.publish((seq) => ({ _tag: "TaskUpserted", seq, task }))
      return task
    })
    return Tasks.of({ get, create, setStatus })
  }))
}

const AuthLive = Layer.succeed(Auth, Auth.of((effect, { headers }) =>
  headers["authorization"] === "Bearer dev-token"
    ? Effect.provideService(effect, Session, { device: "spike" })
    : Effect.fail(new Unauthorized())
))

export const Handlers = BoardRpcs.toLayer(Effect.gen(function*() {
  const tasks = yield* Tasks
  const events = yield* Events
  return BoardRpcs.of({
    "tasks.get": ({ id }) => tasks.get(id),
    "tasks.create": ({ title }) => tasks.create(title),
    "tasks.setStatus": ({ id, status }) => tasks.setStatus(id, status),
    "board.subscribe": () => events.subscribe
  })
}))

const Rpcs = Layer.mergeAll(
  RpcServer.layerHttp({ group: BoardRpcs, path: "/ws", protocol: "websocket" }),
  RpcServer.layerHttp({ group: BoardRpcs, path: "/rpc", protocol: "http" })
).pipe(Layer.provide(Handlers), Layer.provide(AuthLive), Layer.provide(RpcSerialization.layerNdjson))

const Health = HttpRouter.use(Effect.fn(function*(router) {
  yield* router.add("GET", "/health", Effect.succeed(HttpServerResponse.text("ok")))
}))

export const Main = HttpRouter.serve(Layer.mergeAll(Rpcs, Health)).pipe(
  Layer.provide(Tasks.layer),
  Layer.provide(Events.layer),
  Layer.provide(SqlLive),
  Layer.provide(NodeHttpServer.layer(createServer, { port: Number(process.env.PORT ?? 0), host: "127.0.0.1" }))
)

if (import.meta.main) NodeRuntime.runMain(Layer.launch(Main))
