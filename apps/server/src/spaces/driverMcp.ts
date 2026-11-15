import { Option, Predicate, Schema } from "effect"
import { truncate } from "../git/paths.ts"

// What the host's server says to a Space's Cua Driver (HE-37), plainly: spacesd serves the driver as an MCP server on
// `POST /mcp` (streamable HTTP, `authorization: Bearer <spacesd's token>`), answering as JSON (or, as the transport
// allows, an event stream). It answers a request without a session too, but the driver ties what it saw to the MCP
// session (a pixel click is refused unless that session read the window's screenshot), so `Spaces.driver` keeps one
// (`initialize`, then `mcp-session-id` and `mcp-protocol-version` on each request; without the version, 400). And what the `spaces` server makes of the
// driver's tools for an agent: its list is some 200 KB of schemas, so `space_list_tools` gives one line a tool and a
// tool's schema when asked for it. No I/O here.

/** The path of spacesd's MCP endpoint. */
export const MCP_PATH = "/mcp"

/**
 * Tools spacesd lists beside the driver's that are about Cua's own Spaces (making, sharing, running commands on its
 * host), not the desktop: the `spaces` server has its own for this host's Spaces, so these aren't offered.
 */
export const HIDDEN_TOOLS: ReadonlySet<string> = new Set([
  "create_space",
  "fork_space",
  "list_spaces",
  "delete_space",
  "stop_space",
  "start_space",
  "space_bash",
  "share_tcp_port",
  "list_tcp_shares",
  "stop_tcp_share",
])

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> => Predicate.isObject(v) && !Array.isArray(v)
const Json = Schema.fromJsonString(Schema.Unknown)
const encodeJson = Schema.encodeOption(Json)
const decodeJson = Schema.decodeUnknownOption(Json)

/** The MCP version the server asks for. */
export const MCP_PROTOCOL = "2025-06-18"

/** `initialize`'s parameters. */
export const INITIALIZE = { protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: { name: "huntaway", version: "1" } }

/** A JSON-RPC notification's body. */
export const notification = (method: string): string => Option.getOrElse(encodeJson({ jsonrpc: "2.0", method }), () => "{}")

/** A JSON-RPC request's body. */
export const requestBody = (id: number, method: string, params: unknown): string =>
  Option.getOrElse(encodeJson({ jsonrpc: "2.0", id, method, params }), () => "{}")

/** The driver's answer to request `id`: its result, or why there is none. */
export type DriverAnswer = { readonly result: unknown } | { readonly error: string }

const answerOf = (message: unknown, id: number): DriverAnswer | null => {
  if (!isRecord(message) || message["id"] !== id) return null
  const error = message["error"]
  if (isRecord(error)) return { error: `Cua Driver: ${typeof error["message"] === "string" ? error["message"] : "error"}` }
  return "result" in message ? { result: message["result"] } : { error: "Cua Driver answered without a result" }
}

/** spacesd's answer to request `id`, as JSON or as an event stream whose `data:` lines are messages. */
export const parseAnswer = (contentType: string, body: string, id: number): DriverAnswer => {
  const messages: Array<unknown> = contentType.includes("text/event-stream")
    ? body.split(/\r?\n\r?\n/u).flatMap((event) => {
        const data = event
          .split(/\r?\n/u)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n")
        return data === "" ? [] : Option.toArray(decodeJson(data))
      })
    : Option.toArray(decodeJson(body))
  for (const message of messages.flatMap((m) => (Array.isArray(m) ? m : [m]))) {
    const a = answerOf(message, id)
    if (a !== null) return a
  }
  return { error: "Cua Driver's answer didn't parse" }
}

/** A tool as the driver lists it. */
export const DriverTool = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  inputSchema: Schema.optional(Schema.Unknown),
  annotations: Schema.optional(Schema.Struct({ readOnlyHint: Schema.optional(Schema.Boolean) })),
})
export type DriverTool = typeof DriverTool.Type

const decodeList = Schema.decodeUnknownOption(Schema.Struct({ tools: Schema.Array(Schema.Unknown) }))
const decodeTool = Schema.decodeUnknownOption(DriverTool)

/** The tools of a `tools/list` result that the `spaces` server offers (`HIDDEN_TOOLS` left out). */
export const driverTools = (result: unknown): ReadonlyArray<DriverTool> =>
  Option.match(decodeList(result), {
    onNone: () => [],
    onSome: (l) => l.tools.flatMap((t) => Option.toArray(decodeTool(t))).filter((t) => !HIDDEN_TOOLS.has(t.name)),
  })

/** Whether a tool only looks: what it says of itself (anything that doesn't say so is an action). */
export const readOnly = (tool: DriverTool): boolean => tool.annotations?.readOnlyHint === true

/** A tool's argument names, required ones first. */
const argsOf = (tool: DriverTool): ReadonlyArray<string> => {
  const s = tool.inputSchema
  const props = isRecord(s) && isRecord(s["properties"]) ? Object.keys(s["properties"]) : []
  const required = isRecord(s) && Array.isArray(s["required"]) ? s["required"].filter((r): r is string => typeof r === "string") : []
  return [...required.filter((r) => props.includes(r)), ...props.filter((p) => !required.includes(p) && p !== "session").toSorted()]
}

/** The first sentence (or line) of a description. */
const firstSentence = (d: string): string => truncate((d.split("\n")[0] ?? "").split(/(?<=\.)\s/u)[0] ?? "", 160)

/** One line a tool: its name, whether it only looks, its arguments (required first), what it does. */
export const toolsSummary = (tools: ReadonlyArray<DriverTool>): string =>
  tools.map((t) => `- ${t.name}${readOnly(t) ? " (read-only)" : ""}(${argsOf(t).join(", ")}): ${firstSentence(t.description ?? "")}`).join("\n")

/** One tool in full: its description and its input schema as JSON. */
export const toolDetail = (tool: DriverTool): string =>
  `${tool.name}${readOnly(tool) ? " (read-only)" : ""}\n\n${tool.description ?? ""}\n\nArguments (JSON Schema):\n${truncate(
    Option.getOrElse(Schema.encodeOption(Schema.fromJsonString(Schema.Unknown, { space: 2 }))(tool.inputSchema ?? {}), () => "{}"),
    30_000,
  )}`
