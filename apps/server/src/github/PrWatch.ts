import { Context, Duration, Effect, Layer, Option, Result, Schema } from "effect"
import type { AgentWait, Task, TaskId, WaitPr } from "@huntaway/contracts"
import { accountName, parseAccount } from "@huntaway/shared"
import { TaskBase } from "../git/TaskBase.ts"
import { expandHome } from "../git/paths.ts"
import { isGithubCom } from "../git/worktree/remote.ts"
import { nowTimestamp } from "../platform/columns.ts"
import { Db } from "../platform/Db.ts"
import { Events } from "../platform/Events.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { ProjectRepo } from "../projects/ProjectRepo.ts"
import type { LogResult } from "../prompts/pullRequests.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { Gh } from "./Gh.ts"
import type { GhResult } from "./Gh.ts"
import { boardChecks, LOGS_MAX, logTail, sameChecks, toldFailures } from "./prWatch/failed.ts"
import { ALWAYS, compare, EVENTS, nextThreads, objOrNull, parsePr, QUERY, summary, THREAD_PAGES, THREADS, unreadable, withThreads } from "./prWatch/pr.ts"
import type { Check, News, Pr, PrEvent } from "./prWatch/pr.ts"
import { emptyRow, toldOf, withoutPending } from "./prWatch/seen.ts"
import type { WatchRow } from "./prWatch/seen.ts"
import { parseTarget, targetKey, targetLabel, targetOf, targetOfUrl, targetRepo, targetUrl } from "./prWatch/target.ts"
import type { Target } from "./prWatch/target.ts"
import { PrWatchRepo } from "./PrWatchRepo.ts"

// Reading a task's pull request as its GitHub account, and what its agent has been told of it (docs/plan/06-server.md,
// GitHub; docs/plan/inventory/03-mcp.md 2.9; huntaway's mcp/pr_watch.ts, pr_watch/read.ts and failed.ts).
//
// A `wait` on a pull request ends on news about it that the agent hasn't been told yet: a check on its head commit
// failed, all of its required checks passed, someone other than the agent's own GitHub account commented or reviewed,
// it started to conflict with its base branch, or it was merged or closed. The board reads it with one GraphQL query
// every `POLL` (and one more for each page of review threads past the first), as the task's GitHub account (its
// project's or profile's; gh's active account when neither names one), and never as another: an account that isn't
// signed in fails the read, and one on another host than the pull request's doesn't start the wait. A read that fails
// is tried again later and later (`backoff`), and after `GIVE_UP` failures in a row the wait ends saying so.
//
// What the agent has been told about each pull request is kept for its task (`pr_watches`), across its waits, the
// in-review watcher's wakes and server restarts: so a wait reports what happened since the last one on that pull
// request. News counts as told once a call returns it to the agent (`delivered`): one that ends without reaching it
// leaves it for the next wait. Each read of an open pull request also keeps how its checks stand on the task
// (`pr_checks`), for the board.

/** The pull request couldn't be read, or isn't one this task's account can read: `reason` says why. */
export class PrUnreadable extends Schema.TaggedError<PrUnreadable, { readonly brand: unique symbol }>()("PrUnreadable", { reason: Schema.String }) {}

const unreadableBy = (reason: string) => new PrUnreadable({ reason })

/** How often a wait's pull request is read. */
export const POLL = "60 seconds"
/** How many failed reads in a row end the wait. */
export const GIVE_UP = 5
/** How long a gh call for a read may take. */
export const GH_TIMEOUT = "60 seconds"

/** How often a wait's pull request is read (`POLL`; tests shorten it, as the old `POLL` was 100 ms in tests). */
export const PrPoll = Context.Reference<Duration.Input>("huntaway-server/github/PrWatch/PrPoll", { defaultValue: () => POLL })

/** How long to wait before reading again after `failures` failed reads in a row, reading every `poll`. */
export const backoff = (failures: number, poll: Duration.Input = POLL): Duration.Duration => {
  const every = Duration.toMillis(Duration.fromInputUnsafe(poll))
  return Duration.millis(Math.min(every * 2 ** Math.min(failures, 4), every * 10))
}

