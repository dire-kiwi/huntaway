// A stand-in for Cua Driver's `cua-driver mcp` (apps/server/src/desktop/CuaDriver.ts), for tests and test servers: the
// server runs it as its driver when its `HUNTAWAY_CUA_DRIVER` names it (`scripts/test-server.sh --fake-desktop`;
// `fakeCuaDriver` in src/fakeCuaDriver.ts for tests). The old scripts/fake-cua-driver, ported. Plain Node: it stands
// in for an outside program, and never touches the desktop.
//
// It speaks MCP over stdio with a few of the driver's tools, answers them with canned results (one app, one window, a
// small image), and logs each call (`{tool, args}`, a JSON line) to $HUNTAWAY_FAKE_CUA_LOG if that's set. Its knobs,
// read on each call so a test can change them while it runs:
//   HUNTAWAY_FAKE_CUA_FAIL=<tool>   that tool's calls fail
//   HUNTAWAY_FAKE_CUA_DIR=<dir>     calls are logged to <dir>/calls.jsonl, and <dir>/fail (a tool's name) fails a tool
import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { createInterface } from "node:readline"

type Json = Record<string, unknown>

if (process.argv[2] !== "mcp") {
  process.stderr.write("fake-cua-driver: only `mcp` is faked\n")
  process.exit(2)
}

const dir = process.env["HUNTAWAY_FAKE_CUA_DIR"] ?? ""
const logFile = process.env["HUNTAWAY_FAKE_CUA_LOG"] ?? (dir === "" ? "" : `${dir}/calls.jsonl`)
const failing = (): string => {
  const own = process.env["HUNTAWAY_FAKE_CUA_FAIL"] ?? ""
  if (own !== "" || dir === "" || !existsSync(`${dir}/fail`)) return own
  return readFileSync(`${dir}/fail`, "utf8").trim()
}

const session = { session: { type: "string" } }
const TOOLS: Record<string, Json> = {
  check_permissions: {},
  list_apps: {},
  list_windows: { pid: { type: "integer" }, app: { type: "string" }, on_screen_only: { type: "boolean" } },
  get_window_state: {
    ...session,
    pid: { type: "integer" },
    window_id: { type: "integer" },
    include_accessibility_tree: { type: "boolean" },
    include_screenshot: { type: "boolean" },
    display_only: { type: "boolean" },
    max_image_dimension: { type: "integer" },
    query: { type: "string" },
    since: { type: "string" },
  },
  get_desktop_state: { ...session },
  zoom: { ...session, pid: { type: "integer" } },
  verify_state: { ...session, pid: { type: "integer" }, expect: { type: "array" } },
  run_steps: { ...session, steps: { type: "array" }, observe: {} },
  launch_app: { name: { type: "string" } },
  clipboard_read: { ...session, include_text: { type: "boolean" } },
  clipboard_write: { ...session, text: { type: "string" } },
}

// A 160×100 PNG, a different colour on each call so a viewer can tell frames apart.
let frame = 0
const SHADES = [
  "iVBORw0KGgoAAAANSUhEUgAAAKAAAABkCAIAAACO1KzYAAAAsUlEQVR42u3RAQkAAAgEsY9jJtMZ1Roig0twS/XocbEAsAALsAALsAALMGABFmABFmABFmDAAizAAizAAizAAgxYgAVYgAVYgAUYsAALsAALsAALMGABFmABFmABFmABBizAAizAAizAAgxYgAVYgAVYgAUYsAuABViABViABViAAQuwAAuwAAuwAAMWYAEWYAEWYAEWYMACLMACLMACLMCABViABViABViAAQuwAOteCwoU0Ru5sIrVAAAAAElFTkSuQmCC",
  "iVBORw0KGgoAAAANSUhEUgAAAKAAAABkCAIAAACO1KzYAAAAsUlEQVR42u3RAQkAAAgEsY9jJtMZ1Roig0twy3TpcbEAsAALsAALsAALMGABFmABFmABFmDAAizAAizAAizAAgxYgAVYgAVYgAUYsAALsAALsAALMGABFmABFmABFmABBizAAizAAizAAgxYgAVYgAVYgAUYsAuABViABViABViAAQuwAAuwAAuwAAMWYAEWYAEWYAEWYMACLMACLMACLMCABViABViABViAAQuwAOteC6V60RvvEKziAAAAAElFTkSuQmCC",
]
const png = (): string => SHADES[frame++ % SHADES.length] ?? ""

