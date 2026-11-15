import { Effect, Option, Schema } from "effect"
import type { Invalid, NotFound, Space, Unavailable } from "@huntaway/contracts"
import { CuaResult, forAgent, text } from "../desktop/cua.ts"
import type { DesktopContent } from "../desktop/cua.ts"
import { McpHooks } from "../mcp/McpHooks.ts"
import { localToolHandler, McpServers } from "../mcp/McpServers.ts"
import type { RegisteredTool } from "../mcp/McpServers.ts"
import type { LocalCaller } from "../mcp/tool.ts"
import { Identity } from "../platform/Identity.ts"
import { Listening } from "../platform/Listening.ts"
import { HostSettings } from "../settings/HostSettings.ts"
import { driverTools, HIDDEN_TOOLS, readOnly, toolDetail, toolsSummary } from "./driverMcp.ts"
import type { DriverAnswer } from "./driverMcp.ts"
import { Spaces } from "./Spaces.ts"
import { CreateSpace, DeleteSpace, ListSpaces, SpaceBash, SpaceCallTool, SpaceListTools, SpaceView, StartSpace, StopSpace } from "./tools.ts"

// The `spaces` server's handlers (HE-37): this host's Spaces for its agents, as Cua Spaces' MCP tools give them. What
// the server adds to `Spaces`:
//
// - It is served while the host's page has it on and Docker answers (`Spaces.toolsAvailable`, asked at each launch).
//   Turned off since the run started, every call refuses.
// - A Space is named by id or name (`Spaces.find`).
// - Reviewers and threads in plan mode only look: `list_spaces`, `space_list_tools`, `space_view` (a link that only
//   watches) and the driver's tools that say they only look. Checked per call, as the desktop's are.
// - `delete_space` asks the user first, whatever the thread's mode (`McpHooks.askRule` with no rule).
// - `space_bash`'s output is capped; the driver's results reach the agent as `desktop`'s do (`forAgent`: text, images
//   as MCP image content, and the structured fields as a line of JSON).
//
// The calls come through `ToolCalls` (recorded, at most once per call id, refused for a run that has ended). Driver
// actions aren't journaled as the host desktop's are (`DesktopOpRepo`): a Space is its agents' own, with no one at it
// to share it with, and `mcp_calls` keeps what each call was given and answered.

/** What is kept of each of a command's streams, from its end. */
export const OUTPUT_MAX = 30_000

const PrettyJson = Schema.fromJsonString(Schema.Unknown, { space: 2 })
const pretty = (value: unknown) => Option.getOrElse(Schema.encodeOption(PrettyJson)(value), () => "{}")
const decodeResult = Schema.decodeUnknownOption(CuaResult)

/** A Space as the agent is told of it. */
const shown = (s: Space) => ({ id: s.id, name: s.name, state: s.state, detail: s.detail, created_at: s.created_at })

/** The end of a stream's text, saying how much was left out. */
export const tail = (s: string, max = OUTPUT_MAX): string => (s.length <= max ? s : `[… ${s.length - max} characters left out …]\n${s.slice(-max)}`)

/** A Space's state, with what to do about one that didn't come up. */
const told = (s: Space, verb: string) =>
  s.state === "running"
    ? text(`${verb} ${s.name} (${s.id}).\n\n${pretty(shown(s))}`)
    : text(`${s.name} (${s.id}) is ${s.state}${s.detail === null ? "" : `: ${s.detail}`}.\n\n${pretty(shown(s))}`, s.state === "failed")

/** The driver's answer, or its failure as an error result. */
const driven = (a: DriverAnswer): DesktopContent => {
  if ("error" in a) return text(a.error, true)
  return Option.match(decodeResult(a.result), { onNone: () => text("Cua Driver's answer didn't parse.", true), onSome: forAgent })
}

