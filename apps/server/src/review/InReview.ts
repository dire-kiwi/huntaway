import { Clock, Context, Duration, Effect, Layer, Ref, Result, Schema } from "effect"
import { Timestamp } from "@huntaway/contracts"
import type { Task, TaskId, WatchPullRequests } from "@huntaway/contracts"
import { SecureRandom } from "effect/crypto"
import { PrWatch } from "../github/PrWatch.ts"
import type { Reader } from "../github/PrWatch.ts"
import { GIVE_UP } from "../github/PrWatch.ts"
import { PrWatchRepo } from "../github/PrWatchRepo.ts"
import { decideWake, idle, woke } from "../github/prWatch/inReview.ts"
import { failedNews } from "../github/prWatch/pr.ts"
import type { Pr } from "../github/prWatch/pr.ts"
import { targetKey, targetLabel, targetOfUrl } from "../github/prWatch/target.ts"
import { nowTimestamp } from "../platform/columns.ts"
import { Db } from "../platform/Db.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { commentsPaused, fixChecksMessage, wakeMessage } from "../prompts/pullRequests.ts"
import { COMMENT_WAKES } from "../github/prWatch/inReview.ts"
import { Runs } from "../runs/Runs.ts"
import type { SendRefused } from "../runs/Runs.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { TaskNotFound } from "../tasks/Tasks.ts"
import { Threads } from "../threads/Threads.ts"
import { ThreadReaders } from "../threads/ThreadReaders.ts"

// The pull requests of tasks waiting in In review, and Fix broken checks (docs/plan/inventory/03-mcp.md 2.9; huntaway's
// mcp/pr_watch/in_review.ts and failed.ts `fix_checks`). In `review/`: both send the task's agent a message through
// `Runs`, which sits above `github/` where the reading is (`PrWatch`), and both are about a task in review.
//
// While a task is in In review with a pull request, in a project that watches them (`watch_pull_requests`), the board
// reads its pull request every `REVIEW_POLL`, as a wait does (the same query, as the same GitHub account, with the same
// record of what its agent has been told). News that the project wakes agents for, from a read while the agent is idle,
// goes to the agent in one message, which starts its turn: the task goes back to In progress and, when the agent
// finishes, to In review again. Nothing is read while the agent works or waits, the user has a message queued for it, or
// the task is being reviewed. Only comments from people who can push to the repository wake the agent, and not bots'
// nor its own account's; their text goes in untrusted-data tags. Comments alone wake it `COMMENT_WAKES` times in a row
// at most. A merged or closed pull request isn't read again. The board sends the message itself: the reactor's `PrNews`
// step the plan sketched would only add a hop, since the watcher has to check the agent is idle right before sending.

/** Fix broken checks can't be done: `reason` says which way (the wire's Invalid or Conflict), `detail` why. */
export class FixChecksRefused extends Schema.TaggedError<FixChecksRefused, { readonly brand: unique symbol }>()("FixChecksRefused", {
  reason: Schema.Literals(["no_pull_request", "unreadable", "not_open", "nothing_failed"]),
  detail: Schema.String,
}) {}

/** How often the pull request of a task in review is read, from when the board first sees the task there. */
export const REVIEW_POLL = "120 seconds"
/** How often the board looks for tasks in review whose pull request is due a read. */
export const REVIEW_TICK = "15 seconds"

const POLL_MILLIS = Duration.toMillis(Duration.fromInputUnsafe(REVIEW_POLL))
/** A year: "not again" for a pull request that won't be read. */
const NEVER = 365 * 24 * 3600 * 1000

/** A task in review whose pull request is watched. */
interface Watched {
  /** Its pull request, as the task has it. */
  readonly url: string
  /** Made at its first read. */
  readonly reader: Reader | null
  /** When it's next read (ms). */
  readonly next: number
  /** Reads (or wakes) that failed in a row. */
  readonly failures: number
}

export interface InReviewShape {
  /** One look at the tasks in review: read the pull requests that are due, and wake the agents they have news for. */
  readonly sweep: Effect.Effect<void>
  /**
   * Fix broken checks: read `task`'s pull request now, as its GitHub account, and send its agent its head commit's failed
   * checks with the ends of their logs, as a message at the user's asking (it goes to the agent while it works, or starts
   * its turn). Those failures count as told, so watching the task in review doesn't wake the agent with them again. The
   * read is kept on the task too. The task as it is after.
   */
  readonly fixChecks: (task: TaskId) => Effect.Effect<Task, TaskNotFound | FixChecksRefused | SendRefused>
}

