import { Context, Effect, FiberSet, Layer, Ref } from "effect"
import type { RunId } from "@huntaway/contracts"
import type { ControlRequestLine } from "../agents/claude/lines.ts"
import { controlResponse } from "../agents/claude/launch.ts"
import type { BoardManifest, ServedServers } from "../agents/claude/launch.ts"
import { toJson } from "../platform/columns.ts"
import type { Run } from "./Run.ts"
import { RunDir } from "./RunDir.ts"

// What a run's agent asks the board on its output (docs/plan/07-agents.md, As built in 2.5; inventory 01, section 5,
// "Claude lines the server reads"): permission prompts (`can_use_tool`) and calls to the board's in-process MCP server
// (`mcp_message`), and their cancellations. The areas that answer them (`permissions/`, `mcp/`) are below `runs/` in the
// dependency order and their layers need `Runs` (a board tool sends a message to a task), so the runs area cannot
// depend on them: they register here when their layer is built, and the line handler hands each request to whoever
// registered for its kind. Likewise what the launch needs of the board's MCP servers: the manifest the `initialize`
// line gives Claude Code, and which of the board's HTTP servers this server serves.

/** The kinds of control request an area may answer. */
export type AgentRequestKind = "can_use_tool" | "mcp_message"

/** A control request from a run's output, decoded (`lines.ts`). */
export type ControlRequest = ControlRequestLine

/** An area's answerer for one kind of request. */
export interface AgentRequestHandler {
  /**
   * A request on `run`'s output. It may be read again after a restart (from the saved offset), and must then find
   * what it did the first time. It is run in the background: it may wait as long as it needs (for the user, say), and
   * answers on the run's input itself (`AgentRequests.respond`).
   */
  readonly handle: (run: Run, request: ControlRequest) => Effect.Effect<void>
  /** A `control_cancel_request`: the agent no longer wants request `requestId` answered. Every handler hears of it. */
  readonly cancel: (run: Run, requestId: string) => Effect.Effect<void>
}

/** What the launch is told of the board's MCP servers. */
export interface BoardServersProvider {
  /** The board server's handshake, for the `initialize` line of a run's input (a review thread's lists the reviewers' tools). */
  readonly manifest: (review: boolean) => Effect.Effect<BoardManifest>
  /** Which of the board's HTTP servers (gh, docs, desktop) this server serves. */
  readonly served: Effect.Effect<ServedServers>
}

/** Until the board's tools are registered: no tools, and no HTTP server but the board's own. */
export const noBoardServers: BoardServersProvider = {
  manifest: () =>
    Effect.succeed({
      initializeResult: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "huntaway", version: "0" } },
      toolsListResult: { tools: [] },
    }),
  served: Effect.succeed({ gh: false, docs: false, desktop: false }),
}

export interface AgentRequestsShape {
  /** An area answers this kind of request from now on (one that registers again replaces itself). */
  readonly register: (kind: AgentRequestKind, handler: AgentRequestHandler) => Effect.Effect<void>
  /** The board's MCP servers are described by `provider` from now on. */
  readonly provideServers: (provider: BoardServersProvider) => Effect.Effect<void>
  /**
   * A control request on `run`'s output: handed to the area registered for its kind, in the background. One nobody
   * answers (no area registered, or a kind the board doesn't handle) is answered with an error at once, so the agent
   * is never left waiting.
   */
  readonly handle: (run: Run, request: ControlRequest) => Effect.Effect<void>
  /** A `control_cancel_request` on `run`'s output. */
  readonly cancel: (run: Run, requestId: string) => Effect.Effect<void>
  /** Answer a request on the run's input (`control_response`). False when the agent takes no input any more. */
  readonly respond: (run: RunId, response: unknown) => Effect.Effect<boolean>
  readonly manifest: (review: boolean) => Effect.Effect<BoardManifest>
  readonly served: Effect.Effect<ServedServers>
}

export class AgentRequests extends Context.Service<AgentRequests, AgentRequestsShape>()("huntaway-server/runs/AgentRequests") {
  static readonly layer = Layer.effect(
    AgentRequests,
    Effect.gen(function* () {
      const dir = yield* RunDir
      const handlers = yield* Ref.make<ReadonlyMap<AgentRequestKind, AgentRequestHandler>>(new Map())
      const servers = yield* Ref.make<BoardServersProvider>(noBoardServers)
      const working = yield* FiberSet.make()

      const respond = Effect.fnUntraced(function* (run: RunId, response: unknown) {
        const sent = yield* dir
          .appendInput(run, yield* controlResponse(response))
          .pipe(Effect.catch((e) => Effect.logWarning(`run=${run} answering the agent: ${e.reason}`).pipe(Effect.as(false))))
        if (!sent) yield* Effect.logWarning(`run=${run} the agent no longer takes input, so a request of its wasn't answered`)
        return sent
      })

      const handle = Effect.fn("AgentRequests.handle")(function* (run: Run, request: ControlRequest) {
        const subtype = request.request.subtype
        const handler = subtype === "can_use_tool" || subtype === "mcp_message" ? (yield* Ref.get(handlers)).get(subtype) : undefined
        if (handler === undefined) {
          const error = `the board doesn't handle ${yield* toJson(subtype)} requests`
          yield* respond(run.id, { subtype: "error", request_id: request.request_id, error })
          return
        }
        yield* FiberSet.run(
          working,
          handler.handle(run, request).pipe(Effect.catchCause((cause) => Effect.logError(`run=${run.id} answering request ${request.request_id}`, cause))),
        )
      })

      return AgentRequests.of({
        register: (kind, handler) =>
          Ref.update(handlers, (all) => {
            const next = new Map(all)
            next.set(kind, handler)
            return next
          }),
        provideServers: (provider) => Ref.set(servers, provider),
        handle,
        cancel: Effect.fn("AgentRequests.cancel")(function* (run: Run, requestId: string) {
          for (const handler of (yield* Ref.get(handlers)).values()) {
            yield* handler.cancel(run, requestId).pipe(Effect.catchCause((cause) => Effect.logError(`run=${run.id} cancelling request ${requestId}`, cause)))
          }
        }),
        respond,
        manifest: (review) => Effect.flatMap(Ref.get(servers), (s) => s.manifest(review)),
        served: Effect.flatMap(Ref.get(servers), (s) => s.served),
      })
    }),
  )
}
