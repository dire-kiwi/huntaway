import { Schema } from "effect"
import { Tool } from "effect/ai"
import { Rerunnable } from "../mcp/tool.ts"
import { DesktopContent } from "./cua.ts"

// The `desktop` server's tools (huntaway's mcp/desktop_mcp.ts `TOOLS`; docs/plan/inventory/03-mcp.md 2.12), shaped after
// `agentcast` (pingdotgg/t3code#28050): a few tools that each do one job. Names, arguments and descriptions are the old
// ones word for word; the arguments are Cua's, passed on with Cua's names. The read-only ones say so (`readOnlyHint`:
// Codex runs them without asking; Claude runs have them in `--allowedTools`) and may run again after a restart; the
// others ask, as any tool does, and are journaled (`DesktopOpRepo`).

const pid = Schema.Int.annotate({ description: "The app's process id (from `windows` or `apps`)." })
const windowId = Schema.Int.annotate({ description: "The window's id from `windows`. Omitted: the app's focused or largest window." })
const opId = Schema.String.annotate({
  description: "Your name for this action, unique in this task, so a retry after a lost answer doesn't run it twice.",
})
const opt = Schema.optionalKey

/** A tool that only looks. */
const look = <const Name extends string, const Fields extends Schema.Struct.Fields>(name: Name, description: string, fields: Fields) =>
  Tool.make(name, { description, parameters: Schema.Struct(fields), success: DesktopContent })
    .annotate(Tool.Readonly, true)
    .annotate(Rerunnable, true)

/** A tool that changes something. */
const change = <const Name extends string, const Fields extends Schema.Struct.Fields>(name: Name, description: string, fields: Fields) =>
  Tool.make(name, { description, parameters: Schema.Struct(fields), success: DesktopContent })

export const Health = look(
  "health",
  "Whether the desktop can be used now: the driver, the session (Wayland or X11), a locked screen, and which task is using it.",
  {},
)

export const Apps = look("apps", "Installed and running apps, with what `launch` takes to start them.", {})

export const Windows = look("windows", "Open windows: pid, window_id, app, title, bounds, and how near the front they are (larger z_index is nearer).", {
  pid: opt(Schema.Int.annotate({ description: "Only this process's windows." })),
  app: opt(Schema.String.annotate({ description: "Only windows of apps whose name contains this." })),
  on_screen_only: opt(Schema.Boolean),
})

export const Read = look(
  "read",
  'A window\'s accessibility tree, as rows `[N] role "label"`; act on row N with element_token `<snapshot_id>:N`. Start with `query` to get only matching rows (and their ancestors); `since: "latest"` returns only what changed since your last read of that window.',
  {
    pid,
    window_id: opt(windowId),
    query: opt(Schema.String.annotate({ description: "Case-insensitive text to match rows against." })),
    since: opt(Schema.String.annotate({ description: '"latest", or a snapshot_id: only the rows that changed since.' })),
    max_elements: opt(Schema.Int.annotate({ description: "Most nodes to walk (default 250)." })),
    max_depth: opt(Schema.Int),
    include_screenshot: opt(Schema.Boolean.annotate({ description: "Also return the window's image (default false: use `screen` to look)." })),
  },
)

export const Screen = look(
  "screen",
  "An image of a window (with pid), or of the whole desktop (without). Pixels in a window's image are what `act` steps' x, y mean for it.",
  { pid: opt(Schema.Int.annotate({ description: "The app's process id; omitted for the whole desktop." })), window_id: opt(windowId) },
)

export const Zoom = look(
  "zoom",
  "A region of a window's last image at full resolution, from x1,y1 (top left) to x2,y2 (bottom right), in that image's pixels.",
  {
    pid,
    window_id: opt(windowId),
    x1: Schema.Finite,
    y1: Schema.Finite,
    x2: Schema.Finite,
    y2: Schema.Finite,
  },
)

export const Verify = look(
  "verify",
  'Check a window against what you expect, e.g. expect: [{"element": {"selector": {"label_contains": "Saved"}, "exists": true}}]. Answers satisfied, unsatisfied or unknown (with why).',
  { pid, window_id: opt(windowId), expect: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)), include_screenshot: opt(Schema.Boolean) },
)

export const OpStatus = look(
  "op_status",
  "What became of an `act`, `launch` or `clipboard` you gave an op_id: running, ok, failed, or interrupted (unknown: look before acting again).",
  { op_id: Schema.String },
)

/** A step of an `act`. */
const Step = Schema.Struct({ tool: Schema.String, args: opt(Schema.Record(Schema.String, Schema.Unknown)) })

export const Act = change(
  "act",
  'Run steps on a window, in order, stopping at the first that fails, then report what changed. A step is {"tool": click | double_click | right_click | type_text | set_value | press_key | hotkey | scroll | drag | move_cursor, "args": {...}}, e.g. {"tool": "click", "args": {"element_token": "s0000002a:14"}}, {"tool": "type_text", "args": {"element_token": "s0000002a:15", "text": "hi"}}, {"tool": "press_key", "args": {"key": "return"}}, {"tool": "hotkey", "args": {"keys": ["ctrl", "s"]}}, or pixels: {"tool": "click", "args": {"x": 120, "y": 40}}. pid and window_id here apply to every step.',
  {
    pid,
    window_id: opt(windowId),
    steps: Schema.Array(Step).check(Schema.isMaxLength(64)),
    observe: opt(
      Schema.Unknown.annotate({ description: "What to read after the last step: true or read's arguments (default: what changed); false to read nothing." }),
    ),
    delivery_mode: opt(
      Schema.Literals(["background", "foreground"]).annotate({
        description: "Default background. Foreground takes focus and the pointer: only if the user allows it.",
      }),
    ),
    delay_ms: opt(Schema.Int.annotate({ description: "Pause between steps." })),
    op_id: opt(opId),
  },
)

export const Launch = change(
  "launch",
  "Start an app (by name, or the launch_path `apps` gave), optionally opening URLs or files in it. Returns its pid and windows.",
  {
    name: opt(Schema.String),
    launch_path: opt(Schema.String),
    bundle_id: opt(Schema.String.annotate({ description: "macOS." })),
    urls: opt(Schema.Array(Schema.String)),
    additional_arguments: opt(Schema.Array(Schema.String)),
    op_id: opt(opId),
  },
)

export const Clipboard = change("clipboard", "Read the clipboard's text, or with `text`, set it.", { text: opt(Schema.String), op_id: opt(opId) })

/** The tools, in `tools/list`'s order. */
export const DESKTOP_TOOLS = [Health, Apps, Windows, Read, Screen, Zoom, Verify, OpStatus, Act, Launch, Clipboard] as const
