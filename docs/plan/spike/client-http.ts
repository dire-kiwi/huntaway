import { Effect, Layer, Stream } from "effect"
import { FetchHttpClient, Headers } from "effect/http"
import { RpcClient, RpcMiddleware, RpcSerialization } from "effect/rpc"
import { Auth, BoardRpcs } from "./contracts.ts"

const AuthClient = RpcMiddleware.layerClient(Auth, ({ next, request }) =>
  next({ ...request, headers: Headers.set(request.headers, "authorization", "Bearer dev-token") }))
const Protocol = RpcClient.layerProtocolHttp({ url: `http://127.0.0.1:${process.env.PORT}/rpc` }).pipe(
  Layer.provide(FetchHttpClient.layer), Layer.provide(RpcSerialization.layerNdjson))
const program = Effect.gen(function*() {
  const client = yield* RpcClient.make(BoardRpcs)
  const t = yield* client["tasks.create"]({ title: "over http" })
  console.log("http task", t.title, t.status)
}).pipe(Effect.scoped, Effect.provide(Protocol), Effect.provide(AuthClient))
Effect.runPromise(program).then(() => process.exit(0), (e) => { console.error("FAILED", e); process.exit(1) })
