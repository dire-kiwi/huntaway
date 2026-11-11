import { Context, DateTime, Effect, FiberSet, FileSystem, Layer, Option, Predicate, Schema, Semaphore, Stream } from "effect"
import { Timestamp } from "@huntaway/contracts"
import type { TaskId } from "@huntaway/contracts"
import { DataDir } from "../platform/DataDir.ts"
import { Db } from "../platform/Db.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { savedFor, TokenRepo } from "./TokenRepo.ts"
import type { PendingRun, Saved } from "./TokenRepo.ts"
import { claudeLineCounts, codexLineCounts, countClaude, countCodex, counted, rolloutModel, startedThread } from "./tokens/count.ts"
import type { Before, Counted, Earlier } from "./tokens/count.ts"
import { counts, countsFromJson, scale } from "./tokens/counts.ts"
import type { ByModel } from "./tokens/counts.ts"

// The tokens each run used, per model, for statistics (huntaway's agent/tokens.ts), in `token_usage`. They're counted
// from the run's output (`runs/<id>/out.jsonl`) once it has ended rather than as it streams in, so runs from before
// this was kept are counted the same way while their folders are kept: when a run ends, at startup, and before the
// run folders are pruned. The algorithm is in `tokens/count.ts`; a run whose folder is gone gets a row with what it
// cost and no tokens, estimated. Telemetry's `run_usage` and `run_end` join with `Telemetry`.

export interface TokensShape {
  /**
   * Count the runs that have ended and haven't been counted (only `task`'s, if given), oldest first for each task, so
   * each goes on from its task's earlier runs. Returns how many it counted. One count at a time. A run that can't be
   * counted is marked counted, so it isn't tried again and again.
   */
  readonly countPending: (task: TaskId | null) => Effect.Effect<number>
  /** A run of `task` ended: count it, and any of the task's before it, in the background. */
  readonly runEnded: (task: TaskId) => Effect.Effect<void>
}

/** A saved snapshot's models (it must be an object of them), or null. */
const JsonText = Schema.fromJsonString(Schema.Unknown)
const decodeJson = Schema.decodeUnknownOption(JsonText)
const byModel = (text: string): ByModel | null => {
  const v = Option.getOrUndefined(decodeJson(text))
  if (!Predicate.isObject(v) || Array.isArray(v)) return null
  const out: ByModel = {}
  for (const [m, c] of Object.entries(v)) out[m] = countsFromJson(c)
  return out
}

/** What an earlier run saved, as the counting reads it; null if its snapshot can't be read. */
export const beforeOf = (saved: Saved): Before | null => {
  const totals = byModel(saved.usage_snapshot)
  if (totals === null) return null
  return { totals, tail: (saved.usage_tail === null ? null : byModel(saved.usage_tail)) ?? {} }
}

const pad = (n: number) => String(n).padStart(2, "0")

const CodexSpec = Schema.fromJsonString(Schema.Struct({ model: Schema.optional(Schema.Unknown), thread_id: Schema.optional(Schema.Unknown) }))
const LaunchSpec = Schema.fromJsonString(Schema.Struct({ config_dir: Schema.optional(Schema.Unknown) }))