export class InReview extends Context.Service<InReview, InReviewShape>()("huntaway-server/review/InReview") {
  static readonly layer = Layer.effect(
    InReview,
    Effect.gen(function* () {
      const prWatch = yield* PrWatch
      const repo = yield* PrWatchRepo
      const tasks = yield* TaskRepo
      const runs = yield* Runs
      const threads = yield* Threads
      const readers = yield* ThreadReaders
      const config = yield* ServerConfig
      const { tx } = yield* Db
      const random = yield* SecureRandom.SecureRandom
      const watched = yield* Ref.make<ReadonlyMap<TaskId, Watched>>(new Map())

      /**
       * What's news in `pr` (the pull request `key`) to wake the agent of `id` with, unless the task moved on or its agent
       * started meanwhile: checked with nothing in between it and the row's write, so a wait can't start in between. What
       * isn't news is stored as seen now, as for a wait.
       */
      const newsToWake = Effect.fnUntraced(function* (id: TaskId, mode: WatchPullRequests, key: string, pr: Pr) {
        const before = yield* repo.get(id, key)
        const userWrote =
          before !== null && before.comment_wakes > 0 && before.woke_at !== undefined
            ? yield* readers.userWroteSince(id, Timestamp.make(before.woke_at))
            : false
        const call = `in_review:${yield* random.uuidV4()}`
        const now = yield* nowTimestamp
        const decided = yield* tx(
          Effect.gen(function* () {
            const t = yield* tasks.get(id)
            if (t === null || t.status !== "in_review" || !idle(t)) return null
            const d = decideWake(yield* repo.get(id, key), pr, mode, userWrote, call, now)
            yield* repo.put(id, key, d.row, now)
            return d
          }),
        )
        if (decided?.paused === true) yield* threads.notice(id, "info", commentsPaused(COMMENT_WAKES)).pipe(Effect.ignore)
        return decided?.wake ?? null
      })

      /**
       * Whether the news kept as `call` still wakes the agent of `id`: the task is still in review on the pull request
       * `key`, its agent is idle, and neither a wait nor Fix broken checks told it that news meanwhile.
       */
      const stillWakes = Effect.fnUntraced(function* (id: TaskId, key: string, call: string) {
        if (yield* runs.isRunning(id)) return false
        const t = yield* tasks.get(id)
        const on = targetOfUrl(t?.pr_url ?? null)
        if (t === null || t.status !== "in_review" || !idle(t) || on === null || targetKey(on) !== key) return false
        const p = (yield* repo.get(id, key))?.pending
        return p !== undefined && p.call_id === call && p.superseded !== true
      })

      /** Read the pull request of `task` (in review, in a project that watches them `mode`) and wake its agent if there's news for it. */
      const check = Effect.fnUntraced(function* (task: Task, mode: WatchPullRequests, w: Watched, now: number) {
        let next = now + POLL_MILLIS
        const failed = (e: string) =>
          Effect.gen(function* () {
            const failures = w.failures + 1
            yield* Effect.logWarning(`task=${task.id} pr=${w.url} failures=${failures}: watching a pull request in review: ${e}`)
            if (failures === GIVE_UP) {
              const why = `Watching its pull request while the task is in review failed ${GIVE_UP} times in a row; still trying`
              yield* threads.notice(task.id, "warning", why, e).pipe(Effect.ignore)
            }
            const after: Watched = { ...w, failures, next: now + Math.min(POLL_MILLIS * 2 ** Math.min(failures, 4), POLL_MILLIS * 10) }
            return after
          })
        let reader = w.reader
        if (reader === null) {
          const made = yield* Effect.result(prWatch.readerFor(task, w.url))
          if (Result.isFailure(made)) {
            // Not a pull request it can read: it isn't watched until it changes.
            yield* Effect.logInfo(`task=${task.id} pr=${w.url}: not watching a pull request in review: ${made.failure.reason}`)
            const never: Watched = { ...w, next: now + NEVER }
            return never
          }
          reader = made.success
        }
        const r = reader
        const read = yield* Effect.result(prWatch.read(r))
        if (Result.isFailure(read)) return yield* failed(read.failure.reason)
        const pr = read.success
        const key = targetKey(r.target)
        if (pr.state !== "open") next = now + NEVER
        else yield* prWatch.recordChecks(task.id, r.target, pr.head, pr.checks)
        const done: Watched = { url: w.url, reader: r, next, failures: 0 }
        const wake = yield* newsToWake(task.id, mode, key, pr)
        if (wake === null) return done
        // The ends of the failed jobs' logs go with them, so the agent can start on the fix.
        const logs = wake.news.events.includes("checks_failed")
          ? yield* prWatch.failedLogs(
              r,
              pr.checks.filter((c) => c.state === "Failed"),
            )
          : []
        // Fetching them takes a while: the news waits for the next read if the task moved on meanwhile.
        if (!(yield* stillWakes(task.id, key, wake.call))) return done
        const sent = yield* Effect.result(runs.send(task.id, { text: wakeMessage(wake.news, logs), source: "board", auto: true }))
        // Started meanwhile, say: the news waits for the next read.
        if (Result.isFailure(sent)) {
          const why = sent.failure._tag === "SendRefused" ? sent.failure.detail : `task ${sent.failure.id} not found`
          return yield* failed(`couldn't wake the agent: ${why}`).pipe(Effect.map((after) => ({ ...after, reader: r })))
        }
        const at = yield* nowTimestamp
        yield* prWatch.told(task.id, key, wake.call, (row) => woke(row, wake.commentsOnly, at))
        return done
      })

      const sweep = Effect.gen(function* () {
        // No agent could be woken.
        if (config.noAgents) return
        const listed = yield* repo.inReview
        const found = new Map((yield* tasks.getMany(listed.map((l) => l.id))).map((t) => [t.id, t] as const))
        const now = yield* Clock.currentTimeMillis
        const before = yield* Ref.get(watched)
        const kept = new Map<TaskId, Watched>()
        const due: Array<readonly [Task, WatchPullRequests, Watched]> = []
        for (const { id, mode } of listed) {
          const task = found.get(id)
          if (task === undefined) continue
          const url = task.pr_url ?? ""
          // Those that moved on, or whose pull request changed, start over if they're back.
          const was = before.get(id)
          const w: Watched = was !== undefined && was.url === url ? was : { url, reader: null, next: now + POLL_MILLIS, failures: 0 }
          kept.set(id, w)
          if (w.next > now || !idle(task) || (yield* runs.isRunning(id))) continue
          due.push([task, mode, w])
        }
        const checked = yield* Effect.forEach(
          due,
          ([task, mode, w]) =>
            check(task, mode, w, now).pipe(
              Effect.catchCause((cause) =>
                Effect.as(Effect.logError(`task=${task.id}: watching a pull request in review`, cause), { ...w, next: now + POLL_MILLIS }),
              ),
              Effect.map((after) => [task.id, after] as const),
            ),
          { concurrency: 4 },
        )
        for (const [id, after] of checked) kept.set(id, after)
        yield* Ref.set(watched, kept)
      }).pipe(Effect.withSpan("InReview.sweep"))

      const fixChecks = Effect.fn("InReview.fixChecks")(function* (id: TaskId) {
        const task = yield* tasks.get(id)
        if (task === null) return yield* new TaskNotFound({ id })
        const url = task.pr_url !== null && task.pr_url.trim() !== "" ? task.pr_url : null
        if (url === null) return yield* new FixChecksRefused({ reason: "no_pull_request", detail: "this task has no pull request" })
        const reader = yield* prWatch
          .readerFor(task, url)
          .pipe(Effect.mapError((e) => new FixChecksRefused({ reason: "unreadable", detail: `its pull request can't be read: ${e.reason}` })))
        const label = targetLabel(reader.target)
        const pr = yield* prWatch
          .read(reader)
          .pipe(Effect.mapError((e) => new FixChecksRefused({ reason: "unreadable", detail: `${label} couldn't be read: ${e.reason}` })))
        if (pr.state !== "open") return yield* new FixChecksRefused({ reason: "not_open", detail: `${label} is ${pr.state}` })
        yield* prWatch.recordChecks(id, reader.target, pr.head, pr.checks)
        const failed = pr.checks.filter((c) => c.state === "Failed")
        if (failed.length === 0) {
          const pending = pr.checks.filter((c) => c.state === "Pending").length
          const still = pending > 0 ? ` (${pending} still running)` : ""
          return yield* new FixChecksRefused({ reason: "nothing_failed", detail: `no checks have failed on ${label}'s head commit${still}` })
        }
        const logs = yield* prWatch.failedLogs(reader, failed)
        const sent = yield* runs.send(id, { text: fixChecksMessage(pr.number, pr.url, pr.head, failedNews(pr.checks), logs), source: "board" })
        yield* prWatch.toldFailures(id, targetKey(reader.target), pr)
        return sent
      })

      return InReview.of({ sweep, fixChecks })
    }),
  )

  /** The watcher: a sweep every `REVIEW_TICK`, the first straight away. Not in `areasLayer`: tests run `sweep` themselves. */
  static readonly watcher = Layer.effectDiscard(
    Effect.gen(function* () {
      const inReview = yield* InReview
      yield* inReview.sweep.pipe(
        Effect.catchCause((cause) => Effect.logError("watching pull requests in review", cause)),
        Effect.andThen(Effect.sleep(REVIEW_TICK)),
        Effect.forever,
        Effect.forkScoped,
      )
    }),
  )
}
