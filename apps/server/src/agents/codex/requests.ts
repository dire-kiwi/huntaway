import { BOARD_SERVER_NAMES } from "@huntaway/shared"
import { Effect, Predicate } from "effect"
import { toJson } from "../../platform/columns.ts"
import type { BoardManifest } from "../claude/launch.ts"
import { displayCommand, field, fileChanges, strField, toolPrefix } from "./items.ts"

// What a Codex run asks the board, on its output (huntaway's agent/codex/requests.ts; inventory 03, 2.7): the adapter
// writes each of the app-server's requests to `out.jsonl` as it is (an approval with the item it's about as `item`), and
// the board answers it on the run's input (`{"type": "codex_response", "id", "result" | "error"}`), as Claude's control
// requests are answered. Each is recorded under the call id `stdio:<run id>:codex:<id>`, at most once, and taken up
// again after a restart. Plain functions here: what a request is (`classify`), and how its answer is written.
//
// - **Approvals** (a command, a file change, more permissions, an MCP server's elicitation) are permission prompts, as
//   Bash, ApplyPatch, Permissions, or the MCP tool, so the thread's request and `permission_requests` are those of a
//   Claude run's.
// - **Questions** (`item/tool/requestUserInput`) are the `request_user_input` prompt, answered with Codex's answers.
// - **The board's tools** are Codex dynamic tools (`boardTools`, a namespace named for the board's server, given to a new
//   thread), each `item/tool/call` a call through `ToolCalls`, as Claude's in-process server's are.

/** The tool Codex's questions are asked as. */
export const CODEX_QUESTIONS = "request_user_input"

/** The board's own MCP server, and its older names: Codex namespaces from older sessions name it so. */
export const isBoardServer = (name: string): boolean => BOARD_SERVER_NAMES.includes(name)

/** What answering one of Codex's requests needs of it: its JSON-RPC id and method (and an approval's permissions, which it grants). */
export interface CodexAsk {
  readonly id: string | number
  readonly method: string
  readonly permissions?: unknown
}

/** A request as the line handler read it from a Codex run's output: `{id, method, params, item?}`. */
export interface CodexRequest {
  readonly id: string | number
  readonly method: string
  readonly params: unknown
  /** The item it's about, which the adapter attached (an approval only names its item). */
  readonly item?: unknown
}

/** The request id a Codex request is recorded under: `codex:<id>` (a string id as JSON), so its call id is `stdio:<run>:codex:<id>`. */
export const requestId = (id: string | number): Effect.Effect<string> =>
  typeof id === "string" ? Effect.map(toJson(id), (j) => `codex:${j}`) : Effect.succeed(`codex:${id}`)

/** What the board does with a request. */
export type Classified =
  /** Asked as a permission prompt (or the questions' prompt) of tool `tool_name` with `input`, for item `tool_use_id`. */
  | {
      readonly _tag: "Prompt"
      readonly tool_name: string
      readonly input: unknown
      readonly tool_use_id: string | null
      readonly ask: CodexAsk
    }
  /** A call of the board's tool `tool` (a dynamic tool of its namespace) with `args`. */
  | { readonly _tag: "Tool"; readonly tool: string; readonly args: unknown }
  /** Answered at once with `answer` (`{result}` or `{error}`). */
  | { readonly _tag: "Answer"; readonly answer: CodexAnswer }

/** An answer to one of Codex's requests: its result, or an error. */
export type CodexAnswer = { readonly result: unknown } | { readonly error: { readonly code: number; readonly message: string } }

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> => Predicate.isObject(v) && !Array.isArray(v)

/** A method the board doesn't answer. */
const unsupported = (method: string): CodexAnswer => ({ error: { code: -32601, message: `Method not supported by Huntaway: ${method}` } })

/** Codex's answer to a board tool's call, as the board's MCP server would have given it (`{content, isError}`). */
export const toolAnswer = (result: unknown): unknown => {
  const content = field(result, "content")
  const text = (Array.isArray(content) ? content : []).map((c: unknown) => strField(c, "text") ?? "").join("\n")
  return { contentItems: [{ type: "inputText", text }], success: field(result, "isError") !== true }
}

/** The answer for a call of a tool the board doesn't have, as the board's MCP server words it. */
const noTool = (namespace: string | null, tool: string): CodexAnswer => ({
  result: toolAnswer({ content: [{ type: "text", text: `There's no tool ${namespace !== null ? `${namespace}.` : ""}${tool}.` }], isError: true }),
})

/**
 * An MCP server's elicitation. Only forms that need nothing filled in (e.g. "allow this tool call?") can be accepted.
 * The board's own server (a session from before its tools were dynamic tools) needs no approval but for a `wait` that
 * Codex's reviewer didn't take (`review_waits`), which is asked about as the command it runs.
 */
