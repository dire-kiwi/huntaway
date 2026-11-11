import type { FileChange, Question, QuestionOption, Todo, ToolCall, ToolKind } from "@huntaway/contracts"
import { Predicate, Result, Schema } from "effect"

// What tools are, for the translator and for the board's permission prompts: a tool's kind by its name, a tool call's
// fields, a result's text (cut short as the old `slim` cut it), and an AskUserQuestion's questions. The old
// threads/translate/tools.ts and the result half of agent/runner/output.ts's `slim`, rule for rule.

/** The MCP server whose tools are the app's own (`app` calls, not `mcp` ones), as agent-threads names it. */
const APP_SERVER = "app"

/** A tool result's text longer than this (in UTF-8 bytes) is cut short, with a `\n… [truncated <n> bytes]` marker. */
export const RESULT_MAX_BYTES = 30_000

/** A string field of an unknown value, if it is a string that is not empty. */
export const str = (value: unknown, name: string): string | undefined => {
  const field = Predicate.isObject(value) ? value[name] : undefined
  return typeof field === "string" && field !== "" ? field : undefined
}

/** A whole number that is not negative. */
export const uint = (value: unknown): number | undefined => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined)

const encodeJson = Schema.encodeUnknownResult(Schema.fromJsonString(Schema.Unknown))

/** A value as JSON text ("" for what JSON cannot say). */
export const jsonText = (value: unknown): string => Result.getOrElse(encodeJson(value), () => "")

/** Deep equality of JSON values (the order of objects' keys doesn't count, nor a key set to undefined). */
export const sameJson = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => sameJson(x, b[i]))
  if (!Predicate.isObject(a) || !Predicate.isObject(b)) return (a ?? null) === (b ?? null)
  const ka = Object.keys(a).filter((k) => a[k] !== undefined)
  const kb = Object.keys(b).filter((k) => b[k] !== undefined)
  return ka.length === kb.length && ka.every((k) => k in b && sameJson(a[k], b[k]))
}

/** What a tool does, by its name, as agent-threads' Claude driver says it. */
export const kindOf = (name: string): ToolKind => {
  switch (name) {
    case "Bash":
    case "BashOutput":
      return "shell"
    case "Read":
    case "NotebookRead":
      return "read"
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
    case "ApplyPatch":
      return "edit"
    case "Glob":
    case "Grep":
      return "search"
    case "WebFetch":
    case "WebSearch":
      return "web"
    case "Task":
    case "Agent":
      return "subagent"
    case "TodoWrite":
      return "todo"
    default:
      return "other"
  }
}

/** A tool call's fields that come from its name and input. */
export type ToolFields = Pick<ToolCall, "name" | "kind" | "input" | "server" | "command" | "path" | "query" | "url" | "title" | "changes" | "todos">

const todoStatus = (status: unknown): Todo["status"] => (status === "in_progress" || status === "completed" ? status : "pending")

/** ApplyPatch's changes (Codex's file changes, stored as ApplyPatch), as edits. */
const patchChanges = (changes: unknown): ReadonlyArray<FileChange> =>
  (Array.isArray(changes) ? changes : []).flatMap((c: unknown): ReadonlyArray<FileChange> => {
    const path = str(c, "path")
    if (path === undefined) return []
    const kind = Predicate.isObject(c) ? c["kind"] : undefined
    const diff = str(c, "diff")
    const to = str(c, "move_path")
    return [
      {
        path,
        op: kind === "add" ? "add" : kind === "delete" ? "delete" : "update",
        ...(diff === undefined ? {} : { diff }),
        ...(to === undefined ? {} : { move_to: to }),
      },
    ]
  })

const todos = (list: unknown): ReadonlyArray<Todo> =>
  (Array.isArray(list) ? list : []).map((x: unknown): Todo => {
    const content = Predicate.isObject(x) ? x["content"] : undefined
    const text = typeof content === "string" ? content : content === null || content === undefined ? "" : jsonText(content)
    return { text, status: todoStatus(Predicate.isObject(x) ? x["status"] : undefined) }
  })

