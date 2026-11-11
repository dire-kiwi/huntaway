import { Clock, Effect, Option, Schema } from "effect"
import { SecureRandom } from "effect/crypto"
import { threadKindOf } from "@huntaway/contracts"
import type { Task } from "@huntaway/contracts"
import { keyPrefix } from "../agents/prompts/context.ts"
import { truncate } from "../git/paths.ts"
import { McpServers, toolHandler } from "../mcp/McpServers.ts"
import type { RegisteredTool } from "../mcp/McpServers.ts"
import type { McpCaller } from "../mcp/tool.ts"
import { nowTimestamp } from "../platform/columns.ts"
import { Identity } from "../platform/Identity.ts"
import { ProjectRepo } from "../projects/ProjectRepo.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { CuaDriver } from "./CuaDriver.ts"
import type { DriverError } from "./CuaDriver.ts"
import { actSummary, forAgent, intOrNull, quote, resultText, text } from "./cua.ts"
import type { CuaResult, DesktopContent } from "./cua.ts"
import { Desktop } from "./Desktop.ts"
import { DesktopClaims } from "./DesktopClaims.ts"
import { DesktopOpRepo } from "./DesktopOpRepo.ts"
import { Act, Apps, Clipboard, Health, Launch, OpStatus, Read, Screen, Verify, Windows, Zoom } from "./tools.ts"

// The `desktop` server's handlers (huntaway's mcp/desktop_mcp.ts; docs/plan/inventory/03-mcp.md 2.12): the host's
// desktop, for agents, through its Cua Driver. What the server adds to the driver:
//
// - One session per task (`huntaway-<key>`), which Cua's own state (cursors, snapshots) is kept under.
// - A locked screen stops everything but `health` and `op_status`: nobody's there, and the agent mustn't unlock it.
// - One task drives the desktop at a time (`DesktopClaims`): tasks' agents share one keyboard, pointer and focus.
// - Actions are journaled (`DesktopOpRepo`). One the agent names with `op_id` runs at most once, so after a lost answer
//   it asks `op_status` instead of acting again, and the board shows what each task did.
// - Computer use turned off since the run started: every tool but `health` and `op_status` refuses, and nothing starts
//   the driver again. Reviewers and threads in plan mode only look (checked per call: a run's tool list is fixed at
//   launch while its mode changes).
//
// The calls come through `ToolCalls` (recorded, at most once per call id, refused for a run that has ended). A refusal
// or a driver's failure is a text result marked as an error, as the old server answered.

const PrettyJson = Schema.fromJsonString(Schema.Unknown, { space: 2 })
const pretty = (value: unknown) => Option.getOrElse(Schema.encodeOption(PrettyJson)(value), () => "{}")
const quoted = (s: string) => Option.getOrElse(Schema.encodeOption(Schema.fromJsonString(Schema.String))(s), () => s)

/** `a`'s keys in `keys` that are set. */
const pick = (a: Readonly<Record<string, unknown>>, keys: ReadonlyArray<string>): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const k of keys) if (a[k] !== undefined && a[k] !== null) out[k] = a[k]
  return out
}

/** A refusal the agent is told as the tool's (error) result. */
class Refused extends Schema.TaggedError<Refused, { readonly brand: unique symbol }>()("Refused", { text: Schema.String }) {}

/** Why the caller may not act on the desktop now: a reviewer only looks, and so does a thread in plan mode. */
const refused = (caller: McpCaller, tool: string): string | null => {
  if (caller.task.kind === "review") return `${tool} isn't available to reviewers: they can only look at the desktop.`
  if (caller.mode === "plan") {
    return `${tool} isn't available in plan mode: until the user approves your plan (present it with ExitPlanMode), you can only look at the desktop.`
  }
  return null
}

/** A handler's body, its refusals and the driver's failures told as error results. */
const answer = <R>(body: Effect.Effect<DesktopContent, Refused | DriverError, R>) =>
  body.pipe(Effect.catch((e) => Effect.succeed(text(e._tag === "Refused" ? e.text : e.reason, true))))

