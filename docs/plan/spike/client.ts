import { Effect, Fiber, Layer, Stream } from "effect"
import { Headers } from "effect/http"
import { RpcClient, RpcMiddleware, RpcSerialization } from "effect/rpc"
import { Socket } from "effect/socket"
import { Auth, BoardRpcs } from "./contracts.ts"

const AuthClient = RpcMiddleware.layerClient(Auth, ({ next, request }) =>
  next({ ...request, headers: Headers.set(request.headers, "authorization", `Bearer ${process.env.TOKEN ?? "dev-token"}`) }))

const Protocol = RpcClient.layerProtocolSocket({ retryTransientErrors: true }).pipe(
  Layer.provide(Socket.layerWebSocket(`ws://127.0.0.1:${process.env.PORT}/ws`)),
  Layer.provide(Socket.layerWebSocketConstructorGlobal),
  Layer.provide(RpcSerialization.layerNdjson)
)

const program = Effect.gen(function*() {
  const client = yield* RpcClient.make(BoardRpcs)
  const sub = yield* client["board.subscribe"]({}).pipe(Stream.take(2), Stream.runCollect, Effect.forkChild)
  yield* Effect.sleep("100 millis")
  const t = yield* client["tasks.create"]({ title: "hello" })
  const t2 = yield* client["tasks.setStatus"]({ id: t.id, status: "done" })
  const events = yield* Fiber.join(sub)
  console.log("task", t2.status, t2.createdAt.toString())
  console.log("events", events.map((e) => `${e._tag}#${e.seq}`).join(","))
  const missing = yield* client["tasks.get"]({ id: "nope" as typeof t.id }).pipe(Effect.catchTag("TaskNotFound", (e) => Effect.succeed(`not found: ${e.id}`)))
  console.log(missing)
}).pipe(Effect.scoped, Effect.provide(Protocol), Effect.provide(AuthClient))

Effect.runPromise(program).then(() => process.exit(0), (e) => { console.error("FAILED", e); process.exit(1) })
