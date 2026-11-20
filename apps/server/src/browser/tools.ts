import { Schema } from "effect"
import { Tool } from "effect/ai"
import { DesktopContent } from "../desktop/cua.ts"
import { Rerunnable } from "../mcp/tool.ts"

// The `browser` server's tools (HE-62): the task's own web browser, which the user sees beside the thread. Its page is
// read as an outline with refs (`snapshot`), and acted on by ref. The ones that only look say so (`readOnlyHint`) and
// may run again after a restart. Every run gets them without asking: the page is a sandboxed web page of the task's.

const opt = Schema.optionalKey
const ref = Schema.String.annotate({ description: "A ref from the latest snapshot, like e12." })

/** A tool that only looks. */
const look = <const Name extends string, const Fields extends Schema.Struct.Fields>(name: Name, description: string, fields: Fields) =>
  Tool.make(name, { description, parameters: Schema.Struct(fields), success: DesktopContent })
    .annotate(Tool.Readonly, true)
    .annotate(Rerunnable, true)

/** A tool that acts on the page. */
const act = <const Name extends string, const Fields extends Schema.Struct.Fields>(name: Name, description: string, fields: Fields) =>
  Tool.make(name, { description, parameters: Schema.Struct(fields), success: DesktopContent })

export const Navigate = act(
  "navigate",
  "Load an address in the task's browser, opening it if it isn't open: a full URL, a host (example.com), or a port on this machine (5173 opens http://localhost:5173). Or go back, forward, or reload. Waits for the page to load, then says its address and title.",
  {
    url: opt(Schema.String.annotate({ description: "Where to go." })),
    go: opt(Schema.Literals(["back", "forward", "reload"]).annotate({ description: "Instead of an address." })),
  },
)

export const Snapshot = look(
  "snapshot",
  "The page as an outline of what's on it (headings, links, buttons, fields with their values, text), each thing with a ref for click, type, hover and scroll. Take a new one after the page changes: refs from an old one may be gone.",
  {},
)

export const Click = act(
  "click",
  "Click a thing on the page by its ref (or at x, y in the page's CSS pixels, from a screenshot). If that starts loading a page, waits for it.",
  {
    ref: opt(ref),
    x: opt(Schema.Finite),
    y: opt(Schema.Finite),
    double: opt(Schema.Boolean.annotate({ description: "A double click." })),
  },
)

export const Type = act(
  "type",
  "Type text into a field by its ref (focused first), or wherever the focus is. `clear` empties the field first; `submit` presses Enter after.",
  { text: Schema.String, ref: opt(ref), clear: opt(Schema.Boolean), submit: opt(Schema.Boolean) },
)

export const Press = act(
  "press",
  "Press a key or a shortcut where the focus is: Enter, Tab, Escape, Backspace, ArrowDown, PageDown, a, Control+a, Shift+Tab, Meta+k.",
  { key: Schema.String },
)

export const Hover = act("hover", "Move the mouse over a thing on the page by its ref (menus and tooltips that open on hover).", { ref })

export const Scroll = act("scroll", "Scroll a thing into view by its ref, or the page by dy (down, in CSS pixels; negative goes up) and dx.", {
  ref: opt(ref),
  dy: opt(Schema.Finite),
  dx: opt(Schema.Finite),
})

export const Evaluate = act(
  "evaluate",
  "Run a JavaScript expression in the page and get what it comes to (as JSON; a promise is waited for), or what it threw. For what the outline doesn't show: computed styles, console state, the page's own data.",
  { expression: Schema.String },
)

export const Screenshot = look("screenshot", "A picture of what the page shows now (PNG), with its address and title.", {})

export const Close = act("close", "Close the task's headless browser page (the desktop app's pane is the user's to close).", {})

/** The tools, in `tools/list`'s order. */
export const BROWSER_TOOLS = [Navigate, Snapshot, Click, Type, Press, Hover, Scroll, Evaluate, Screenshot, Close] as const
