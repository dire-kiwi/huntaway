import { Clock, Context, DateTime, Effect, Layer, Option, Ref, Schedule, Schema } from "effect"
import type { AgentConfigId } from "@huntaway/contracts"
import { AgentConfigRepo } from "../profiles/AgentConfigRepo.ts"
import type { AgentConfigRow } from "../profiles/AgentConfigRepo.ts"
import { Usage } from "../profiles/Usage.ts"
import type { SessionReset } from "../profiles/Usage.ts"
import { field, showsFiveHour } from "../profiles/usage/limits.ts"
import { SideCalls } from "./SideCalls.ts"
import { spentFromClaudeStream } from "./tokens/calls.ts"
import { WindowPrompt } from "./WindowPrompt.ts"

// Restarting 5-hour windows (huntaway's agent/window.ts). A plan's session limit runs for five hours from the first
// message after the last window ended, so a window that ends while nothing is running leaves the next one to start
// whenever work does, and then run five hours from there. For each config with `restart_window` on whose plan has the
// window, the board sends one short prompt just after it ends (`GRACE` late), with no session kept. That starts the
// next window.
//
// What it knows of the window is the config's usage (`profiles/Usage`): fetched when the config is first seen with the
// setting on, again before and after each prompt (another host or a run may have started the window since, and the
// prompt's own rate limits can still show the window that ended), and kept up to date by agent runs'
// `rate_limit_event`s, the prompt's own included. A plan whose usage has never shown a session limit is sent nothing,
// nor is a config that's out of usage. Once a plan has shown one it counts as having it, as its usage may leave the
// limit out while no window runs; a prompt whose own rate limits show no 5-hour window at all, with usage that doesn't
// show one either, stops the restarts until the setting is turned on again (or the server restarts). A prompt that
// fails, or that doesn't leave a window running, is tried again later, backing off from `RETRY` up to `MAX_RETRY`.
//
// Not through a proxy: it picks the account, so there's no one window to restart. Codex configs' windows join with
// the Codex driver (M5).

/** How often the loop looks at the windows. */
export const TICK = "30 seconds"
/** How long after a window's reset the prompt is sent, for clocks that disagree. */
const GRACE_MS = 60_000
/** How long after a failed prompt the next is tried, doubling each time up to `MAX_RETRY_MS`. */
const RETRY_MS = 5 * 60_000
const MAX_RETRY_MS = 60 * 60_000

/** What the loop knows of one config, while its setting is on. */
export interface Watch {
  /** Its usage has been fetched since the setting was seen on. */
  readonly fetched: boolean
  /** Its plan has shown a session limit. */
  readonly has_window: boolean
  /** A prompt's own rate limits showed no 5-hour window. */
  readonly no_window: boolean
  readonly failures: number
  /** When to try again (`Clock` ms). */
  readonly retry_at: number | null
}

export const newWatch: Watch = { fetched: false, has_window: false, no_window: false, failures: 0, retry_at: null }

/** The plan has no 5-hour window (or none has been seen yet), it runs until `at`, or it ended (`GRACE` ago) and has not started again. */
export type Window = { readonly _tag: "None" } | { readonly _tag: "Open"; readonly at: number } | { readonly _tag: "Ended" }

/** The window as `reset` shows it at `now`, and the watch with what that taught it (a session limit seen). */
export const windowOf = (reset: SessionReset, w: Watch, now: number): readonly [Window, Watch] => {
  const watch = reset._tag === "None" || w.has_window ? w : { ...w, has_window: true }
  if (!watch.has_window || watch.no_window) return [{ _tag: "None" }, watch]
  if (reset._tag === "At" && reset.at + GRACE_MS > now) return [{ _tag: "Open", at: reset.at }, watch]
  return [{ _tag: "Ended" }, watch]
}