export class Tokens extends Context.Service<Tokens, TokensShape>()("huntaway-server/agents/Tokens") {
  static readonly layer = Layer.effect(
    Tokens,
    Effect.gen(function* () {
      const repo = yield* TokenRepo
      const tasks = yield* TaskRepo
      const db = yield* Db
      const dataDir = yield* DataDir
      const fs = yield* FileSystem.FileSystem
      const config = yield* ServerConfig
      const one = yield* Semaphore.make(1)
      const background = yield* FiberSet.make()

      const now = Effect.map(DateTime.now, (t) => Timestamp.make(DateTime.formatIso(t)))
      const exists = (path: string) => fs.exists(path).pipe(Effect.orElseSucceed(() => false))

      /** The lines of a file that `keep` wants, or none if it can't be read. */
      const linesOf = (path: string, keep: (line: string) => boolean) =>
        fs.stream(path).pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.filter(keep),
          Stream.runCollect,
          Effect.orElseSucceed((): ReadonlyArray<string> => []),
        )

      const readJson = <A>(path: string, schema: Schema.Codec<A, string>) =>
        fs.readFileString(path).pipe(
          Effect.flatMap(Schema.decodeEffect(schema)),
          Effect.asSome,
          Effect.orElseSucceed(() => Option.none<A>()),
        )

      const expand = (path: string) => (path === "~" ? config.home : path.startsWith("~/") ? `${config.home}${path.slice(1)}` : path)

      /** The model in Codex's rollout file for `thread` (`sessions/YYYY/MM/DD/rollout-…-<thread>.jsonl`), looked for in the days around the run's start. */
      const rolloutModelOf = Effect.fnUntraced(function* (configDir: string, thread: string, at: Timestamp) {
        const start = DateTime.make(at)
        if (Option.isNone(start)) return null
        const suffix = `-${thread}.jsonl`
        for (const days of [0, -1, 1]) {
          // In local time, as the old server's.
          const day = DateTime.toParts(DateTime.setZone(DateTime.add(start.value, { days }), DateTime.zoneMakeLocal()))
          const folder = `${configDir}/sessions/${day.year}/${pad(day.month)}/${pad(day.day)}`
          const names = yield* fs.readDirectory(folder).pipe(Effect.orElseSucceed((): ReadonlyArray<string> | null => null))
          if (names === null) continue
          const file = names.find((n) => `${folder}/${n}`.endsWith(suffix))
          if (file === undefined) continue
          return rolloutModel(yield* linesOf(`${folder}/${file}`, (l) => l.includes('"turn_context"')))
        }
        return null
      })

      /** The model a Codex run's thread was started with, before its output says. */
      const codexModel = Effect.fnUntraced(function* (run: PendingRun, dir: string) {
        const spec = yield* readJson(`${dir}/codex.json`, CodexSpec)
        const specModel = Option.getOrUndefined(spec)?.model
        if (typeof specModel === "string" && specModel !== "") return specModel
        const launch = yield* readJson(`${dir}/spec.json`, LaunchSpec)
        const specThread = Option.getOrUndefined(spec)?.thread_id
        const thread = typeof specThread === "string" ? specThread : startedThread(yield* linesOf(`${dir}/out.jsonl`, (l) => l.includes("thread/started")))
        const launchDir = Option.getOrUndefined(launch)?.config_dir
        const configDir = typeof launchDir === "string" ? launchDir : "~/.codex"
        if (thread !== null) {
          const m = yield* rolloutModelOf(expand(configDir), thread, run.created_at)
          if (m !== null) return m
        }
        return (yield* tasks.get(run.task_id))?.model ?? "codex"
      })

      /** A run whose output is gone: what it cost, on the model its turns or its task say. */
      const estimate = Effect.fnUntraced(function* (run: PendingRun) {
        const out = counted("claude")
        out.estimated = true
        const task = yield* tasks.get(run.task_id)
        // The task's config, as a run of it would pick it: its own, else (with no session started elsewhere) its project's or profile's first.
        let configId = task?.claude_config_id ?? null
        if (task !== null && configId === null && task.session_id === null) {
          const project = task.project_id === null ? null : yield* tasks.project(task.project_id)
          configId = (yield* tasks.configs(task.profile_id, project))[0] ?? null
        }
        if (configId !== null && (yield* repo.configAgent(configId)) === "codex") out.runtime = "codex"
        if (run.cost_usd <= 0) return out
        const model = (yield* repo.runModel(run.id)) ?? task?.model ?? "unknown"
        out.models[model] = counts({ cost: run.cost_usd })
        return out
      })

      const countRun = Effect.fnUntraced(function* (run: PendingRun) {
        const dir = dataDir.runDir(run.id)
        const outFile = `${dir}/out.jsonl`
        // The totals the task's latest earlier counted run had reached for a session or thread.
        const saved = yield* repo.savedBefore(run.task_id, run.seq)
        const earlier: Earlier = (key) => {
          const row = savedFor(saved, key)
          return row === null ? null : beforeOf(row)
        }
        let result: Counted
        if (!(yield* exists(outFile))) {
          result = yield* estimate(run)
        } else if (yield* exists(`${dir}/codex.json`)) {
          result = countCodex(yield* linesOf(outFile, codexLineCounts), yield* codexModel(run, dir), earlier)
        } else {
          result = countClaude(yield* linesOf(outFile, claudeLineCounts), earlier)
          // More than the board charged the run: it was counted from nothing, its session's earlier runs' totals being gone.
          const cost = Object.values(result.models).reduce((s, c) => s + c.cost, 0)
          if (run.cost_usd > 0 && cost > run.cost_usd * 1.05 + 0.01) {
            const f = run.cost_usd / cost
            for (const c of Object.values(result.models)) scale(c, f)
            result.estimated = true
          }
        }
        const at = yield* now
        yield* db.tx(repo.save(run.id, result, at))
      })

      const countPending = Effect.fn("Tokens.countPending")(function* (task: TaskId | null) {
        return yield* Semaphore.withPermits(
          one,
          1,
        )(
          Effect.gen(function* () {
            const runs = yield* repo.pending(task)
            for (const run of runs) {
              yield* countRun(run).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning(`tokens: run=${run.id} counting the run's tokens`, cause).pipe(
                    // So it isn't tried again and again.
                    Effect.andThen(Effect.flatMap(now, (at) => repo.markCounted(run.id, at))),
                  ),
                ),
              )
            }
            return runs.length
          }),
        )
      })

      const runEnded = Effect.fn("Tokens.runEnded")(function* (task: TaskId) {
        yield* FiberSet.run(background, countPending(task).pipe(Effect.catchCause((cause) => Effect.logWarning(`tokens: task=${task} counting tokens`, cause))))
      })

      return Tokens.of({ countPending, runEnded })
    }),
  )
}
