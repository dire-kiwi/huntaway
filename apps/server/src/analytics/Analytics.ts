import { Context, DateTime, Effect, Layer, Option } from "effect"
import { Invalid, NotFound, Timestamp } from "@huntaway/contracts"
import type {
  AnalyticsProject,
  AnalyticsReport,
  AnalyticsTask,
  ContextReport,
  ProfileId,
  ReviewRow,
  RoundRow,
  TokenReport,
  UsageRow,
  UsageTask,
} from "@huntaway/contracts"
import { DEFAULT_START } from "../prompts/projectDefaults.ts"
import { ThreadReaders } from "../threads/ThreadReaders.ts"
import type { UserMessageData } from "../threads/ThreadReaders.ts"
import { AnalyticsRepo } from "./AnalyticsRepo.ts"

// A profile's analytics (the old analytics.ts; inventory 07, sections 2 and 3): when the user prompted which task and
// when agents ran, for time tracking (`report`); how big contexts got (`contextStats`); and the tokens agents used and
// what reviews found (`tokenStats`). Built from what threads and runs already record, so it covers history from before
// it existed. The UI turns the events into active time and calendar views; this only picks them out. Review threads
// count towards the task they review.
//
// The old server ran these on its one thread; here they are reads on the board's connection, which other fibers wait
// for while they run (docs/plan/04-database.md's "slow reads go to a worker" is not built: the reads are indexed, and
// a year of the live board's runs reads in tens of milliseconds).

/** The board's own prompt when a task is started, before those messages were marked `start`. */
export const START_TEXT = DEFAULT_START
/** The board's prompt when the user moves a task to "Ready for merge". */
export const MERGE_PREFIX = 'The user moved this task to "Ready for merge"'
/** Prompts are cut to this many characters; the dashboard only shows a preview. */
export const TEXT_LIMIT = 280

/** What a user message on a thread counts as, if anything: `prompt`, `start` or `merge`. */
export const classify = (data: Pick<UserMessageData, "text" | "auto" | "from_agent" | "start">): "prompt" | "start" | "merge" | null => {
  if (data.from_agent === true) return null
  if (data.auto !== true) return "prompt"
  if (data.start === true || data.text === START_TEXT) return "start"
  if (data.text.startsWith(MERGE_PREFIX)) return "merge"
  return null
}

export const clip = (text: string): string => {
  const cs = Array.from(text)
  return cs.length > TEXT_LIMIT ? `${cs.slice(0, TEXT_LIMIT).join("").trimEnd()}…` : text
}

const RFC3339 = /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}:\d{2}:\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/

/** An RFC 3339 time as stored times are written (so they compare as strings), or null. */
export const parseTs = (s: string): string | null => {
  const m = RFC3339.exec(s)
  if (m === null) return null
  const frac = m[3] === undefined ? "" : m[3].slice(0, 4).padEnd(4, "0")
  const zone = (m[4] ?? "Z").toUpperCase()
  return Option.match(DateTime.make(`${m[1]}T${m[2]}${frac}${zone}`), { onNone: () => null, onSome: DateTime.formatIso })
}

const byteOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Every round of review of `tasks` from `subs` (each task's submissions by round), and the number of each task's rounds
 * by when they started (keyed `<task>\0<round>`). A round is its submissions' `round`.
 */
export const reviewRounds = (
  subs: ReadonlyArray<{ readonly task: string; readonly rows: ReadonlyArray<{ readonly round: string; readonly verdict: string; readonly serious: number }> }>,
): [Array<RoundRow>, Map<string, number>] => {
  const rounds: Array<{ task_id: string; round: number; at: string; verdict: string; serious: number; reviewers: number }> = []
  const numbers = new Map<string, number>()
  for (const { task, rows } of subs) {
    let n = 0
    for (const { round, verdict, serious } of rows) {
      const last = rounds.at(-1)
      if (last === undefined || last.task_id !== task || last.at !== round) {
        n++
        rounds.push({ task_id: task, round: n, at: round, verdict: "pass", serious: 0, reviewers: 0 })
      }
      const r = rounds.at(-1)
      if (r === undefined) continue
      r.reviewers++
      r.serious += serious
      if (verdict === "issues") r.verdict = "issues"
      numbers.set(`${task}\u0000${round}`, r.round)
    }
  }
  return [rounds, numbers]
}

export interface AnalyticsShape {
  readonly report: (profile: ProfileId, from: string, to: string) => Effect.Effect<AnalyticsReport, Invalid | NotFound>
  readonly contextStats: (profile: ProfileId, from: string, to: string) => Effect.Effect<ContextReport, Invalid | NotFound>
  readonly tokenStats: (profile: ProfileId, from: string, to: string) => Effect.Effect<TokenReport, Invalid | NotFound>
}

export class Analytics extends Context.Service<Analytics, AnalyticsShape>()("huntaway-server/analytics/Analytics") {
  static readonly layer = Layer.effect(
    Analytics,
    Effect.gen(function* () {
      const repo = yield* AnalyticsRepo
      const readers = yield* ThreadReaders

      const range = Effect.fnUntraced(function* (profile: ProfileId, from: string, to: string) {
        const f = parseTs(from)
        if (f === null) return yield* new Invalid({ field: "from", reason: "from must be an RFC 3339 time" })
        const t = parseTs(to)
        if (t === null) return yield* new Invalid({ field: "to", reason: "to must be an RFC 3339 time" })
        if (!(yield* repo.profileExists(profile))) return yield* new NotFound({ what: "profile", id: profile })
        return [f, t] as const
      })

      /** The tasks `ids` refer to (by id, byte order), and the profile's projects. */
      const tasksAndProjects = Effect.fnUntraced(function* (profile: ProfileId, ids: ReadonlyArray<string>) {
        const tasks: Array<AnalyticsTask> = []
        for (const id of [...new Set(ids)].toSorted(byteOrder)) {
          const t = yield* repo.task(id)
          if (t !== null) tasks.push(t)
        }
        const projects: ReadonlyArray<AnalyticsProject> = yield* repo.projects(profile)
        return [tasks, projects] as const
      })

      const report = Effect.fn("Analytics.report")(function* (profile: ProfileId, fromText: string, toText: string) {
        const [from, to] = yield* range(profile, fromText, toText)
        const owner = new Map((yield* repo.owners(profile)).map((r) => [r.id, r.owner]))
        const events: Array<AnalyticsReport["events"][number]> = []
        for (const m of yield* readers.userMessagesBetween(profile, Timestamp.make(from), Timestamp.make(to))) {
          const kind = classify(m.data)
          if (kind === null) continue
          events.push({ at: m.at, task_id: owner.get(m.task_id) ?? m.task_id, kind, text: kind === "prompt" ? clip(m.data.text) : "" })
        }
        const runs = (yield* repo.runSpans(profile, from, to)).map((r) => ({ task_id: r.owner, kind: r.kind, started_at: r.created_at, ended_at: r.ended_at }))
        const [tasks, projects] = yield* tasksAndProjects(profile, [...events.map((e) => e.task_id), ...runs.map((r) => r.task_id)])
        return { events, runs, tasks, projects }
      })

      const contextStats = Effect.fn("Analytics.contextStats")(function* (profile: ProfileId, fromText: string, toText: string) {
        const [from, to] = yield* range(profile, fromText, toText)
        const stats = yield* repo.contextStats(profile, from, to)
        const [tasks, projects] = yield* tasksAndProjects(
          profile,
          stats.map((s) => s.task_id),
        )
        return { stats, tasks, projects }
      })

      const tokenStats = Effect.fn("Analytics.tokenStats")(function* (profile: ProfileId, fromText: string, toText: string) {
        const [from, to] = yield* range(profile, fromText, toText)
        const usage: Array<UsageRow> = (yield* repo.runUsage(profile, from, to)).map((r) => ({
          run_id: r.run_id,
          call_id: null,
          task_id: r.task_id,
          kind: r.kind,
          at: r.created_at,
          model: r.model,
          runtime: r.runtime,
          input_tokens: r.input_tokens,
          output_tokens: r.output_tokens,
          cache_read_tokens: r.cache_read_tokens,
          cache_write_tokens: r.cache_write_tokens,
          cache_write_1h_tokens: r.cache_write_1h_tokens,
          cache_write_5m_tokens: r.cache_write_5m_tokens,
          reasoning_tokens: r.reasoning_tokens,
          cost_usd: r.cost_usd,
          estimated: r.estimated !== 0,
        }))
        for (const r of yield* repo.callUsage(profile, from, to)) {
          usage.push({
            run_id: null,
            call_id: r.call_id,
            task_id: r.task_id,
            kind: r.purpose,
            at: r.at,
            model: r.model,
            runtime: r.runtime,
            input_tokens: r.input_tokens,
            output_tokens: r.output_tokens,
            cache_read_tokens: r.cache_read_tokens,
            cache_write_tokens: r.cache_write_tokens,
            cache_write_1h_tokens: r.cache_write_1h_tokens,
            cache_write_5m_tokens: r.cache_write_5m_tokens,
            reasoning_tokens: r.reasoning_tokens,
            cost_usd: r.cost_usd,
            estimated: false,
          })
        }
        usage.sort((a, b) => byteOrder(a.at, b.at))

        const stats = yield* repo.reviewStats(profile, from, to)
        const reviews: Array<{ -readonly [K in keyof ReviewRow]: ReviewRow[K] }> = []
        for (const r of stats) {
          reviews.push({
            task_id: r.task_id,
            thread_id: r.thread_id,
            at: r.at,
            verdict: r.verdict,
            serious: r.serious,
            minor: r.minor,
            minor_noted: r.minor_noted !== 0,
            label: r.label,
            model: r.run_id === null ? null : yield* repo.runModel(r.run_id),
            round: 0,
            effort: r.effort,
            task_model: yield* repo.taskModelBefore(r.task_id, r.at),
          })
        }
        const reviewed = [...new Set(reviews.map((r) => r.task_id))].toSorted(byteOrder)
        const subs: Array<{ task: string; rows: ReadonlyArray<{ round: string; verdict: string; serious: number }> }> = []
        for (const task of reviewed) subs.push({ task, rows: yield* repo.rounds(task) })
        const [rounds, numbers] = reviewRounds(subs)
        reviews.forEach((r, i) => {
          r.round = numbers.get(`${r.task_id}\u0000${stats[i]?.round ?? ""}`) ?? 0
        })

        // The tasks the rows are for, with the tasks their threads review.
        const seen = new Set<string>([...usage.flatMap((u) => (u.task_id === null ? [] : [u.task_id])), ...reviews.flatMap((r) => [r.task_id, r.thread_id])])
        const ids = [...seen]
        for (let i = 0; i < ids.length; i++) {
          const id = ids[i]
          if (id === undefined) continue
          const p = yield* repo.parentOf(id)
          if (p !== null && !seen.has(p)) {
            seen.add(p)
            ids.push(p)
          }
        }
        const followUps = (yield* repo.followUps(profile))
          .map((r) => ({ task_id: r.id, created_by: r.created_by, at: r.created_at }))
          .filter((f) => seen.has(f.created_by))
        const [infos, projects] = yield* tasksAndProjects(profile, [...ids, ...followUps.map((f) => f.task_id)])
        const tasks: Array<UsageTask> = []
        for (const info of infos) {
          const extra = yield* repo.taskExtra(info.id)
          tasks.push({
            id: info.id,
            project_id: info.project_id,
            kind: info.kind,
            number: info.number,
            title: info.title,
            status: info.status,
            parent_id: extra?.parent_id ?? null,
            task_type: extra?.task_type ?? null,
            subproject: false,
            group_name: extra?.group_name ?? null,
            model: extra?.model ?? null,
          })
        }
        const pending = yield* repo.pending(profile)
        return { usage, reviews, rounds, follow_ups: followUps, tasks, projects, pending }
      })

      return Analytics.of({ report, contextStats, tokenStats })
    }),
  )
}