export interface UsageWindowShape {
  /** One look at every config with the setting on: a prompt to each whose window has ended. The loop runs it every `TICK`. */
  readonly tick: Effect.Effect<void>
  /** What it knows of a config, while its setting is on. */
  readonly watch: (config: AgentConfigId) => Effect.Effect<Watch | null>
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

export class UsageWindow extends Context.Service<UsageWindow, UsageWindowShape>()("huntaway-server/agents/UsageWindow") {
  static readonly layer = Layer.effect(
    UsageWindow,
    Effect.gen(function* () {
      const repo = yield* AgentConfigRepo
      const usage = yield* Usage
      const prompt = yield* WindowPrompt
      const sideCalls = yield* SideCalls
      const watches = yield* Ref.make<ReadonlyMap<string, Watch>>(new Map())

      /**
       * Take in the `rate_limit_event`s in Claude's stream-json output, as a run's are: whether they showed a 5-hour
       * window, if they showed any rate limits.
       */
      const readOutput = Effect.fnUntraced(function* (config: AgentConfigId, stdout: string) {
        let reported: boolean | null = null
        for (const l of stdout.split("\n")) {
          const v = decodeJson(l)
          if (Option.isNone(v) || field(v.value, "type") !== "rate_limit_event") continue
          yield* usage.onRateLimit(config, v.value)
          const shows = showsFiveHour(v.value)
          if (shows !== null) reported = reported === true || shows
        }
        return reported
      })

      /** Send the prompt that starts a window: whether its rate limits showed a 5-hour window, if they said. Its tokens are kept. */
      const ping = Effect.fnUntraced(function* (c: AgentConfigRow) {
        const out = yield* prompt.send(c).pipe(Effect.mapError((e) => e.reason))
        const spent = spentFromClaudeStream(out.stdout)
        if (spent !== null) yield* sideCalls.record("window", null, c.id, spent)
        const reported = yield* readOutput(c.id, out.stdout)
        if (out.error !== null) return yield* Effect.fail(out.error)
        return reported
      })

      /** Send the prompt if the config's window has ended. Returns what it knows after. */
      const check = Effect.fnUntraced(function* (c: AgentConfigRow, start: Watch, now: number) {
        let w = start
        const window = Effect.map(usage.sessionReset(c.id), (reset) => {
          const [win, next] = windowOf(reset, w, now)
          w = next
          return win
        })
        if (w.retry_at !== null && w.retry_at > now) return w
        if (!w.fetched) {
          w = { ...w, fetched: true }
          yield* usage.refresh(c.id)
        }
        if ((yield* window)._tag !== "Ended" || (yield* usage.outUntil(c.id)) !== null) return w
        // Someone may have started it since the numbers were last updated.
        yield* usage.refresh(c.id)
        if ((yield* window)._tag !== "Ended") return w
        const result = yield* Effect.result(ping(c))
        // The first request after a window ends can still report the old one, or leave the 5-hour window out of its
        // rate limits, so the usage, asked again, says whether the next started.
        const shown = (yield* usage.refresh(c.id)) ? (yield* usage.sessionReset(c.id))._tag !== "None" : null
        const noWindow = result._tag === "Success" && result.success !== null && !result.success && shown !== true
        if (noWindow) {
          yield* Effect.logInfo(`window: config=${c.name} not restarting its 5-hour window: its plan doesn't have one`)
          return { ...w, no_window: true }
        }
        const after = yield* window
        if (result._tag === "Success" && after._tag === "Open") {
          yield* Effect.logInfo(`window: config=${c.name} started the next 5-hour window, until ${DateTime.formatIso(DateTime.makeUnsafe(after.at))}`)
          return { ...w, failures: 0, retry_at: null }
        }
        const wait = Math.min(RETRY_MS * 2 ** Math.min(w.failures, 4), MAX_RETRY_MS)
        const why = result._tag === "Failure" ? result.failure : "no window is running after it"
        yield* Effect.logWarning(`window: config=${c.name} restarting the 5-hour window failed (${why}); trying again in ${Math.floor(wait / 60_000)} minutes`)
        return { ...w, failures: w.failures + 1, retry_at: now + wait }
      })

      const tick = Effect.gen(function* () {
        const configs: Array<AgentConfigRow> = []
        for (const c of yield* repo.list) {
          if (c.restart_window && c.agent === "claude" && (yield* usage.proxy(c.id)) === null) configs.push(c)
        }
        // A setting turned off forgets what it knew, so turning it on again starts afresh.
        yield* Ref.update(watches, (m) => new Map([...m].filter(([id]) => configs.some((c) => c.id === id))))
        for (const c of configs) {
          const w = (yield* Ref.get(watches)).get(c.id) ?? newWatch
          const next = yield* check(c, w, yield* Clock.currentTimeMillis)
          yield* Ref.update(watches, (m) => new Map([...m, [c.id, next]]))
        }
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("window: restarting 5-hour windows", cause)),
        Effect.withSpan("UsageWindow.tick"),
      )

      const watch = (config: AgentConfigId) => Effect.map(Ref.get(watches), (m) => m.get(config) ?? null)

      return UsageWindow.of({ tick, watch })
    }),
  )

  /** The loop: a look every `TICK`, from the start, for as long as the server runs. */
  static readonly loop = Layer.effectDiscard(
    Effect.gen(function* () {
      const window = yield* UsageWindow
      yield* window.tick.pipe(Effect.repeat(Schedule.spaced(TICK)), Effect.forkScoped)
    }),
  )
}