/** The desktop server's tools with their handlers, and its gate: runs get it while computer use is on and there's a driver. */
export const desktopTools = Effect.gen(function* () {
  const driver = yield* CuaDriver
  const desktop = yield* Desktop
  const claims = yield* DesktopClaims
  const opRepo = yield* DesktopOpRepo
  const taskRepo = yield* TaskRepo
  const projectRepo = yield* ProjectRepo
  const identity = yield* Identity
  const random = yield* SecureRandom.SecureRandom
  const host = identity.hostName

  yield* (yield* McpServers).serveWhen("desktop", desktop.available)

  /** What a call is told while computer use is off for the host. */
  const OFF = `Computer use has been turned off on ${host}, so its desktop can't be used. Don't try to work around it: tell the user if the task needs it.`

  /** A task's key, e.g. HA-12. */
  const keyOf = Effect.fnUntraced(function* (task: Task) {
    const project = task.project_id === null ? null : Option.getOrNull(yield* projectRepo.get(task.project_id))
    return `${keyPrefix(threadKindOf(task), task, project)}-${task.number}`
  })

  /** The session a task's calls are kept under. */
  const sessionOf = (caller: McpCaller) => Effect.map(keyOf(caller.task), (key) => `huntaway-${key}`)

  /** Call the driver's `tool`, with the task's session if the tool takes one: its result as it is. */
  const driveRaw = Effect.fnUntraced(function* (caller: McpCaller, tool: string, args: Readonly<Record<string, unknown>>) {
    yield* driver.start
    const withSession = (yield* driver.has(tool, "session")) ? { ...args, session: yield* sessionOf(caller) } : args
    return yield* driver.call(tool, withSession)
  })

  const drive = (caller: McpCaller, tool: string, args: Readonly<Record<string, unknown>>) => Effect.map(driveRaw(caller, tool, args), forAgent)

  /** The viewer shows the window the agent last looked at or acted on. */
  const noteTarget = (caller: McpCaller, a: { readonly pid?: number | undefined; readonly window_id?: number | undefined }) =>
    a.pid === undefined ? Effect.void : claims.setTarget(caller.task.id, a.pid, a.window_id ?? null)

  /** Refuse on a locked screen. */
  const checkLock = Effect.flatMap(driver.locked, (locked) =>
    locked === true
      ? Effect.fail(
          new Refused({
            text: `The screen of ${host} is locked, so its desktop can't be used until someone unlocks it. Don't try to unlock it: tell the user.`,
          }),
        )
      : Effect.void,
  )

  /** Refuse when another task is driving the desktop; else this task holds it. */
  const checkClaim = (caller: McpCaller) =>
    Effect.flatMap(claims.claim(caller.task.id), (h) =>
      h === null
        ? Effect.void
        : Effect.gen(function* () {
            const t = yield* taskRepo.get(h.task_id)
            const who = t === null ? "another task" : `${yield* keyOf(t)} (${quoted(truncate(t.title, 60))})`
            const ago = Math.round(((yield* Clock.currentTimeMillis) - h.at) / 1000)
            return yield* new Refused({
              text: `${who} is using this desktop (its last action was ${ago}s ago), and only one task drives it at a time. Wait a couple of minutes and try again, or tell the user.`,
            })
          }),
    )

  /** A tool that looks: refused while computer use is off or the screen is locked. */
  const reading = <R>(body: Effect.Effect<DesktopContent, Refused | DriverError, R>) =>
    answer(
      Effect.gen(function* () {
        // Turned off since the run started (the host's page stops the driver then): nothing starts it again.
        if (!(yield* desktop.enabled)) return text(OFF, true)
        yield* checkLock
        return yield* body
      }),
    )

  /** An action: refused off, for reviewers and in plan mode; then claimed, journaled, and run once per op_id. */
  const writing = (
    caller: McpCaller,
    name: "act" | "launch" | "clipboard",
    a: Readonly<Record<string, unknown>> & { readonly op_id?: string | undefined },
    prepare: Effect.Effect<{ readonly tool: string; readonly args: Readonly<Record<string, unknown>>; readonly summary: string }, Refused | DriverError>,
  ) =>
    answer(
      Effect.gen(function* () {
        if (!(yield* desktop.enabled)) return text(OFF, true)
        const why = refused(caller, name)
        if (why !== null) return text(why, true)
        const opId = a.op_id !== undefined && a.op_id !== "" ? a.op_id : null
        const ran = (status: string, result: string | null) =>
          text(
            `op ${opId} already ran (${status}${status === "interrupted" ? ": whether it took effect isn't known; look before acting again" : ""}), so it wasn't run again.` +
              (result !== null && result !== "" ? `\n\n${result}` : ""),
            status === "failed",
          )
        if (opId !== null) {
          const done = yield* opRepo.find(caller.task.id, opId)
          if (done !== null) return ran(done.status, done.result)
        }
        yield* checkLock
        yield* checkClaim(caller)
        const { tool, args, summary } = yield* prepare
        const op = yield* opRepo.start({
          id: yield* random.uuidV4(),
          task_id: caller.task.id,
          run_id: caller.run.id,
          op_id: opId,
          tool: name,
          summary,
          args: a,
          now: yield* nowTimestamp,
        })
        // The same op_id from another call: it's running it, or has.
        if (!op.started)
          return op.op.status === "running" ? text(`op ${opId} is already running; call op_status with it later.`, true) : ran(op.op.status, op.op.result)
        const result = yield* driveRaw(caller, tool, args).pipe(
          Effect.tapError((e) => Effect.flatMap(nowTimestamp, (now) => opRepo.finish(op.op.id, "failed", e.reason, now))),
        )
        const told = forAgent(result)
        yield* opRepo.finish(op.op.id, result.isError === true ? "failed" : "ok", resultText(told), yield* nowTimestamp)
        if (name === "launch") yield* noteLaunched(caller, result)
        return told
      }),
    )

  /** A launched app's window is the one the viewer shows. */
  const noteLaunched = (caller: McpCaller, result: CuaResult) => {
    const sc = result.structuredContent
    const fields = typeof sc === "object" && sc !== null && !Array.isArray(sc) ? new Map(Object.entries(sc)) : new Map<string, unknown>()
    const pid = intOrNull(fields.get("pid"))
    const windows = fields.get("windows")
    const first: unknown = Array.isArray(windows) ? windows[0] : undefined
    const windowId = typeof first === "object" && first !== null && "window_id" in first ? intOrNull(first.window_id) : null
    return pid === null ? Effect.void : claims.setTarget(caller.task.id, pid, windowId)
  }

  const health = (caller: McpCaller) =>
    Effect.gen(function* () {
      const found = yield* driver.find
      const on = yield* desktop.enabled
      let error: string | null = on ? null : OFF
      // Off, it only says so: the driver isn't started for it.
      if (found !== null && on)
        error = yield* driver.start.pipe(
          Effect.as(null),
          Effect.catchTag("DriverError", (e) => Effect.succeed(e.reason)),
        )
      const h = yield* claims.holder
      const holder = h === null ? null : yield* taskRepo.get(h.task_id)
      const status = yield* driver.status
      const out: Record<string, unknown> = {
        host,
        platform: process.platform,
        session: yield* driver.session,
        driver: found === null ? null : { path: found.path, version: status.version ?? found.version, state: status.state, error: error ?? status.error },
        locked: yield* driver.locked,
        in_use_by: holder !== null && holder.id !== caller.task.id ? yield* keyOf(holder) : null,
        you: yield* sessionOf(caller),
      }
      if (yield* driver.has("check_permissions")) {
        out["permissions"] = yield* drive(caller, "check_permissions", {}).pipe(
          Effect.map(resultText),
          Effect.catchTag("DriverError", (e) => Effect.succeed(`couldn't check: ${e.reason}`)),
        )
      }
      return text(pretty(out))
    })

  const opStatus = (caller: McpCaller, opId: string) =>
    Effect.gen(function* () {
      const op = yield* opRepo.find(caller.task.id, opId)
      if (op === null) return text(`No op ${quoted(opId)} in this task: it never started, so it didn't run.`)
      const how =
        op.status === "interrupted" ? " (the board's server stopped while it ran: whether it took effect isn't known, so look before acting again)" : ""
      return text(`op ${op.op_id}: ${op.tool} ${op.summary}: ${op.status}${how}${op.result !== null && op.result !== "" ? `\n\n${op.result}` : ""}`)
    })

  const all: ReadonlyArray<RegisteredTool> = [
    toolHandler(Health, (_, caller) => health(caller)),
    toolHandler(Apps, (_, caller) => reading(drive(caller, "list_apps", {}))),
    toolHandler(Windows, (a, caller) => reading(drive(caller, "list_windows", pick(a, ["pid", "app", "on_screen_only"])))),
    toolHandler(Read, (a, caller) =>
      reading(
        Effect.andThen(
          noteTarget(caller, a),
          drive(caller, "get_window_state", {
            include_screenshot: false,
            ...pick(a, ["pid", "window_id", "query", "since", "max_elements", "max_depth", "include_screenshot"]),
          }),
        ),
      ),
    ),
    toolHandler(Screen, (a, caller) =>
      reading(
        Effect.gen(function* () {
          if (a.pid === undefined) return yield* drive(caller, "get_desktop_state", {})
          yield* noteTarget(caller, a)
          yield* driver.start
          const args: Record<string, unknown> = { ...pick(a, ["pid", "window_id"]), include_screenshot: true }
          // A look that keeps the tree's tokens valid, where the driver can.
          if (yield* driver.has("get_window_state", "include_accessibility_tree")) args["include_accessibility_tree"] = false
          return yield* drive(caller, "get_window_state", args)
        }),
      ),
    ),
    toolHandler(Zoom, (a, caller) =>
      reading(Effect.andThen(noteTarget(caller, a), drive(caller, "zoom", pick(a, ["pid", "window_id", "x1", "y1", "x2", "y2"])))),
    ),
    toolHandler(Verify, (a, caller) =>
      reading(Effect.andThen(noteTarget(caller, a), drive(caller, "verify_state", pick(a, ["pid", "window_id", "expect", "include_screenshot"])))),
    ),
    toolHandler(OpStatus, (a, caller) => opStatus(caller, a.op_id)),
    toolHandler(Act, (a, caller) =>
      writing(
        caller,
        "act",
        a,
        Effect.gen(function* () {
          if (a.steps.length === 0) return yield* new Refused({ text: "act needs steps: [{tool, args}, …]" })
          yield* noteTarget(caller, a)
          const args: Record<string, unknown> = { observe: {}, ...pick(a, ["pid", "window_id", "steps", "observe", "delivery_mode", "delay_ms"]) }
          if (args["observe"] === false) delete args["observe"]
          return { tool: "run_steps", args, summary: actSummary(a.steps) }
        }),
      ),
    ),
    toolHandler(Launch, (a, caller) =>
      writing(
        caller,
        "launch",
        a,
        Effect.succeed({
          tool: "launch_app",
          args: pick(a, ["name", "launch_path", "bundle_id", "urls", "additional_arguments"]),
          summary: `launch ${a.name ?? a.launch_path ?? a.bundle_id ?? "an app"}`,
        }),
      ),
    ),
    toolHandler(Clipboard, (a, caller) =>
      writing(
        caller,
        "clipboard",
        a,
        Effect.gen(function* () {
          if (a.text !== undefined) return { tool: "clipboard_write", args: { text: a.text }, summary: `copy ${quote(a.text, 40)}` }
          // Cua's clipboard_read says only what's on the clipboard (its types) unless it's asked for the text.
          yield* driver.start
          const args = (yield* driver.has("clipboard_read", "include_text")) ? { include_text: true } : {}
          return { tool: "clipboard_read", args, summary: "read the clipboard" }
        }),
      ),
    ),
  ]
  return all
})

/** The `desktop` server's tools, registered (`Main.ts`, above the MCP area: desktop is below mcp in the dependency order). */
export const DesktopTools = McpServers.register("desktop", desktopTools)
