import { RegistryProvider, useAtomSet, useAtomValue } from "@effect/atom-react"
import { Effect, Layer, Stream } from "effect"
import { Headers } from "effect/http"
import { AsyncResult, Atom, AtomRpc } from "effect/reactivity"
import { RpcClient, RpcMiddleware, RpcSerialization } from "effect/rpc"
import { Socket } from "effect/socket"
import { Auth, type BoardEvent, BoardRpcs, type Task, type TaskId } from "./contracts.ts"

// which board (host) the page talks to, and its token: plain writable atoms
export const boardUrlAtom = Atom.make("ws://127.0.0.1:7878/ws")
export const tokenAtom = Atom.make("dev-token")

export class BoardClient extends AtomRpc.Service<BoardClient>()("huntaway/BoardClient", {
  group: BoardRpcs,
  protocol: (get) =>
    RpcClient.layerProtocolSocket({ retryTransientErrors: true }).pipe(
      Layer.provide(Socket.layerWebSocket(get(boardUrlAtom))),
      Layer.provide(Socket.layerWebSocketConstructorGlobal),
      Layer.provide(RpcSerialization.layerNdjson),
      Layer.merge(RpcMiddleware.layerClient(Auth, ({ next, request }) =>
        next({ ...request, headers: Headers.set(request.headers, "authorization", `Bearer ${get(tokenAtom)}`) })))
    )
}) {}

// the board's read model: a fold of the event stream, kept alive for the whole page
type Board = { readonly tasks: ReadonlyMap<TaskId, Task>; readonly seq: number }
const empty: Board = { tasks: new Map(), seq: 0 }
const apply = (b: Board, e: BoardEvent): Board => {
  const tasks = new Map(b.tasks)
  if (e._tag === "TaskUpserted") tasks.set(e.task.id, e.task)
  else tasks.delete(e.id)
  return { tasks, seq: e.seq }
}
export const boardAtom = BoardClient.runtime.atom(
  Stream.unwrap(Effect.gen(function*() {
    const client = yield* BoardClient
    return client("board.subscribe", {})
  })).pipe(Stream.scan(() => empty, apply)),
  { initialValue: empty }
).pipe(Atom.keepAlive)

// derived, per-entity atoms: a component re-renders only when its task changes
export const taskAtom = Atom.family((id: TaskId) =>
  Atom.make((get) => AsyncResult.getOrElse(get(boardAtom), () => empty).tasks.get(id)))

// queries and mutations straight from the contract
export const taskQuery = (id: TaskId) => BoardClient.query("tasks.get", { id })
export const setStatus = BoardClient.mutation("tasks.setStatus")

export function TaskCard({ id }: { id: TaskId }) {
  const task = useAtomValue(taskAtom(id))
  const move = useAtomSet(setStatus)
  if (!task) return null
  return <button onClick={() => move({ payload: { id, status: "done" } })}>{task.title}: {task.status}</button>
}

export function App({ children }: { children: React.ReactNode }) {
  return <RegistryProvider>{children}</RegistryProvider>
}