/** Why the caller may only look: a reviewer, or a thread in plan mode. */
const onlyLooks = (caller: LocalCaller, tool: string): string | null => {
  if (caller.task.kind === "review") return `${tool} isn't available to reviewers: they can only look at Spaces.`
  if (caller.mode === "plan") {
    return `${tool} isn't available in plan mode: until the user approves your plan (present it with ExitPlanMode), you can only look at Spaces.`
  }
  return null
}

/** The `spaces` server's tools with their handlers, and its gate. */
export const spacesTools = Effect.gen(function* () {
  const spaces = yield* Spaces
  const hooks = yield* McpHooks
  const settings = yield* HostSettings
  const listening = yield* Listening
  const { hostName } = yield* Identity

  yield* (yield* McpServers).serveWhen("spaces", spaces.toolsAvailable)

  const OFF = `Spaces have been turned off for agents on ${hostName}. Don't try to work around it: tell the user if the task needs them.`

  /** A Space's failure as the agent is told it. */
  const said = (e: NotFound | Unavailable | Invalid): DesktopContent =>
    e._tag === "NotFound"
      ? text(e.what === "space" ? `There's no Space ${e.id} on ${hostName}: list_spaces shows them.` : `No ${e.what} ${e.id}.`, true)
      : text(e.reason, true)

  /** A handler's body, refused while Spaces are off for agents, with the Spaces' failures told as error results. */
  const answer = <R>(body: Effect.Effect<DesktopContent, NotFound | Unavailable | Invalid, R>) =>
    Effect.gen(function* () {
      if (!(yield* spaces.toolsEnabled)) return text(OFF, true)
      return yield* body
    }).pipe(Effect.catch((e) => Effect.succeed(said(e))))

  /** `body` unless the caller may only look. */
  const acting = <R>(caller: LocalCaller, tool: string, body: Effect.Effect<DesktopContent, NotFound | Unavailable | Invalid, R>) => {
    const why = onlyLooks(caller, tool)
    return answer(why === null ? body : Effect.succeed(text(why, true)))
  }

  const toolsOf = (id: string, caller: LocalCaller) =>
    Effect.map(spaces.driver(id, caller.task.id, "tools/list", {}), (a) => ("error" in a ? { error: a.error } : { tools: driverTools(a.result) }))

  const create = (name: string, reuse: boolean) =>
    Effect.gen(function* () {
      if (reuse) {
        // None of that name is the one case that makes one; a name several Spaces share is refused with their ids.
        const found = yield* spaces.find(name).pipe(
          Effect.asSome,
          Effect.catchTag("NotFound", () => Effect.succeedNone),
        )
        if (Option.isSome(found)) {
          const s = found.value
          // One that failed before it had a container (pulling or building its image, `docker run`) has nothing to
          // start: it's dropped and made again.
          const kept =
            s.state === "stopped" || s.state === "failed"
              ? yield* spaces.start(s.id).pipe(
                  Effect.as(true),
                  Effect.catchTag("NotFound", () => Effect.as(spaces.remove(s.id), false)),
                )
              : true
          if (kept) return told(yield* spaces.settled(s.id), "Using the Space")
        }
      }
      const made = yield* spaces.create({ name })
      return told(yield* spaces.settled(made.id), "Made the Space")
    })

  const remove = (caller: LocalCaller, ref: string) =>
    Effect.gen(function* () {
      const s = yield* spaces.find(ref)
      const tool = `mcp__spaces__${DeleteSpace.name}`
      const asked = yield* Effect.result(hooks.askRule(caller, tool, { space: s.id, name: s.name }, null))
      if (asked._tag === "Failure") return text(`${s.name} wasn't deleted: ${asked.failure.message}`, true)
      yield* spaces.remove(s.id)
      return text(`Deleted the Space ${s.name} (${s.id}).`)
    })

  const bash = (ref: string, command: string, timeout: number | undefined) =>
    Effect.gen(function* () {
      const s = yield* spaces.find(ref)
      const seconds = timeout ?? 120
      const r = yield* spaces.bash(s.id, command, seconds)
      const out = [`exit code ${r.code}${r.code === 124 ? " (timed out)" : ""}`]
      if (r.stdout !== "") out.push(`stdout:\n${tail(r.stdout)}`)
      if (r.stderr !== "") out.push(`stderr:\n${tail(r.stderr)}`)
      return text(out.join("\n\n"), r.code !== 0)
    })

  const listTools = (caller: LocalCaller, ref: string, tool: string | undefined) =>
    Effect.gen(function* () {
      const s = yield* spaces.find(ref)
      const listed = yield* toolsOf(s.id, caller)
      if ("error" in listed) return text(listed.error, true)
      if (tool === undefined) return text(`Cua Driver's tools in ${s.name}:\n${toolsSummary(listed.tools)}`)
      const one = listed.tools.find((t) => t.name === tool)
      return one === undefined ? text(`${s.name}'s Cua Driver has no tool ${tool}: space_list_tools lists them.`, true) : text(toolDetail(one))
    })

  const call = (caller: LocalCaller, ref: string, tool: string, args: Readonly<Record<string, unknown>>) =>
    Effect.gen(function* () {
      const s = yield* spaces.find(ref)
      if (HIDDEN_TOOLS.has(tool)) return text(`${tool} isn't one of the desktop's tools: use the spaces server's own.`, true)
      // A caller that only looks may call the driver's tools that say they only look.
      const why = onlyLooks(caller, tool)
      if (why !== null) {
        const listed = yield* toolsOf(s.id, caller)
        if ("error" in listed) return text(listed.error, true)
        const found = listed.tools.find((t) => t.name === tool)
        if (found === undefined || !readOnly(found)) return text(why, true)
      }
      return driven(yield* spaces.driver(s.id, caller.task.id, "tools/call", { name: tool, arguments: args }))
    })

  const view = (caller: LocalCaller, ref: string) =>
    Effect.gen(function* () {
      const s = yield* spaces.find(ref)
      const v = yield* spaces.view(s.id, onlyLooks(caller, "space_view") === null)
      const set = (yield* settings.get).public_url?.trim() ?? ""
      const board = (set === "" ? `http://127.0.0.1:${yield* listening.port}` : set).replace(/\/+$/u, "")
      return text(`${board}${v.relay_path}${v.fragment}\n\nThe link opens ${s.name}'s desktop until ${v.expires_at}.`)
    })

  const all: ReadonlyArray<RegisteredTool> = [
    localToolHandler(ListSpaces, () => answer(Effect.map(spaces.status, (st) => text(pretty(st.spaces.map(shown)))))),
    localToolHandler(CreateSpace, (a, caller) => acting(caller, CreateSpace.name, create(a.name, a.reuse ?? true))),
    localToolHandler(StartSpace, (a, caller) =>
      acting(
        caller,
        StartSpace.name,
        Effect.gen(function* () {
          const s = yield* spaces.find(a.space)
          yield* spaces.start(s.id)
          return told(yield* spaces.settled(s.id), "Started the Space")
        }),
      ),
    ),
    localToolHandler(StopSpace, (a, caller) =>
      acting(
        caller,
        StopSpace.name,
        Effect.gen(function* () {
          const s = yield* spaces.find(a.space)
          return told(yield* spaces.stop(s.id), "Stopped the Space")
        }),
      ),
    ),
    localToolHandler(DeleteSpace, (a, caller) => acting(caller, DeleteSpace.name, remove(caller, a.space))),
    localToolHandler(SpaceBash, (a, caller) => acting(caller, SpaceBash.name, bash(a.space, a.command, a.timeout))),
    localToolHandler(SpaceListTools, (a, caller) => answer(listTools(caller, a.space, a.tool))),
    localToolHandler(SpaceCallTool, (a, caller) => answer(call(caller, a.space, a.tool, a.args ?? {}))),
    localToolHandler(SpaceView, (a, caller) => answer(view(caller, a.space))),
  ]
  return all
})

/** The `spaces` server's tools, registered (`Main.ts`, above the MCP area: spaces is below mcp in the dependency order). */
export const SpacesTools = McpServers.register("spaces", spacesTools)
