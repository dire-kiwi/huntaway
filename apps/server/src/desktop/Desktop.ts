import { Clock, Context, Effect, Layer, Ref } from "effect"
import { Conflict, NotFound, Unavailable } from "@huntaway/contracts"
import type { DesktopCheck, DesktopFrame, DesktopFrameResult, DesktopStatus, TaskDesktop, TaskId } from "@huntaway/contracts"
import { nowTimestamp } from "../platform/columns.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { SettingsRepo } from "../settings/SettingsRepo.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { CuaDriver } from "./CuaDriver.ts"
import { CuaInstall } from "./CuaInstall.ts"
import { imageOf, pinnedRelease, structuredNumber, textsOf } from "./cua.ts"
import type { CuaRelease, CuaResult } from "./cua.ts"
import { DesktopClaims } from "./DesktopClaims.ts"
import { DesktopOpRepo } from "./DesktopOpRepo.ts"

// Computer use as the host's page and a task's viewer see it (huntaway's api/desktop.ts; docs/plan/inventory/
// 05-hosts-update.md 2.8): whether the host's agents may use its desktop (the `desktop_tools` setting, off until the
// page turns it on), installing its Cua Driver, and what a task's agent looks at (`frame`) and did (`ops`). The viewer
// never starts the driver and never shows a locked screen; it asks for a display-only capture, so the agent's snapshot
// tokens stay valid.

/** The setting that lets this host's agents use its desktop. */
export const SETTING = "desktop_tools"

/** How long a frame is kept, so viewers polling at once don't each make the driver capture. */
const FRAME_MS = 400

export interface DesktopShape {
  /** Whether the host's page turned computer use on. */
  readonly enabled: Effect.Effect<boolean>
  /** Whether this host's runs get the `desktop` server: it's on, and there's a driver to run. */
  readonly available: Effect.Effect<boolean>
  /** The release the host's page installs, or null where Cua has none for this platform. */
  readonly release: CuaRelease | null
  readonly status: Effect.Effect<DesktopStatus>
  /** Turn computer use on or off for this host's agents (from their next run); off stops the driver. */
  readonly setEnabled: (enabled: boolean) => Effect.Effect<DesktopStatus>
  readonly install: Effect.Effect<DesktopStatus, Unavailable>
  readonly uninstall: Effect.Effect<DesktopStatus, Conflict>
  readonly stop: Effect.Effect<DesktopStatus>
  /** Start the driver and ask it what it may do (its `check_permissions`), with the status. */
  readonly check: Effect.Effect<DesktopCheck>
  /** An image of the window task `task`'s agent last used (or `pid` and `window_id`), or why there is none. */
  readonly frame: (q: {
    readonly task_id?: TaskId | undefined
    readonly pid?: number | undefined
    readonly window_id?: number | undefined
  }) => Effect.Effect<DesktopFrameResult>
  /** What a task's agent did on the desktop (newest first), and the window it last used. */
  readonly ops: (task: TaskId) => Effect.Effect<TaskDesktop, NotFound>
}