let clipboard = ""

const text = (t: string, structured?: Json): Json => ({
  content: [{ type: "text", text: t }],
  ...(structured === undefined ? {} : { structuredContent: structured }),
})
const image = (): Json => ({ type: "image", data: png(), mimeType: "image/png" })

function answer(tool: string, args: Json): Json {
  if (failing() === tool) return { content: [{ type: "text", text: `${tool} failed (FAKE_CUA_FAIL)` }], isError: true }
  switch (tool) {
    case "check_permissions":
      return text("accessibility: granted\nscreen_recording: granted")
    case "list_apps":
      return text("Fake Notes (pid 4242) running", { apps: [{ name: "Fake Notes", pid: 4242, running: true }] })
    case "list_windows":
      return text("[4242/7] Fake Notes — untitled", { windows: [{ pid: 4242, window_id: 7, app: "Fake Notes", title: "untitled", z_index: 1 }] })
    case "get_window_state": {
      const content: Array<Json> = []
      if (args["include_accessibility_tree"] !== false) {
        content.push({ type: "text", text: 'snapshot s00000001\n[0] window "untitled"\n  [1] text "body"\n  [2] button "Save"' })
      }
      if (args["include_screenshot"] === true) content.push(image())
      return { content, structuredContent: { snapshot_id: "s00000001", screenshot_width: 160, screenshot_height: 100 } }
    }
    case "get_desktop_state":
      return { content: [{ type: "text", text: "desktop" }, image()], structuredContent: { screenshot_width: 160, screenshot_height: 100 } }
    case "zoom":
      return { content: [image()] }
    case "verify_state":
      return text("satisfied", { result: "satisfied" })
    case "run_steps": {
      const steps = Array.isArray(args["steps"]) ? args["steps"] : []
      return text(`ran ${steps.length} steps\n~ [1] text "body" value="hi"`, { steps: steps.map(() => ({ ok: true })), failed_step: null })
    }
    case "launch_app":
      return text(`launched ${String(args["name"])}`, { pid: 5151, windows: [{ window_id: 9 }] })
    case "clipboard_read":
      // As Cua's: the text only when it's asked for.
      return args["include_text"] === true
        ? text(clipboard, { supported: true, text: clipboard })
        : text("text/plain", { supported: true, types: ["text/plain"] })
    case "clipboard_write":
      clipboard = typeof args["text"] === "string" ? args["text"] : ""
      return text("ok")
    default:
      return { content: [{ type: "text", text: `Unknown tool: ${tool}` }], isError: true }
  }
}

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v)
const parse = (line: string): unknown => {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}
const send = (v: Json) => process.stdout.write(`${JSON.stringify(v)}\n`)

for await (const line of createInterface({ input: process.stdin })) {
  if (line.trim() === "") continue
  const msg = parse(line)
  if (!isObject(msg) || msg["id"] === undefined) continue
  const id = msg["id"]
  const params = isObject(msg["params"]) ? msg["params"] : {}
  if (msg["method"] === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "cua-driver", version: "0.0.0-fake" } },
    })
  } else if (msg["method"] === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: Object.entries(TOOLS).map(([name, properties]) => ({ name, inputSchema: { type: "object", properties } })) } })
  } else if (msg["method"] === "tools/call") {
    const name = typeof params["name"] === "string" ? params["name"] : ""
    const args = isObject(params["arguments"]) ? params["arguments"] : {}
    if (logFile !== "") appendFileSync(logFile, `${JSON.stringify({ tool: name, args })}\n`)
    send({ jsonrpc: "2.0", id, result: answer(name, args) })
  } else {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${String(msg["method"])}` } })
  }
}