/** What a wait's `pull_request` and `pull_request_events` ask for. */
export interface PrRequest {
  readonly target: Target
  readonly events: ReadonlyArray<PrEvent>
}

/** How a wait keeps its pull request. */
export const storedPr = (r: PrRequest, news: News | null): WaitPr => ({
  url: targetUrl(r.target),
  repo: targetRepo(r.target),
  number: r.target.number,
  events: [...r.events],
  ...(news === null ? {} : { news }),
})

/** A pull request to read, and the GitHub account to read it as (null: gh's active one). */
export interface Reader {
  readonly target: Target
  readonly account: string | null
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

/** Why gh failed, from what it printed. */
export const ghError = (out: GhResult): string => {
  let err = out.stderr.trim()
  while (err.startsWith("gh: ")) err = err.slice(4)
  return `gh failed: ${err}`
}

export interface PrWatchShape {
  /**
   * The pull request (`pr`: a number or text, see `parseTarget`) that `task`'s agent asked to wait on, and the news
   * that ends the wait (`events`: null for all of it; those named are added to `ALWAYS`). Fails with why not.
   */
  readonly request: (task: Task, pr: string | number, events: ReadonlyArray<string> | null) => Effect.Effect<PrRequest, PrUnreadable>
  /** The reader of pull request `url` (a task's `pr_url`) as `task`'s GitHub account, unless that account can't read it. */
  readonly readerFor: (task: Task, url: string) => Effect.Effect<Reader, PrUnreadable>
  /** The reader of a pull request a wait watches, as its task's GitHub account. */
  readonly readerOf: (task: Task, target: Target) => Effect.Effect<Reader>
  /** The pull request as GitHub has it now. */
  readonly read: (reader: Reader) => Effect.Effect<Pr, PrUnreadable>
  /** A GraphQL query's answer, as `account` on `host`, with string `vars` and number `numbers`. */
  readonly graphql: (
    account: string | null,
    host: string,
    query: string,
    vars: ReadonlyArray<readonly [string, string]>,
    numbers: ReadonlyArray<readonly [string, number]>,
  ) => Effect.Effect<unknown, PrUnreadable>
  /**
   * Read the pull request and see what's news to `task`'s agent since it was last told (`events` only). What isn't news
   * (its own comments, a conflict that's gone) is stored as seen now; news, for the call `call` to report, is stored
   * apart until it does (`delivered`). The news, if any.
   */
  readonly poll: (task: TaskId, call: string, events: ReadonlyArray<string>, reader: Reader) => Effect.Effect<News | null, PrUnreadable>
  /**
   * Read the pull request a stored wait watches (straight away with `readNow`, a wait carried on after a restart; else
   * after `PrPoll`), then every `PrPoll`, until there's news, which it records on the wait (if it's still waiting), or it
   * has failed `GIVE_UP` times in a row. Interrupting it stores nothing more.
   */
  readonly watch: (task: Task, wait: AgentWait, readNow: boolean) => Effect.Effect<void>
  /** The news the wait `call` found on `pr` has reached the agent: it's been told. */
  readonly delivered: (task: TaskId, call: string, pr: WaitPr) => Effect.Effect<void>
  /** What the last read of `pr` for `task` found, with when, for a wait that ended otherwise. */
  readonly last: (task: TaskId, pr: WaitPr) => Effect.Effect<unknown>
  /** The news `call` found about pull request `key` has reached `task`'s agent, if it's still the news kept: `also` changes the row with it. */
  readonly told: (task: TaskId, key: string, call: string, also?: (row: WatchRow) => WatchRow) => Effect.Effect<void>
  /**
   * Keep how the checks of `task`'s pull request `target` stood at a read (its head commit `head`'s `checks`) on the
   * task, so the board shows them: unless the task's pull request is another one now, and only if they changed.
   */
  readonly recordChecks: (task: TaskId, target: Target, head: string, checks: ReadonlyArray<Check>) => Effect.Effect<void>
  /**
   * The ends of the logs of `checks`' failed steps, by index, for those that are GitHub Actions jobs (`LOGS_MAX` at most),
   * read with `gh run view --log-failed` as the reader's account: null for the others.
   */
  readonly failedLogs: (reader: Reader, checks: ReadonlyArray<Check>) => Effect.Effect<ReadonlyArray<LogResult>>
  /** `pr`'s failed checks were sent to `task`'s agent by hand: they're not news to it any more. */
  readonly toldFailures: (task: TaskId, key: string, pr: Pr) => Effect.Effect<void>
  /** What `task`'s agent has been told about pull request `key`, and the read kept with it. */
  readonly row: (task: TaskId, key: string) => Effect.Effect<WatchRow | null>
  /** Keep `row` as what `task`'s agent has been told about pull request `key`. */
  readonly putRow: (task: TaskId, key: string, row: WatchRow) => Effect.Effect<void>
}

export class PrWatch extends Context.Service<PrWatch, PrWatchShape>()("huntaway-server/github/PrWatch") {
  static readonly layer = Layer.effect(
    PrWatch,
    Effect.gen(function* () {
      const gh = yield* Gh
      const base = yield* TaskBase
      const repo = yield* PrWatchRepo
      const tasks = yield* TaskRepo
      const projects = yield* ProjectRepo
      const { tx } = yield* Db
      const events = yield* Events
      const config = yield* ServerConfig

      /** The host and `OWNER/REPO` of the repository `task`'s branch is pushed to, if it has one. */
      const taskRepo = Effect.fnUntraced(function* (task: Task) {
        if (task.project_id === null) return null
        const project = Option.getOrNull(yield* projects.get(task.project_id))
        if (project === null) return null
        const remote = yield* base.remoteBase(task, project)
        const found = yield* base.pushRepo(expandHome(project.repo_path, config.home), remote)
        if (found === null) return null
        const [host, ownerRepo] = found
        const where: readonly [string, string] = [isGithubCom(host) ? "github.com" : host, ownerRepo]
        return where
      })

      const request = Effect.fn("PrWatch.request")(function* (task: Task, pr: string | number, asked: ReadonlyArray<string> | null) {
        let evs: Array<PrEvent>
        if (asked === null) evs = [...EVENTS]
        else {
          evs = [...ALWAYS]
          for (const e of asked) {
            const known = EVENTS.find((x) => x === e)
            if (known === undefined) return yield* unreadableBy(`pull_request_events takes ${EVENTS.join(", ")} (got "${e}")`)
            if (!evs.includes(known)) evs.push(known)
          }
        }
        const given = typeof pr === "number" ? String(pr) : pr
        const target = parseTarget(given, yield* taskRepo(task))
        if (Result.isFailure(target)) return yield* unreadableBy(target.failure)
        const t = target.success
        const account = yield* base.account(task)
        const a = account === null ? null : parseAccount(account)
        if (a !== null && a.host !== t.host) {
          // Its host came from the task's remote, which may name it in a way that isn't GitHub's.
          if (!given.trim().startsWith("http")) {
            return yield* unreadableBy(
              `this task's repository is pushed to ${t.host}, but its GitHub account ${accountName(a)} is on ${a.host}: give the pull request's URL (https://${a.host}/OWNER/REPO/pull/NUMBER)`,
            )
          }
          return yield* unreadableBy(`${targetLabel(t)} is on ${t.host}, but this task's GitHub account ${accountName(a)} is on ${a.host}, so it can't be read`)
        }
        const r: PrRequest = { target: t, events: evs }
        return r
      })

      const readerFor = Effect.fn("PrWatch.readerFor")(function* (task: Task, url: string) {
        const target = parseTarget(url, null)
        if (Result.isFailure(target)) return yield* unreadableBy(target.failure)
        const account = yield* base.account(task)
        const a = account === null ? null : parseAccount(account)
        if (a !== null && a.host !== target.success.host) {
          return yield* unreadableBy(`it's on ${target.success.host}, but the task's GitHub account ${accountName(a)} is on ${a.host}`)
        }
        const reader: Reader = { target: target.success, account }
        return reader
      })

      const readerOf = Effect.fnUntraced(function* (task: Task, target: Target) {
        const reader: Reader = { target, account: yield* base.account(task) }
        return reader
      })

      const graphql = Effect.fn("PrWatch.graphql")(function* (
        account: string | null,
        host: string,
        query: string,
        vars: ReadonlyArray<readonly [string, string]>,
        numbers: ReadonlyArray<readonly [string, number]>,
      ) {
        const args = ["api", "graphql", "-f", `query=${query}`]
        for (const [k, v] of vars) args.push("-f", `${k}=${v}`)
        for (const [k, n] of numbers) args.push("-F", `${k}=${n}`)
        if (host !== "github.com") args.push("--hostname", host)
        const out = yield* gh.gh(args, { account, timeout: GH_TIMEOUT }).pipe(Effect.mapError((e) => unreadableBy(e.message)))
        // gh prints GraphQL errors' answer too, and exits with 1.
        const v = objOrNull(Option.getOrNull(decodeJson(out.stdout)))
        if (v !== null) {
          const answer: unknown = v
          return answer
        }
        return yield* unreadableBy(ghError(out))
      })

      /** One query for the pull request at `reader`, with `after` for a page of its review threads. */
      const query = (reader: Reader, q: string, after: string | null) => {
        const t = reader.target
        return graphql(
          reader.account,
          t.host,
          q,
          [["owner", t.owner], ["name", t.name], ...(after === null ? [] : [["after", after] as const])],
          [["number", t.number]],
        )
      }

      const read = Effect.fn("PrWatch.read")(function* (reader: Reader) {
        let v = yield* query(reader, QUERY, null)
        for (let i = 1; i < THREAD_PAGES; i++) {
          const after = nextThreads(v)
          if (after === null) break
          const more = withThreads(v, yield* query(reader, THREADS, after))
          if (Result.isFailure(more)) return yield* unreadableBy(more.failure)
          v = more.success
        }
        const pr = parsePr(v)
        return Result.isSuccess(pr) ? pr.success : yield* unreadableBy(pr.failure)
      })

      const publish = Effect.fnUntraced(function* (id: TaskId) {
        const t = yield* tasks.get(id)
        if (t !== null) yield* events.emit({ type: "task", task: t })
      })

      const recordChecks = Effect.fn("PrWatch.recordChecks")(function* (id: TaskId, target: Target, head: string, checks: ReadonlyArray<Check>) {
        const now = yield* nowTimestamp
        yield* tx(
          Effect.gen(function* () {
            const task = yield* tasks.get(id)
            if (task === null) return
            // Unless the task's pull request is another one now.
            const on = targetOfUrl(task.pr_url)
            if (on === null || targetKey(on) !== targetKey(target)) return
            const fresh = boardChecks(targetUrl(target), head, checks, now)
            if (sameChecks(task.pr_checks, fresh)) return
            yield* tasks.write(id, { pr_checks: fresh }, now)
            yield* publish(id)
          }),
        )
      })

      const poll = Effect.fn("PrWatch.poll")(function* (id: TaskId, call: string, wanted: ReadonlyArray<string>, reader: Reader) {
        const pr = yield* read(reader)
        if (pr.state === "open") yield* recordChecks(id, reader.target, pr.head, pr.checks)
        const key = targetKey(reader.target)
        const now = yield* nowTimestamp
        return yield* tx(
          Effect.gen(function* () {
            const row = yield* repo.get(id, key)
            const found = compare(row === null ? null : row.seen, pr, wanted, true)
            const kept = withoutPending(row ?? emptyRow)
            const next: WatchRow = {
              ...kept,
              seen: found.quiet,
              ...(found.news === null ? {} : { pending: { call_id: call, told: found.news.told } }),
              last: summary(pr),
              polled_at: now,
            }
            yield* repo.put(id, key, next, now)
            return found.news === null ? null : found.news.news
          }),
        )
      })

      /** Keep `news` on the wait `call` (if it's still waiting and has none), which ends it. */
      const record = Effect.fnUntraced(function* (id: TaskId, call: string, news: News) {
        const now = yield* nowTimestamp
        yield* tx(
          Effect.gen(function* () {
            // One read and write with nothing in between, as for a subagent's end.
            const w = (yield* tasks.get(id))?.agent_wait ?? null
            if (w === null || w.call_id !== call) return
            const pr = w.pull_request
            if (pr === undefined || pr.news !== undefined) return
            yield* tasks.write(id, { agent_wait: { ...w, pull_request: { ...pr, news } } }, now)
            yield* publish(id)
          }),
        )
      })

      const watch = Effect.fn("PrWatch.watch")(function* (task: Task, wait: AgentWait, readNow: boolean) {
        const pr = wait.pull_request
        if (pr === undefined || pr.news !== undefined) return
        const target = targetOf(pr)
        if (target === null) return
        const reader = yield* readerOf(task, target)
        const every = yield* PrPoll
        let failures = 0
        let next: Duration.Input = readNow ? Duration.zero : every
        while (true) {
          yield* Effect.sleep(next)
          const news = yield* Effect.result(poll(task.id, wait.call_id, pr.events, reader))
          if (Result.isFailure(news)) {
            failures++
            const msg = news.failure.reason
            yield* Effect.logWarning(`task=${task.id} pr=${targetLabel(target)} failures=${failures}: reading a pull request: ${msg}`)
            if (failures >= GIVE_UP) {
              yield* record(task.id, wait.call_id, unreadable(targetLabel(target), target.number, targetUrl(target), GIVE_UP, msg))
              return
            }
            next = backoff(failures, every)
            continue
          }
          if (news.success !== null) {
            yield* record(task.id, wait.call_id, news.success)
            return
          }
          failures = 0
          next = every
        }
      })

      const told = Effect.fn("PrWatch.told")(function* (id: TaskId, key: string, call: string, also?: (row: WatchRow) => WatchRow) {
        const now = yield* nowTimestamp
        yield* tx(
          Effect.gen(function* () {
            const row = yield* repo.get(id, key)
            if (row === null) return
            const next = toldOf(row, call, also)
            if (next !== null) yield* repo.put(id, key, next, now)
          }),
        )
      })

      const delivered = Effect.fn("PrWatch.delivered")(function* (id: TaskId, call: string, pr: WaitPr) {
        const target = targetOf(pr)
        if (target !== null) yield* told(id, targetKey(target), call)
      })

      const last = Effect.fn("PrWatch.last")(function* (id: TaskId, pr: WaitPr) {
        const target = targetOf(pr)
        if (target === null) return null
        const row = yield* repo.get(id, targetKey(target))
        if (row === null) return null
        return { ...row.last, read_at: row.polled_at }
      })

      const failedLogs = Effect.fn("PrWatch.failedLogs")(function* (reader: Reader, checks: ReadonlyArray<Check>) {
        const logs: Array<LogResult> = []
        for (const c of checks) {
          if (c.job === null || logs.filter((l) => l !== null).length >= LOGS_MAX) {
            logs.push(null)
            continue
          }
          const args = ["run", "view", "--job", String(c.job), "--log-failed", "-R", targetRepo(reader.target)]
          const out = yield* Effect.result(gh.gh(args, { account: reader.account, timeout: GH_TIMEOUT }))
          if (Result.isFailure(out)) logs.push({ _tag: "Unreadable", error: out.failure.message })
          else if (out.success.code !== 0) logs.push({ _tag: "Unreadable", error: ghError(out.success) })
          else logs.push({ _tag: "Log", text: logTail(out.success.stdout) })
        }
        const all: ReadonlyArray<LogResult> = logs
        return all
      })

      const toldFailuresOf = Effect.fn("PrWatch.toldFailures")(function* (id: TaskId, key: string, pr: Pr) {
        const now = yield* nowTimestamp
        yield* tx(
          Effect.gen(function* () {
            yield* repo.put(id, key, toldFailures(yield* repo.get(id, key), pr), now)
          }),
        )
      })

      return PrWatch.of({
        request,
        readerFor,
        readerOf,
        read,
        graphql,
        poll,
        watch,
        delivered,
        last,
        told,
        recordChecks,
        failedLogs,
        toldFailures: toldFailuresOf,
        row: (id, key) => repo.get(id, key),
        putRow: (id, key, row) => Effect.flatMap(nowTimestamp, (now) => repo.put(id, key, row, now)),
      })
    }),
  )
}