export class Desktop extends Context.Service<Desktop, DesktopShape>()("huntaway-server/desktop/Desktop") {
  static readonly layer = Layer.effect(
    Desktop,
    Effect.gen(function* () {
      const config = yield* ServerConfig
      const settings = yield* SettingsRepo
      const driver = yield* CuaDriver
      const installs = yield* CuaInstall
      const claims = yield* DesktopClaims
      const opRepo = yield* DesktopOpRepo
      const taskRepo = yield* TaskRepo
      const frames = yield* Ref.make<ReadonlyMap<string, { readonly at: number; readonly frame: DesktopFrame }>>(new Map())
      const release = config.cuaRelease ?? pinnedRelease(process.platform, process.arch)

      const enabled = Effect.map(settings.get(SETTING), (v) => v === "true")

      const status = Effect.gen(function* () {
        const found = yield* driver.find
        const holder = yield* claims.holder
        const task = holder === null ? null : yield* taskRepo.get(holder.task_id)
        const stderr = yield* driver.stderr
        const out: DesktopStatus = {
          enabled: yield* enabled,
          platform: process.platform,
          release: release === null ? null : { version: release.version, bytes: release.bytes },
          installed: found,
          install: yield* installs.current,
          driver: { ...(yield* driver.status), stderr: stderr.split("\n").slice(-20).join("\n") },
          session: yield* driver.session,
          locked: yield* driver.locked,
          in_use_by: task === null ? null : { task_id: task.id, title: task.title },
        }
        return out
      })

      const check = Effect.gen(function* () {
        const said = yield* Effect.gen(function* () {
          yield* driver.start
          if (!(yield* driver.has("check_permissions"))) return "The driver started."
          return textsOf((yield* driver.call("check_permissions", {}, "30 seconds")).content ?? [])
        }).pipe(Effect.catchTag("DriverError", (e) => Effect.succeed(e.reason)))
        const out: DesktopCheck = Object.assign({}, yield* status, { check: said })
        return out
      })

      /** The driver's look at a window (or the whole desktop), for the viewer. */
      const look = (pid: number | null, windowId: number | null) =>
        Effect.gen(function* () {
          if (pid === null) return yield* driver.call("get_desktop_state", {}, "15 seconds")
          const args: Record<string, unknown> = { pid, include_screenshot: true }
          if (windowId !== null) args["window_id"] = windowId
          // A look for a live preview, which leaves the agent's snapshot and pixel frame alone, where the driver can.
          if (yield* driver.has("get_window_state", "include_accessibility_tree")) args["include_accessibility_tree"] = false
          if (yield* driver.has("get_window_state", "display_only")) args["display_only"] = true
          if (yield* driver.has("get_window_state", "max_image_dimension")) args["max_image_dimension"] = 1280
          return yield* driver.call("get_window_state", args, "15 seconds")
        })

      const frame: DesktopShape["frame"] = Effect.fn("Desktop.frame")(function* (q) {
        if (!(yield* enabled)) return { frame: null, reason: "Computer use is off on this host." }
        if ((yield* driver.status).state !== "running") return { frame: null, reason: "The driver isn't running: it starts when an agent uses the desktop." }
        if ((yield* driver.locked) === true) return { frame: null, reason: "The screen is locked." }
        const target = q.task_id === undefined ? null : yield* claims.target(q.task_id)
        const pid = q.pid ?? target?.pid ?? null
        const windowId = q.window_id ?? target?.window_id ?? null
        const key = `${pid}:${windowId}`
        const now = yield* Clock.currentTimeMillis
        const kept = (yield* Ref.get(frames)).get(key)
        if (kept !== undefined && now - kept.at < FRAME_MS) return { frame: kept.frame }
        const looked = yield* Effect.result(look(pid, windowId))
        if (looked._tag === "Failure") return { frame: null, reason: looked.failure.reason }
        const result: CuaResult = looked.success
        const img = imageOf(result)
        if (img === null) {
          const why = textsOf(result.content ?? [])
          return { frame: null, reason: result.isError === true && why !== "" ? why.slice(0, 300) : "The driver returned no image." }
        }
        const f: DesktopFrame = {
          mime: img.mime,
          data: img.data,
          width: structuredNumber(result, "screenshot_width"),
          height: structuredNumber(result, "screenshot_height"),
          pid,
          window_id: windowId,
          at: yield* nowTimestamp,
        }
        yield* Ref.update(frames, (all) => new Map([...all, [key, { at: now, frame: f }]]))
        return { frame: f }
      })

      return Desktop.of({
        enabled,
        available: Effect.flatMap(enabled, (on) => (on ? Effect.map(driver.find, (found) => found !== null) : Effect.succeed(false))),
        release,
        status,
        setEnabled: Effect.fn("Desktop.setEnabled")(function* (on: boolean) {
          yield* settings.set(SETTING, on ? "true" : null)
          if (!on) yield* driver.stop
          return yield* status
        }),
        install: Effect.gen(function* () {
          if (release === null)
            return yield* new Unavailable({ what: "Cua Driver", reason: `Cua Driver has no release for ${process.platform} on ${process.arch}` })
          yield* installs.start(release)
          return yield* status
        }),
        uninstall: Effect.gen(function* () {
          const j = yield* installs.current
          if (j !== null && j.phase !== "done" && j.phase !== "failed")
            return yield* new Conflict({ reason: "in_use", detail: "Cua Driver is being installed" })
          yield* driver.stop
          yield* installs.uninstall
          return yield* status
        }),
        stop: Effect.andThen(driver.stop, status),
        check,
        frame,
        ops: Effect.fn("Desktop.ops")(function* (id: TaskId) {
          const task = yield* taskRepo.get(id)
          if (task === null) return yield* new NotFound({ what: "task", id })
          return { ops: yield* opRepo.ofTask(task.id), target: yield* claims.target(task.id) }
        }),
      })
    }),
  )
}
