import { Context } from "effect"
import type { Effect } from "effect"
import type { RunId } from "@huntaway/contracts"
import type { BoardManifest } from "../agents/claude/launch.ts"
import type { Run } from "./Run.ts"

// The board's MCP server as a Claude run reaches it on its own files (docs/plan/07-agents.md, Board tools: Dispatch):
// the `initialize` control request at the start of the run's input names it, with its handshake's results, and each MCP
// message then comes on the run's output as an `mcp_message` control request, answered on its input. The interface is
// here, in `runs/`; `mcp/transport/control.ts` implements it (the MCP area is below the runs area in the dependency
// order) and registers it with `AgentRequests` (`mcp_message` requests, their cancellations, and the manifest the launch
// puts in the `initialize` line), which is how a run's line handler and its launch reach it without depending on it.

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
  /** The board server's handshake results for the `initialize` line (`sdkMcpServerManifests`): a review thread's lists the reviewers' tools. */
  readonly manifest: (review: boolean) => Effect.Effect<BoardManifest>
  /** Whether a `control_response` with this request id is Claude Code's answer to the `initialize` above. */
  readonly isInitializeResponse: (requestId: string) => boolean
}

export class McpControl extends Context.Service<McpControl, McpControlShape>()("huntaway-server/runs/McpControl") {}