const elicitation = (r: CodexRequest, prompt: (tool: string, input: unknown) => Classified): Classified => {
  const p = r.params
  const props = field(field(p, "requestedSchema"), "properties")
  const fields = isRecord(props) ? Object.keys(props).length : 0
  const server = strField(p, "serverName") ?? "mcp"
  const message = strField(p, "message") ?? ""
  // "Allow the x MCP server to run tool "y"?" asks about a tool call.
  let tool = "elicitation"
  const at = message.indexOf('tool "')
  if (at >= 0) {
    const rest = message.slice(at + 6)
    const q = rest.indexOf('"')
    if (q >= 0) tool = rest.slice(0, q)
  }
  const params = field(field(p, "_meta"), "tool_params")
  const command = strField(params, "command")
  const cmd = command === null ? "" : command.trim()
  if (field(p, "mode") === "url" || fields > 0) return { _tag: "Answer", answer: { result: { action: "decline" } } }
  if (isBoardServer(server) && tool === "wait" && (cmd !== "" || !isRecord(params))) {
    if (cmd !== "") {
      const reason = strField(params, "reason")
      return prompt("Bash", { command: cmd, description: `Run while waiting${reason === null ? "" : `: ${reason}`}` })
    }
    return prompt(`${toolPrefix(server)}__wait`, { message })
  }
  if (isBoardServer(server)) return { _tag: "Answer", answer: { result: { action: "accept", content: {} } } }
  // With what it's called with, when Codex says (for the user, and the action log).
  return prompt(`${toolPrefix(server)}__${tool}`, isRecord(params) ? { message, arguments: params } : { message })
}

/** What request `r` (as the adapter wrote it to the run's output) is to the board. */
export const classify = (r: CodexRequest): Classified => {
  const p = r.params
  const ask: CodexAsk = { id: r.id, method: r.method }
  const prompt = (tool_name: string, input: unknown, extra: Partial<CodexAsk> = {}): Classified => ({
    _tag: "Prompt",
    tool_name,
    input,
    tool_use_id: strField(p, "itemId"),
    ask: { ...ask, ...extra },
  })
  switch (r.method) {
    case "item/commandExecution/requestApproval": {
      const command = strField(p, "command")
      const reason = strField(p, "reason")
      return prompt("Bash", {
        command: command === null ? "" : displayCommand(command),
        cwd: field(p, "cwd"),
        ...(reason === null ? {} : { description: reason }),
      })
    }
    case "item/fileChange/requestApproval": {
      // The changes are the item's, which the adapter sends with it: it has every item of the run that's started.
      const reason = strField(p, "reason")
      const root = strField(p, "grantRoot")
      return prompt("ApplyPatch", {
        changes: fileChanges(r.item ?? null),
        ...(reason === null ? {} : { reason }),
        ...(root === null ? {} : { grant_root: root }),
      })
    }
    case "item/permissions/requestApproval":
      return prompt(
        "Permissions",
        { permissions: field(p, "permissions"), reason: field(p, "reason"), cwd: field(p, "cwd") },
        { permissions: field(p, "permissions") },
      )
    case "mcpServer/elicitation/request":
      return elicitation(r, prompt)
    // Its questions are asked in the thread as Claude's AskUserQuestion is, and answered with the user's answers by
    // question id. Unanswered, the agent carries on with its own judgement.
    case "item/tool/requestUserInput": {
      const asked = field(p, "questions")
      const questions = (Array.isArray(asked) ? asked : []).map((q: unknown) => {
        const options = field(q, "options")
        return {
          id: field(q, "id"),
          header: field(q, "header"),
          question: field(q, "question"),
          multiSelect: false,
          options: Array.isArray(options) ? options : [],
          isOther: field(q, "isOther"),
          isSecret: field(q, "isSecret"),
        }
      })
      return prompt(CODEX_QUESTIONS, { questions })
    }
    case "item/tool/call": {
      const tool = strField(p, "tool") ?? ""
      const namespace = strField(p, "namespace")
      if (namespace === null || !isBoardServer(namespace)) return { _tag: "Answer", answer: noTool(namespace, tool) }
      return { _tag: "Tool", tool, args: field(p, "arguments") }
    }
    default:
      return { _tag: "Answer", answer: unsupported(r.method) }
  }
}

/** A permission decision as the board makes it (`Permissions`' `Decision`): allowed with its input, or denied. */
interface DecisionLike {
  readonly behavior: "allow" | "deny"
  readonly updatedInput?: unknown
}

/** Codex's answer to request `ask`, from the board's permission decision. */
export const promptAnswer = (ask: CodexAsk, decision: DecisionLike): unknown => {
  const ok = decision.behavior === "allow"
  switch (ask.method) {
    case "item/permissions/requestApproval":
      return { permissions: ok ? (ask.permissions ?? {}) : {}, scope: "turn" }
    case "mcpServer/elicitation/request":
      return { action: ok ? "accept" : "decline", content: ok ? {} : null }
    case "item/tool/requestUserInput": {
      const answers = ok ? field(decision.updatedInput, "answers") : {}
      return { answers: isRecord(answers) ? answers : {} }
    }
    default:
      return { decision: ok ? "accept" : "decline" }
  }
}

/** The line that answers Codex's request `id` on the run's input. */
export const codexResponse = (id: string | number, answer: CodexAnswer): Effect.Effect<string> => toJson({ type: "codex_response", id, ...answer })

/**
 * The board's tools as one Codex dynamic tool: a namespace named for the board's MCP server, whose calls are named as
 * that server's are (`items.ts`' `toolUse`), from the server's handshake (`manifest`, a review thread's with the
 * reviewers' tools).
 */
export const boardTools = (manifest: BoardManifest): Readonly<Record<string, unknown>> => {
  const tools = manifest.toolsListResult.tools.flatMap((t: unknown) => {
    const name = strField(t, "name")
    if (name === null || name === "permission_prompt") return []
    const schema = field(t, "inputSchema")
    return [{ type: "function", name, description: strField(t, "description") ?? "", inputSchema: schema === null ? { type: "object" } : schema }]
  })
  const instructions = strField(manifest.initializeResult, "instructions") ?? ""
  return { type: "namespace", name: BOARD_SERVER_NAMES[0] ?? "huntaway", description: instructions, tools }
}
