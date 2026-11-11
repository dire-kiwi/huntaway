import { Context } from "effect"
import type { Effect } from "effect"
import type { RunId } from "@huntaway/contracts"
import type { Run } from "./Run.ts"

// The board's MCP server as a Claude run reaches it on its own files (docs/plan/07-agents.md, Board tools: Dispatch):
// the `initialize` control request at the start of the run's input names it, with its handshake's results, and each MCP
// message then comes on the run's output as an `mcp_message` control request, answered on its input. The interface is
// here, in `runs/`, so that a run's line handler (`RunOutput`) and its launch can reach it; `mcp/transport/control.ts`
// implements it (the MCP area is below the runs area in the dependency order).

/** An `mcp_message` control request as the line handler decoded it: `{ request_id, request: { subtype, server_name, message } }`. */
export interface McpMessage {
  readonly request_id: string
  /** The in-process server it is for (the board's is the only one). */
  readonly server_name: unknown
  /** The JSON-RPC message, as Claude Code sent it. */
  readonly message: unknown
}

export interface McpControlShape {
  /**
   * A `control_request` with `subtype: "mcp_message"` from `run`'s output. The handshake (`initialize`, `tools/list`,
   * `ping`) and notifications are answered at once; a `tools/call` runs in the background, at most once per request
   * (a line read again finds the same call), and is answered on the run's input when it is done. Never fails.
   */
  readonly handle: (run: Run, request: McpMessage) => Effect.Effect<void>
  /** A `control_cancel_request` from `run`'s output: the agent no longer wants request `requestId` answered. */
  readonly cancel: (run: Run, requestId: string) => Effect.Effect<void>
  /**
   * The first line of a Claude run's input (it goes in the `prompt` file, before the first message): the `initialize`
   * control request that registers the board's server in process with its handshake's results (`sdkMcpServerManifests`),
   * request id `huntaway-init-<run id>`. A review thread's run (`review`) is given the reviewers' tools.
   */
  readonly initializeLine: (run: RunId, review: boolean) => Effect.Effect<string>
  /** Whether a `control_response` with this request id is Claude Code's answer to the `initialize` above. */
  readonly isInitializeResponse: (requestId: string) => boolean
}

export class McpControl extends Context.Service<McpControl, McpControlShape>()("huntaway-server/runs/McpControl") {}