/** A tool call's fields for a tool_use (`name`, `input`): the same as agent-threads' Claude driver makes. */
export const toolFields = (name: string, rawInput: unknown): ToolFields => {
  const input = rawInput === null || rawInput === undefined ? {} : rawInput
  let tool = name
  let kind = kindOf(name)
  let server: string | undefined
  if (name.startsWith("mcp__")) {
    const rest = name.slice(5)
    const at = rest.indexOf("__")
    server = (at < 0 ? rest : rest.slice(0, at)) || undefined
    tool = at < 0 ? "" : rest.slice(at + 2)
    kind = "mcp"
    // The app's own tools, on its in-process server (agent-threads' `app`).
    if (server === APP_SERVER) {
      kind = "app"
      server = undefined
    }
  }
  const command = Predicate.isObject(input) && typeof input["command"] === "string" ? input["command"] : undefined
  const fields: { -readonly [K in keyof ToolFields]: ToolFields[K] } = { name: tool, kind, input }
  if (server !== undefined) fields.server = server
  const set = (key: "command" | "path" | "query" | "url" | "title", value: string | undefined) => {
    if (value !== undefined) fields[key] = value
  }
  switch (kind) {
    case "shell":
      set("command", command)
      break
    case "read":
      set("path", str(input, "file_path"))
      break
    case "search":
      set("query", str(input, "pattern"))
      set("path", str(input, "path"))
      break
    case "web":
      set("url", str(input, "url"))
      set("query", str(input, "query"))
      break
    case "subagent":
      set("title", str(input, "description"))
      break
    case "edit":
    case "mcp":
    case "app":
    case "todo":
    case "other":
      break
  }
  if (kind === "edit" && name === "ApplyPatch") {
    fields.changes = patchChanges(Predicate.isObject(input) ? input["changes"] : undefined)
  } else if (kind === "edit") {
    const path = str(input, "file_path") ?? str(input, "notebook_path")
    if (path !== undefined) fields.changes = [{ path, op: "update" }]
  } else if (kind === "todo") {
    fields.todos = todos(Predicate.isObject(input) ? input["todos"] : undefined)
  }
  return fields
}

/** A permission's title: what it's about, in a few words. */
export const toolTitle = (fields: ToolFields): string => {
  if (fields.command) return fields.command
  if (fields.path) return fields.path
  if (fields.changes?.length) return fields.changes.map((c) => c.path).join(", ")
  return fields.name
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** `text` cut to at most `max` UTF-8 bytes (at a character's start) and marked so, if it is longer. */
export const truncate = (text: string, max: number): string => {
  const bytes = encoder.encode(text)
  if (bytes.length <= max) return text
  let end = max
  // Back up to a character's first byte (one that is not a UTF-8 continuation byte).
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--
  return `${decoder.decode(bytes.subarray(0, end))}\n… [truncated ${bytes.length - end} bytes]`
}

/** A tool result's content as text: text parts joined by newlines, each cut short as the old `slim` did; images are `[image]`. */
export const resultText = (content: unknown): string => {
  if (typeof content === "string") return truncate(content, RESULT_MAX_BYTES)
  if (Array.isArray(content)) {
    return content
      .flatMap((part: unknown): ReadonlyArray<string> => {
        if (!Predicate.isObject(part)) return []
        const text = part["text"]
        if (typeof text === "string" && encoder.encode(text).length > RESULT_MAX_BYTES) return [truncate(text, RESULT_MAX_BYTES)]
        if (part["type"] === "text") return [typeof text === "string" ? text : ""]
        if (part["type"] === "image") return ["[image]"]
        if (part["type"] === "tool_reference" && typeof part["tool_name"] === "string") return [part["tool_name"]]
        return []
      })
      .join("\n")
  }
  if (content === null || content === undefined) return ""
  return jsonText(content)
}

/** Whether a result's text was cut short (`resultText`'s marker on a text that long). */
export const isTruncated = (text: string): boolean => text.length > RESULT_MAX_BYTES && text.includes("\n… [truncated ")

/** A protocol question from an AskUserQuestion question (or Codex's request_user_input one), with its id; `allowOther`: it always takes an answer of one's own. */
export const question = (q: unknown, id: string, allowOther = false): Question => {
  const text = Predicate.isObject(q) && typeof q["question"] === "string" ? q["question"] : ""
  const header = str(q, "header")
  const options = (Predicate.isObject(q) && Array.isArray(q["options"]) ? q["options"] : []).flatMap((o: unknown): ReadonlyArray<QuestionOption> => {
    const label = typeof o === "string" ? o : Predicate.isObject(o) && typeof o["label"] === "string" ? o["label"] : undefined
    if (label === undefined) return []
    const description = str(o, "description")
    return [description === undefined ? { label } : { label, description }]
  })
  const flag = (...names: ReadonlyArray<string>) => Predicate.isObject(q) && names.some((n) => q[n] === true)
  return {
    id,
    question: text,
    ...(header === undefined ? {} : { header }),
    ...(options.length > 0 ? { options } : {}),
    ...(flag("multi_select", "multiSelect") ? { multi_select: true } : {}),
    ...(allowOther || flag("allow_other", "isOther") ? { allow_other: true } : {}),
    ...(flag("isSecret", "secret") ? { secret: true } : {}),
  }
}
