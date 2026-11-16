import { Schema } from "effect"
import { Tool } from "effect/ai"
import { DesktopContent } from "../desktop/cua.ts"
import { Rerunnable } from "../mcp/tool.ts"
import { BASH_MAX_SECONDS } from "./Spaces.ts"

// The `spaces` server's tools (HE-37), after Cua Spaces' own (https://cua.ai/docs/spaces/guides/use-from-an-agent):
// make or reuse a Space on this host, run commands in it, and drive its desktop through its own Cua Driver. The ones
// that only look say so (`readOnlyHint`: Codex runs them without asking; Claude runs have them in `--allowedTools`)
// and may run again after a restart; the others ask, as any tool does. `delete_space` and `space_sign_in` ask the user themselves.

const space = Schema.String.annotate({ description: "The Space's id, or its name (from `list_spaces`)." })
const opt = Schema.optionalKey

/** A tool that only looks. */
const look = <const Name extends string, const Fields extends Schema.Struct.Fields>(name: Name, description: string, fields: Fields) =>
  Tool.make(name, { description, parameters: Schema.Struct(fields), success: DesktopContent })
    .annotate(Tool.Readonly, true)
    .annotate(Rerunnable, true)

/** A tool that changes something. */
const change = <const Name extends string, const Fields extends Schema.Struct.Fields>(name: Name, description: string, fields: Fields) =>
  Tool.make(name, { description, parameters: Schema.Struct(fields), success: DesktopContent })

export const ListSpaces = look(
  "list_spaces",
  "This host's Spaces (Linux desktops in Docker): id, name, state (preparing, running, stopped, failed) and detail.",
  {},
)

export const CreateSpace = change(
  "create_space",
  "Make a Space, a Linux desktop (Ubuntu, XFCE, Firefox, Chromium) in Docker on this host, and wait until it's running. The first one on a host downloads and builds its image, which takes minutes; later ones start in seconds. With `reuse` (the default), a Space of that name already here is used instead, started if it's stopped.",
  {
    name: Schema.String.annotate({ description: "What the board shows it as, up to 60 characters." }),
    reuse: opt(Schema.Boolean.annotate({ description: "Use a Space of that name if there is one (default true)." })),
  },
)

export const StartSpace = change("start_space", "Start a stopped Space and wait until it's running.", { space })

export const StopSpace = change("stop_space", "Stop a Space. Its files stay; `start_space` brings it back.", { space })

export const DeleteSpace = change("delete_space", "Delete a Space and everything in it. Asks the user first.", { space })

export const SpaceBash = change(
  "space_bash",
  `Run a shell command (bash -l) in a running Space, as its desktop user \`cua\` in their home folder, with the desktop on DISPLAY. Returns the exit code and output (the end of it, when it's long). GUI apps started here should be left running with \`nohup … &\`.`,
  {
    space,
    command: Schema.String,
    timeout: opt(Schema.Int.annotate({ description: `Seconds before it's stopped (default 120, at most ${BASH_MAX_SECONDS}).` })),
  },
)

export const SpaceListTools = look(
  "space_list_tools",
  "The tools of a running Space's Cua Driver, one line each (name, whether it only looks, its arguments, what it does); with `tool`, that tool's full description and argument schema. Call them with `space_call_tool`.",
  { space, tool: opt(Schema.String.annotate({ description: "One tool to describe in full." })) },
)

export const SpaceCallTool = change(
  "space_call_tool",
  'Call one of a running Space\'s Cua Driver tools (see `space_list_tools`) with its arguments, e.g. {"tool": "get_desktop_state"} for a screenshot, {"tool": "list_windows"}, {"tool": "get_window_state", "args": {"pid": 226, "window_id": 12582931, "query": "Save"}}, {"tool": "run_steps", "args": {"pid": 226, "window_id": 12582931, "steps": [{"tool": "click", "args": {"x": 120, "y": 40}}]}}. Returns what the driver does: text, images and its structured fields.',
  {
    space,
    tool: Schema.String,
    args: opt(Schema.Record(Schema.String, Schema.Unknown).annotate({ description: "The tool's arguments." })),
  },
)

export const SpaceView = look(
  "space_view",
  "A link for the user to watch and use a running Space's desktop in their browser, good for an hour. Give it to the user; don't open it yourself.",
  { space },
)

export const SpaceSignIn = change(
  "space_sign_in",
  "Sign in to a website in a running Space's browser with a username and password the user saved on the board (HE-48), after the user approves it. You never see the password: the board types it into the page itself, only on the saved site's exact origin, and submits the form. Without `target_id` and `tab_id`, it opens `url` in a Chromium of its own (the profile `huntaway-sign-in`, which keeps the session: open it again with `browser_prepare` and `profile: {mode: \"isolated_named\", name: \"huntaway-sign-in\"}`); with them (and `session`, from your own `get_browser_state`), it fills that tab, which must already show the sign-in page. Returns the tab it filled and where it went. Never ask the user for a password; if none is saved for the site, ask them to add one in Settings → Profiles → Sign-ins. Two-factor codes are the user's to enter, in the Space's viewer.",
  {
    space,
    url: Schema.String.annotate({ description: "The site's sign-in page (http or https): its origin picks the saved sign-in." }),
    sign_in: opt(Schema.String.annotate({ description: "Which saved sign-in, by id, when the site has several (the answer lists them)." })),
    session: opt(Schema.String.annotate({ description: "Your Cua Driver session label for the tab, if you used one." })),
    target_id: opt(Schema.String.annotate({ description: "Your tab's browser target, from get_browser_state." })),
    tab_id: opt(Schema.String.annotate({ description: "Your tab, from get_browser_state." })),
  },
)

/** The tools, in `tools/list`'s order. */
export const SPACES_TOOLS = [
  ListSpaces,
  CreateSpace,
  StartSpace,
  StopSpace,
  DeleteSpace,
  SpaceBash,
  SpaceListTools,
  SpaceCallTool,
  SpaceView,
  SpaceSignIn,
] as const
