import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { NotFound } from "../errors.ts"
import { TaskId } from "../ids.ts"
import { Auth, RequiredScope } from "../session.ts"

// HE-62: each task's web browser, which its agent drives with the `browser` MCP server and the board shows beside the
// thread. `browser.open` gives a ticket for the socket `/api/browser/<ticket>` (single use, for a minute), as
// `terminal.open` does, in one of two roles:
//
// - `view`: the browser streamed from the host's headless Chrome. The server sends each frame of the page as a binary
//   message (a JPEG) and waits for the client's `ack` before the next, and `BrowserServerFrame`s as JSON; the client
//   sends `BrowserClientFrame`s (its size, the mouse, keys, text, addresses) as JSON. Query: `width`, `height` (the
//   page's size in CSS pixels), `url` (where a browser the task doesn't have yet starts).
// - `desktop`: the desktop app's own browser pane (a <webview>) for the task, given to the server to drive. The server
//   sends DevTools protocol commands (`{id, method, params}`) as JSON; the client answers each with what the
//   webview's debugger said (`{id, result}` or `{id, error: {message}}`) and sends its events (`{method, params}`).

export const BrowserRole = Schema.Literals(["view", "desktop"])
export type BrowserRole = typeof BrowserRole.Type

/** What opens the browser's socket once (`/api/browser/<ticket>`), within a minute. */
export const BrowserTicket = Schema.Struct({ ticket: Schema.String })
export interface BrowserTicket extends Schema.Schema.Type<typeof BrowserTicket> {}

/** What the page is: its address and title, and whether it is loading. */
export const BrowserPage = Schema.Struct({ url: Schema.String, title: Schema.String, loading: Schema.Boolean })
export type BrowserPage = typeof BrowserPage.Type

/** The server's JSON frames to a viewer. */
export const BrowserServerFrame = Schema.Union([
  /** The page changed (address, title, loading). */
  Schema.Struct({ type: Schema.Literal("page"), url: Schema.String, title: Schema.String, loading: Schema.Boolean }),
  /** The size the frames are of, in CSS pixels: the client maps its pointer onto it. */
  Schema.Struct({ type: Schema.Literal("viewport"), width: Schema.Int, height: Schema.Int }),
  /** The headless browser is being downloaded (bytes so far, of `total`), or unpacked. */
  Schema.Struct({ type: Schema.Literal("installing"), phase: Schema.String, received: Schema.Finite, total: Schema.Finite }),
  /** The task's browser is the desktop app's pane now, so it isn't streamed: the socket closes. */
  Schema.Struct({ type: Schema.Literal("desktop") }),
  /** Something went wrong that the viewer should show (the browser couldn't start, a page didn't load). */
  Schema.Struct({ type: Schema.Literal("error"), message: Schema.String }),
])
export type BrowserServerFrame = typeof BrowserServerFrame.Type

/** The mouse buttons as CDP names them. */
export const MouseButton = Schema.Literals(["none", "left", "middle", "right"])

/** A viewer's JSON frames. `modifiers` is CDP's bit field (Alt 1, Control 2, Meta 4, Shift 8). */
export const BrowserClientFrame = Schema.Union([
  /** The last frame has been drawn: the next may come. */
  Schema.Struct({ type: Schema.Literal("ack") }),
  /** The viewer's size changed: the page takes it (in CSS pixels). */
  Schema.Struct({ type: Schema.Literal("resize"), width: Schema.Int, height: Schema.Int }),
  Schema.Struct({
    type: Schema.Literal("mouse"),
    action: Schema.Literals(["down", "up", "move"]),
    x: Schema.Finite,
    y: Schema.Finite,
    button: MouseButton,
    buttons: Schema.Int,
    clickCount: Schema.Int,
    modifiers: Schema.Int,
  }),
  Schema.Struct({ type: Schema.Literal("wheel"), x: Schema.Finite, y: Schema.Finite, dx: Schema.Finite, dy: Schema.Finite, modifiers: Schema.Int }),
  Schema.Struct({
    type: Schema.Literal("key"),
    action: Schema.Literals(["down", "up"]),
    key: Schema.String,
    code: Schema.String,
    keyCode: Schema.Int,
    text: Schema.optional(Schema.String),
    modifiers: Schema.Int,
  }),
  /** Text to put in (a paste, or what an input method composed). */
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("navigate"), url: Schema.String }),
  Schema.Struct({ type: Schema.Literal("go"), go: Schema.Literals(["back", "forward", "reload", "stop"]) }),
])
export type BrowserClientFrame = typeof BrowserClientFrame.Type

export class BrowserRpcs extends RpcGroup.make(
  /** A ticket for the task's browser's socket, as a viewer of its stream or as the desktop app's pane. */
  Rpc.make("browser.open", { payload: { task_id: TaskId, role: BrowserRole }, success: BrowserTicket, error: NotFound }).annotate(RequiredScope, "operate"),
  /** The task's browser's page, if it has one open. */
  Rpc.make("browser.status", { payload: { task_id: TaskId }, success: Schema.NullOr(BrowserPage), error: NotFound }).annotate(RequiredScope, "read"),
).middleware(Auth) {}
