import { Predicate } from "effect"
import { toolPrefix } from "../claude/access.ts"
import { jsonText } from "../claude/tools.ts"

// What a Codex item shows as (huntaway's agent/codex/output.ts and the helpers of adapter.ts): the tool call it is, with
// the board's names (Bash, ApplyPatch, `mcp__<server>__<tool>`, WebSearch and WebFetch, Read), and what a finished one
// returned. Plain functions over the app-server's items as they come (`unknown`), shared by the translator
// (`translate.ts`) and the requests (`requests.ts`).

/**
 * The adapter's own notification (not Codex's) of whether a new thread took the board's tools as dynamic tools: it says
 * `{"dynamic": false}` when Codex wouldn't, and the thread has the board's MCP server instead.
 */
export const BOARD_TOOLS_METHOD = "huntaway/boardTools"
/** The adapter's own notification of the model a thread runs on (`{threadId, model}`), for the board's token counts. */
export const MODEL_METHOD = "huntaway/model"

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> => Predicate.isObject(v) && !Array.isArray(v)
/** A string field of an unknown value, or null. */
export const strField = (v: unknown, key: string): string | null => {
  const x = isRecord(v) ? v[key] : undefined
  return typeof x === "string" ? x : null
}
/** A field of an unknown value, or null where serde_json would read a missing field as null. */
export const field = (v: unknown, key: string): unknown => {
  const x = isRecord(v) ? v[key] : undefined
  return x === undefined ? null : x
}

/** The tool names' prefix for an MCP server (`access.ts`'): `mcp__<name>`, its characters but letters, digits, `_` and `-` as `_`. */
export { toolPrefix }

/**
 * A child keeps the same row across spawn, wait, follow-up and resumed runs. Its messages can arrive before the spawn
 * call returns, so its thread id names it rather than the spawn's item id.
 */
export const subagentId = (threadId: string): string => `codex-agent-${threadId}`

/** Whether a notification's `params` are the main thread's (`session`): one naming no thread is. */
export const ownThread = (params: unknown, session: string | null): boolean => {
  const id = strField(params, "threadId")
  return id === null || (session !== null && session === id)
}

/** `s` unquoted, if it is exactly one shell word (e.g. `'a b'"c"\'d`). */
const shellWord = (s: string): string | null => {
  let out = ""
  const chars = Array.from(s)
  let i = 0
  const next = (): string | null => (i < chars.length ? (chars[i++] ?? null) : null)
  while (true) {
    const c = next()
    if (c === null) return out
    if (c === "'") {
      while (true) {
        const n = next()
        if (n === null) return null
        if (n === "'") break
        out += n
      }
    } else if (c === '"') {
      while (true) {
        const n = next()
        if (n === null) return null
        if (n === '"') break
        if (n === "\\") {
          const e = next()
          if (e === null) return null
          if (e === '"' || e === "\\" || e === "$" || e === "`") out += e
          else if (e !== "\n") out += `\\${e}`
        } else out += n
      }
    } else if (c === "\\") {
      const n = next()
      if (n === null) return null
      out += n
    } else if (/\s/u.test(c)) {
      return null
    } else out += c
  }
}

/** `/usr/bin/bash -lc 'ls -la'` → `ls -la`: the command as the agent wrote it. */
export const displayCommand = (cmd: string): string => {
  for (const flag of [" -lc ", " -c "]) {
    const i = cmd.indexOf(flag)
    if (i < 0) continue
    const shell = cmd.slice(0, i)
    const rest = cmd.slice(i + flag.length)
    if (shell.endsWith("sh") && !shell.includes(" ")) {
      const script = shellWord(rest.trim())
      if (script !== null) return script
    }
  }
  return cmd
}

/** A file change item's changes, as ApplyPatch's input has them. */
export const fileChanges = (item: unknown): ReadonlyArray<Readonly<Record<string, unknown>>> => {
  const changes = isRecord(item) && Array.isArray(item["changes"]) ? item["changes"] : []
  return changes.map((c: unknown) => {
    const kind = field(c, "kind")
    return { path: field(c, "path"), kind: field(kind, "type"), move_path: field(kind, "move_path"), diff: field(c, "diff") }
  })
}

