import { Effect, Predicate } from "effect"
import { toJson } from "../../../platform/columns.ts"
import { field, strField } from "../items.ts"
import type { AppServer, Incoming } from "../rpc.ts"

// The adapter's side of the app-server's requests (huntaway's agent/codex/adapter.ts `Requests`, `decline` and
// `ChildThreads`): with the board to answer them (`CodexSpec.requests_on_output` and input), each is written to the run's
// output as it is (with the item it's about, which an approval only names, as `item`), and its answer comes back on the
// input as a `codex_response` line, which is passed on. One the app-server stops waiting for (`serverRequest/resolved`:
// the turn was interrupted, say) is told to the board, unless the board answered it already. Without the board (a
// compaction, which takes no input), requests are declined here. All of it runs in the adapter's one loop.

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> => Predicate.isObject(v) && !Array.isArray(v)

/** A line of output, written whole. */
export type Emit = (value: unknown) => Effect.Effect<void>

/** A request answered with no board to ask: approvals are declined, questions unanswered, the board's tools unavailable. */
export const decline = (server: AppServer, msg: Incoming): Effect.Effect<void> => {
  const id = msg["id"] ?? null
  const method = strField(msg, "method") ?? ""
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return server.respond(id, { decision: "decline" })
    case "item/permissions/requestApproval":
      return server.respond(id, { permissions: {}, scope: "turn" })
    case "mcpServer/elicitation/request":
      return server.respond(id, { action: "decline" })
    case "item/tool/requestUserInput":
      return server.respond(id, { answers: {} })
    case "item/tool/call":
      return server.respond(id, {
        contentItems: [{ type: "inputText", text: `The board's ${strField(field(msg, "params"), "tool") ?? ""} tool isn't available in this run.` }],
        success: false,
      })
    default:
      return server.respondError(id, `Method not supported by Huntaway: ${method}`)
  }
}

/** A `codex_response` line of the run's input: the board's answer to request `id`. */
export interface Answer {
  readonly id: unknown
  readonly result?: unknown
  readonly error?: unknown
}

/** The app-server's requests the board hasn't answered yet; `board` says whether the board answers them. */
export const makeRequests = (server: AppServer, emit: Emit, board: boolean) => {
  const open = new Map<string, Incoming>()
  let answers = board
  return {
    /** Request `msg`, about `item` (null if it names none the adapter has seen). */
    asked: (msg: Incoming, item: unknown): Effect.Effect<void> =>
      Effect.suspend(() =>
        answers
          ? Effect.gen(function* () {
              open.set(yield* toJson(msg["id"] ?? null), msg)
              yield* emit(item !== null ? { ...msg, item } : msg)
            })
          : decline(server, msg),
      ),
    /** The board can't answer any more (the run's input ended): what it hasn't answered is declined. */
    closed: (): Effect.Effect<void> =>
      Effect.suspend(() => {
        answers = false
        const left = [...open.values()]
        open.clear()
        return Effect.forEach(left, (msg) => decline(server, msg), { concurrency: 1, discard: true })
      }),
    /** The board's answer to request `r.id`, passed on unless it answers none still open. */
    answered: (r: Answer): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (!open.delete(yield* toJson(r.id ?? null))) return
        if (r.error !== undefined) {
          const message = isRecord(r.error) && typeof r.error["message"] === "string" ? r.error["message"] : "the board couldn't answer this"
          yield* server.respondError(r.id, message)
        } else yield* server.respond(r.id, r.result ?? null)
      }),
    /** `serverRequest/resolved`: told to the board if it was still waiting for its answer. */
    resolved: (msg: Incoming): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (open.delete(yield* toJson(field(field(msg, "params"), "requestId")))) yield* emit(msg)
      }),
  }
}

/**
 * Killing the app-server stops its children too, but it can't report their closure after it exits. Their closure is
 * kept in the transcript so old children stay stopped on the next run.
 */
export class ChildThreads {
  private readonly ids = new Set<string>()
  private dropped = false
  private readonly main: string

  constructor(main: string) {
    this.main = main
  }

  observe(msg: Incoming): void {
    const p = field(msg, "params")
    const item = field(p, "item")
    const ids = [strField(p, "threadId"), strField(field(p, "thread"), "id"), strField(item, "agentThreadId")]
    const receivers = field(item, "receiverThreadIds")
    if (Array.isArray(receivers)) for (const r of receivers) ids.push(typeof r === "string" ? r : null)
    for (const id of ids) if (id !== null && id !== this.main) this.ids.add(id)
    if (msg["method"] === "thread/closed") {
      const id = strField(p, "threadId")
      if (id !== null) this.ids.delete(id)
    }
  }

  /** The adapter is done: each child still open is reported closed, once. */
  drop(emit: Emit): Effect.Effect<void> {
    if (this.dropped) return Effect.void
    this.dropped = true
    const ids = [...this.ids].toSorted()
    return Effect.forEach(ids, (id) => emit({ method: "thread/closed", params: { threadId: id } }), { concurrency: 1, discard: true })
  }
}
