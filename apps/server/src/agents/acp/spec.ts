import { Option, Schema } from "effect"

// What an ACP run is started with (HE-69; docs/plan/07-agents.md, ACP): `acp.json` in the run's folder, which the
// adapter (`huntaway acp-run`, acp-run.ts) reads, and which also marks the run as an ACP agent's. The launch decides it
// (`launch.ts`).
//
// The adapter speaks the Agent Client Protocol (JSON-RPC 2.0 over newline-delimited stdio) to the agent it starts
// (Google's Antigravity, `agy acp`, by default) and is, to the rest of the board, a Codex run: it reads the run's
// stream-json input as `codex-run` does (a user message, an `interrupt` control request, a `codex_response` answer) and
// writes Codex-shaped lines (`agents/codex/lines.ts`), so `runs/codex/output.ts`, the Codex translator, `Permissions`
// and `ToolCalls` handle it unchanged:
//
// - `session/new` (or `session/resume`/`session/load` of `session_id`) → `thread/started {thread: {id: sessionId}}`,
//   then `huntaway/model {model}` (the model the agent runs, after `model` is set).
// - Each `session/prompt` is a turn: `turn/started {turn: {id}}` … `turn/completed {turn: {id, status, error?}}`, its
//   status `completed` for `end_turn`, `interrupted` for `cancelled`, `failed` (with an error) for the others.
// - `agent_message_chunk` → `item/started`/`item/agentMessage/delta`/`item/completed` of an `agentMessage` item;
//   `agent_thought_chunk` → a `reasoning` item; `tool_call`/`tool_call_update` → `commandExecution` (kind `execute`),
//   `fileChange` (a `diff` content), `mcpToolCall` (an MCP server's tool) or `dynamicToolCall` items; `plan` →
//   `turn/plan/updated`; `usage_update` and the prompt's `usage` → `thread/tokenUsage/updated`.
// - `session/request_permission` → `item/commandExecution/requestApproval` (kind `execute`),
//   `item/fileChange/requestApproval` (edits), `item/tool/requestUserInput` (Antigravity's `interaction_` questions),
//   else `acp/requestPermission {itemId, tool, title, input, server?, server_tool?, server_named}`; the board's `{decision: "accept" | "decline"}` (or
//   `{answers}`) picks the agent's `allow_once`/`reject_once` option (or the chosen answer's).
// - A user message during a turn is held and starts the next turn (ACP has no steer); it is echoed when it does.
// - An interrupt is `session/cancel`; the turn then ends `interrupted`.

/** An MCP server given to the agent in `session/new`, in ACP's shape (http, or stdio without a `type`). */
export const AcpMcpServer = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("http"),
    name: Schema.String,
    url: Schema.String,
    headers: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
  }),
  Schema.Struct({
    name: Schema.String,
    command: Schema.String,
    args: Schema.Array(Schema.String),
    env: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
  }),
])
export type AcpMcpServer = typeof AcpMcpServer.Type

/** `acp.json`. */
export const AcpSpec = Schema.Struct({
  /** The session's working directory (`session/new`'s `cwd`). */
  cwd: Schema.String,
  /** The agent's program and its arguments (`agy`, `["acp"]` by default). */
  program: Schema.String,
  args: Schema.Array(Schema.String),
  /** The ACP session to continue (the task's session id), or null for a new one. */
  session_id: Schema.NullOr(Schema.String),
  /** The model to select (the session's `model` config option, or `session/set_model`), or null for the agent's own. */
  model: Schema.NullOr(Schema.String),
  /** The effort to select (a `thought_level` config option), when the agent offers it. */
  effort: Schema.NullOr(Schema.String),
  /** The board's permission mode (`PermissionMode`), turned into one of the agent's session modes when it has a match. */
  mode: Schema.String,
  /** The board's instructions, put before the first prompt of a new session (ACP has no system prompt). */
  system_prompt: Schema.String,
  /** Stdin is stream-json input (a user message, an interrupt, an answer to a request), not just the prompt. */
  input: Schema.Boolean,
  /**
   * The agent's permission requests go to the run's output, as Codex-shaped requests, and their answers come back on
   * its input (`codex_response`). Only with `input`; without it the adapter declines them itself.
   */
  requests_on_output: Schema.Boolean,
  /**
   * The board's MCP servers and the project's. An http one is given as it is to an agent that takes http MCP servers
   * (`mcpCapabilities.http`), and otherwise through `huntaway mcp-stdio` (the launcher in `HUNTAWAY_EXE`).
   */
  mcp_servers: Schema.Array(AcpMcpServer),
})
export interface AcpSpec extends Schema.Schema.Type<typeof AcpSpec> {}

/** The default ACP agent: Google's Antigravity CLI. */
export const DEFAULT_ACP_PROGRAM = "agy"
export const DEFAULT_ACP_ARGS: ReadonlyArray<string> = ["acp"]

/**
 * A command line's words, as a shell splits a simple one (no shell runs it): at blanks, but not inside single or
 * double quotes (which are taken off), and a backslash keeps the next character as it is (but in single quotes). An
 * unclosed quote goes to the end.
 */
export const commandWords = (line: string): ReadonlyArray<string> => {
  const out: Array<string> = []
  let word = ""
  let inWord = false
  let quote: "'" | '"' | null = null
  let escaped = false
  for (const c of line) {
    if (escaped) {
      word += c
      escaped = false
    } else if (c === "\\" && quote !== "'") {
      escaped = true
      inWord = true
    } else if (quote !== null) {
      if (c === quote) quote = null
      else word += c
    } else if (c === "'" || c === '"') {
      quote = c
      inWord = true
    } else if (/\s/u.test(c)) {
      if (inWord) out.push(word)
      word = ""
      inWord = false
    } else {
      word += c
      inWord = true
    }
  }
  if (inWord) out.push(word)
  return out
}

/** A config's command line (`AgentConfig.command`) as a program and its arguments; null or blank is the default. */
export const commandLine = (command: string | null | undefined): { readonly program: string; readonly args: ReadonlyArray<string> } => {
  const [program, ...args] = commandWords(command ?? "")
  return program === undefined ? { program: DEFAULT_ACP_PROGRAM, args: DEFAULT_ACP_ARGS } : { program, args }
}

const decodeSpec = Schema.decodeUnknownOption(AcpSpec)

/** An `acp.json` read back, or null if it isn't one. */
export const specFromJson = (v: unknown): AcpSpec | null => Option.getOrNull(decodeSpec(v))