/** The tool call an item shows as: its name and input. Null for items that aren't tool calls. */
export const toolUse = (item: unknown): readonly [name: string, input: unknown] | null => {
  switch (strField(item, "type") ?? "") {
    case "commandExecution":
      return ["Bash", { command: displayCommand(strField(item, "command") ?? ""), cwd: field(item, "cwd") }]
    case "fileChange":
      return ["ApplyPatch", { changes: fileChanges(item) }]
    case "mcpToolCall":
      return [`${toolPrefix(strField(item, "server") ?? "")}__${strField(item, "tool") ?? ""}`, field(item, "arguments")]
    case "dynamicToolCall": {
      // The board's tools (requests.ts' `boardTools`) are named as its MCP server's are.
      const ns = strField(item, "namespace")
      const tool = strField(item, "tool") ?? "tool"
      return [ns !== null && ns !== "" ? `${toolPrefix(ns)}__${tool}` : tool, field(item, "arguments")]
    }
    case "webSearch": {
      const url = strField(field(item, "action"), "url")
      return url !== null ? ["WebFetch", { url }] : ["WebSearch", { query: field(item, "query") }]
    }
    case "imageView":
      return ["Read", { file_path: field(item, "path") }]
    case "collabAgentToolCall": {
      // Spawning succeeds before the child finishes. Its row is made from the child's thread, not from this short-lived
      // tool call; other collab calls aren't new agents.
      const tool = strField(item, "tool")
      if (tool === "spawnAgent" && field(item, "status") !== "failed") return null
      return [tool ?? "collab", { prompt: field(item, "prompt"), receiver_thread_ids: field(item, "receiverThreadIds") }]
    }
    default:
      return null
  }
}

/** Items whose call is shown when they start; the others only once they're done. */
export const shownAtStart = (kind: string): boolean =>
  ["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "collabAgentToolCall"].includes(kind)

/** What a finished tool item returned: its output, and whether it is an error. */
export const toolOutput = (item: unknown): readonly [output: string, isError: boolean] => {
  const status = strField(item, "status") ?? "completed"
  switch (strField(item, "type") ?? "") {
    case "commandExecution": {
      let out = strField(item, "aggregatedOutput") ?? ""
      const exit = field(item, "exitCode")
      const code = typeof exit === "number" && Number.isInteger(exit) ? exit : null
      if (status === "declined") return ["The command was declined.", true]
      if (code !== null && code !== 0) out += `${out === "" || out.endsWith("\n") ? "" : "\n"}(exit code ${code})`
      return [out, status === "failed" || (code !== null && code !== 0)]
    }
    case "fileChange":
      if (status === "declined") return ["The change was declined.", true]
      if (status === "failed") return ["The change couldn't be applied.", true]
      return ["Applied.", false]
    case "mcpToolCall": {
      const e = strField(field(item, "error"), "message")
      if (e !== null) return [e, true]
      const content = field(field(item, "result"), "content")
      const parts = Array.isArray(content) ? content : []
      return [parts.map((c: unknown) => strField(c, "text") ?? `[${strField(c, "type") ?? "content"}]`).join("\n"), status === "failed"]
    }
    case "dynamicToolCall": {
      const content = field(item, "contentItems")
      const parts = Array.isArray(content) ? content : []
      const text = parts.flatMap((c: unknown) => {
        const t = strField(c, "text")
        return t === null ? [] : [t]
      })
      return [text.join("\n"), field(item, "success") === false || status === "failed"]
    }
    case "webSearch": {
      const results = field(item, "results")
      return [Array.isArray(results) ? `${results.length} results` : "", false]
    }
    case "collabAgentToolCall":
      return [jsonPretty(field(item, "agentsStates")), status === "failed"]
    default:
      return ["", status === "failed"]
  }
}

/** JSON with two spaces' indent, as `JSON.stringify(v, null, 2)` writes it. */
const jsonPretty = (v: unknown): string => indent(v, "")

const indent = (v: unknown, at: string): string => {
  const inner = `${at}  `
  if (Array.isArray(v)) return v.length === 0 ? "[]" : `[\n${v.map((x) => inner + indent(x, inner)).join(",\n")}\n${at}]`
  if (isRecord(v)) {
    const entries = Object.entries(v).filter(([, x]) => x !== undefined)
    return entries.length === 0 ? "{}" : `{\n${entries.map(([k, x]) => `${inner}${jsonText(k)}: ${indent(x, inner)}`).join(",\n")}\n${at}}`
  }
  return jsonText(v)
}
