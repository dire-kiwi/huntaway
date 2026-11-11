import { Context, DateTime, Effect, Layer, Option } from "effect"
import { SecureRandom } from "effect/crypto"
import { TaskId, Timestamp } from "@huntaway/contracts"
import type { AssistantMode, AutomationId, Notice, RunOutcome, Task } from "@huntaway/contracts"
import { Actor } from "../platform/Changes.ts"
import type { Change } from "../platform/Changes.ts"
import { nowTimestamp } from "../platform/columns.ts"
import { Db } from "../platform/Db.ts"
import { Events } from "../platform/Events.ts"
import { ProfileRepo } from "../profiles/ProfileRepo.ts"
import { outcomeOf } from "../runs/finish.ts"
import { RunRepo } from "../runs/RunRepo.ts"
import { Runs } from "../runs/Runs.ts"
import { TaskDeletion } from "../runs/TaskDeletion.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { ThreadReaders } from "../threads/ThreadReaders.ts"
import { Threads } from "../threads/Threads.ts"
import { AutomationRepo } from "./AutomationRepo.ts"
import type { StoredAutomation } from "./AutomationRepo.ts"
import { cut, render, untrustedNote } from "./delivery.ts"
import type { Vars } from "./delivery.ts"
import { failed } from "./precheck.ts"
import type { RunStopped } from "./precheck.ts"
import { RoutineHost } from "./RoutineHost.ts"
import { DAY, dayStart, dayTimeText, isoOf, parseTime, whenText } from "./schedule.ts"
import type { Zone } from "./schedule.ts"

// Routines: a profile's automations, which wake its assistant (huntaway's automations/routines.ts;
// docs/plan/inventory/06-integrations.md 2.3). A routine's message goes to the assistant's own thread (`thread`), or by
// default (`fresh`) to a new thread under it (`task_type` `routine`, `parent_id` the assistant, off the board), which
// works in the assistant's workspace with its tools, config and model. When that thread's agent stops, its last message
// is posted in the assistant's thread as a report, unless it's `NO_REPLY` or empty. The assistant reads the reports it
// hasn't seen with its next prompt (`unreadReports`, `markRead`: the assistant's launch, 6.7). Routine threads are
// pruned `KEEP_THREAD_DAYS` after they finish.

/** What a routine's agent says when it has nothing to report. */
export const NO_REPLY = "NO_REPLY"
/** Finished routine threads older than this are deleted (their runs and reports stay). */
export const KEEP_THREAD_DAYS = 14
/** A report in the assistant's thread is cut to this. */
const MAX_REPORT_CHARS = 20_000

/**
 * Whether a routine's last message says it has nothing to report: empty, or `NO_REPLY` (on its own, or as its last line,
 * in backticks or bold or not).
 */
export const isQuiet = (text: string): boolean => {
  const last = text
    .split("\n")
    .map((l) => l.trim())
    .findLast((l) => l !== "")
  if (last === undefined) return true
  const strip = "`*_.\"' "
  let i = 0
  let j = last.length
  while (i < j && strip.includes(last.charAt(i))) i++
  while (j > i && strip.includes(last.charAt(j - 1))) j--
  return last.slice(i, j) === NO_REPLY
}

/** Why a message couldn't be sent, as a run's detail says it. */
const sendError = (e: { readonly _tag: string; readonly detail?: string }) => failed(e.detail ?? (e._tag === "TaskNotFound" ? "the assistant is gone" : e._tag))

const str = (v: unknown, fallback: string) => (typeof v === "string" ? v : fallback)

/** How a routine thread's agent stopped. */
export type ThreadOutcome = { readonly _tag: "Ok" } | { readonly _tag: "Cancelled" } | { readonly _tag: "Failed"; readonly reason: string }

/** The reports the assistant hasn't read, as the preface of its next prompt, and the notices to mark read once it has started with them. */
export interface UnreadReports {
  readonly text: string
  readonly reports: ReadonlyArray<Notice>
}

type RunExited = Extract<Change, { readonly _tag: "RunExited" }>

export interface RoutinesShape {
  /**
   * Sends routine `a`'s message (for its run `run`) to its profile's assistant, `mode` deciding where: the thread it
   * made or messaged, or why it couldn't. The run is linked to that thread before its agent starts, so a run that ends at
   * once still finds it.
   */
  readonly message: (a: StoredAutomation, run: string, vars: Vars, how: string, text: string, mode: AssistantMode) => Effect.Effect<TaskId, RunStopped>
  /** A routine thread's agent stopped: its report goes to the assistant, unless it had nothing to say, and its run records how it ended and what it cost. */
  readonly finished: (thread: Task, outcome: ThreadOutcome, attention: string | null) => Effect.Effect<void>
  /**
   * The reactor's step for `RunExited` (after `RunEnds`): the automation runs whose messages the run took in record its
   * cost, and a routine thread's run reports.
   */
  readonly runEnded: (change: RunExited) => Effect.Effect<void>
  /** The reports posted in the assistant's thread since it last read them; null if none (6.7 prefaces the assistant's prompt with them). */
  readonly unreadReports: (assistant: TaskId) => Effect.Effect<UnreadReports | null>
  /** The assistant's agent has started with these reports: they're read. */
  readonly markRead: (assistant: TaskId, reports: ReadonlyArray<Notice>) => Effect.Effect<void>
  /** What an automation's runs today (in the host's zone) have cost, those still working as far as they've got. */
  readonly spentToday: (automation: AutomationId, now: number) => Effect.Effect<number>
  /** A fresh-thread routine's thread from an earlier run that's still working, or waiting for its usage limit, if any. */
  readonly stillRunning: (a: StoredAutomation) => Effect.Effect<Task | null>
  /** Deletes routine threads that finished more than `KEEP_THREAD_DAYS` ago (their runs and reports stay). */
  readonly pruneThreads: (now: number) => Effect.Effect<void>
  /** An automation (or its runs) changed: `automations_changed`. */
  readonly changed: (a: Pick<StoredAutomation, "id" | "project_id" | "profile_id">) => Effect.Effect<void>
  /** The host's zone, which routines' days and templates' times are in. */
  readonly zone: Zone
}

export class Routines extends Context.Service<Routines, RoutinesShape>()("huntaway-server/automations/Routines") {
  static readonly layer = Layer.effect(
    Routines,
    Effect.gen(function* () {
      const db = yield* Db
      const repo = yield* AutomationRepo
      const host = yield* RoutineHost
      const runs = yield* Runs
      const runRepo = yield* RunRepo
      const tasks = yield* TaskRepo
      const profiles = yield* ProfileRepo
      const threads = yield* Threads
      const readers = yield* ThreadReaders
      const events = yield* Events
      const deletions = yield* TaskDeletion
      const random = yield* SecureRandom.SecureRandom
      // The host's zone; a test gives its own (`DateTime.CurrentTimeZone`).
      const zone = Option.getOrElse(yield* Effect.serviceOption(DateTime.CurrentTimeZone), DateTime.zoneMakeLocal)

      const changed = (a: Pick<StoredAutomation, "id" | "project_id" | "profile_id">) =>
        events.emit({ type: "automations_changed", project_id: a.project_id, profile_id: a.profile_id, automation_id: a.id })

      /** A thread of its own under the assistant for a fresh run, linked to the run: in one transaction. */
      const newThread = (assistant: Task, run: string, title: string) =>
        Effect.gen(function* () {
          const id = TaskId.make(yield* random.uuidV4().pipe(Effect.orDie))
          const at = yield* nowTimestamp
          const profile = Option.getOrNull(yield* profiles.get(assistant.profile_id))
          const made = yield* db.tx(
            Effect.gen(function* () {
              yield* tasks.insert(
                id,
                {
                  family: "assistant",
                  profile_id: assistant.profile_id,
                  project_id: null,
                  generateTitle: false,
                  columns: {
                    title,
                    description: "",
                    status: "todo",
                    use_worktree: false,
                    task_type: "routine",
                    parent_id: assistant.id,
                    work_dir: assistant.work_dir,
                    permission_mode: assistant.permission_mode,
                    title_pinned: true,
                    model: assistant.model,
                    effort: assistant.effort,
                    // Each is a new conversation: with the config the profile picks for its assistant, if it picks one.
                    claude_config_id: profile?.assistant_config_id ?? assistant.claude_config_id,
                  },
                },
                at,
              )
              yield* repo.setRunTask(run, id)
              return yield* tasks.get(id)
            }),
          )
          if (made !== null) yield* events.emit({ type: "task", task: made })
          return made
        })

      /** A thread that never started (the host can't run agents, say) would only be in the way. */
      const dropThread = (thread: Task, run: string) =>
        Effect.gen(function* () {
          const gone = yield* db.tx(
            Effect.gen(function* () {
              yield* repo.setRunTask(run, null)
              const t = yield* tasks.get(thread.id)
              if (t === null || t.running) return false
              yield* tasks.delete(thread.id)
              return true
            }),
          )
          if (gone) yield* events.emit({ type: "task_deleted", id: thread.id, project_id: null })
        })

      const message = Effect.fn("Routines.message")(function* (a: StoredAutomation, run: string, vars: Vars, how: string, text: string, mode: AssistantMode) {
        const assistant = yield* host.assistant(a.profile_id).pipe(Effect.mapError((e) => failed(e.reason)))
        const [body, untrusted] = render(text, vars, "text")
        const note = untrusted ? untrustedNote(vars, false) : ""
        if (mode === "thread") {
          // The assistant's run that takes the message in is the routine run's, for its cost: its id goes with the
          // message, through steering and the queue.
          yield* repo.setRunTask(run, assistant.id)
          yield* runs
            .send(assistant.id, { text: `From your routine "${a.name}", ${how}:\n\n${note}${body.trim()}`, source: "routine", automation_run_id: run })
            .pipe(
              Effect.mapError(sendError),
              Effect.tapError(() => repo.setRunTask(run, null)),
            )
          return assistant.id
        }
        const when = whenText(zone, vars.now)
        const thread = yield* newThread(assistant, run, `${a.name} · ${when}`)
        if (thread === null) return yield* failed("the routine's thread couldn't be made")
        const msg =
          `This is a run of your routine "${a.name}", ${how} (${when}), in a thread of its own (A-${thread.number}).\n\n${note}${body.trim()}\n\n` +
          "When you're done, reply with a short report for the user: it's posted to your main thread. If there's nothing " +
          `new or worth telling them, reply with just ${NO_REPLY}, and nothing is posted.`
        // Nobody's there to answer its prompts.
        yield* runs.send(thread.id, { text: msg, source: "routine" }).pipe(
          Effect.mapError(sendError),
          Effect.tapError(() => dropThread(thread, run)),
        )
        return thread.id
      })

      const finished = Effect.fn("Routines.finished")(function* (thread: Task, outcome: ThreadOutcome, attention: string | null) {
        const assistant = thread.parent_id
        if (assistant === null) return
        const run = yield* repo.runOfTask(thread.id)
        const automation = run === null ? null : yield* repo.get(run.automation_id)
        const name = automation?.name ?? thread.title.split(" · ")[0] ?? thread.title
        let kind: RunOutcome
        let text: string | null
        if (outcome._tag === "Cancelled") [kind, text] = ["stopped", null]
        else if (outcome._tag === "Failed") [kind, text] = ["failed", outcome.reason.split("\n")[0] ?? ""]
        else if (attention !== null) [kind, text] = ["asked", attention]
        else {
          const said = (yield* readers.saidSinceAsked(thread.id)) ?? ""
          ;[kind, text] = isQuiet(said) ? ["quiet", null] : ["reported", cut(said.trim(), MAX_REPORT_CHARS)]
        }
        if (text !== null) {
          const data = { automation_id: automation?.id ?? null, automation: name, task_id: thread.id, key: thread.key, outcome: kind, text }
          yield* threads
            .report(assistant, kind === "failed" ? "error" : "info", text, data)
            .pipe(Effect.catchTag("TaskNotFound", () => Effect.logWarning(`task=${thread.id} posting a routine's report: the assistant is gone`)))
        }
        if (run !== null) {
          const now = yield* tasks.get(thread.id)
          yield* repo.setOutcome(run.id, kind, (now ?? thread).cost_usd)
          if (automation !== null) yield* changed(automation)
        }
      })

      const runEnded = Effect.fn("Routines.runEnded")(function* (change: RunExited) {
        const found = yield* runRepo.get(change.run)
        if (Option.isNone(found) || found.value.kind === "compact") return
        const run = found.value
        // What the automation runs whose messages it took cost.
        for (const id of yield* repo.agentRunEnded(run.id)) {
          const a = yield* repo.get(id)
          if (a !== null) yield* changed(a)
        }
        const thread = yield* tasks.get(run.task_id)
        if (thread === null || thread.kind !== "task" || thread.task_type !== "routine") return
        // A later run of its thread reports for itself.
        if (yield* runRepo.laterThan(run)) return
        yield* finished(thread, outcomeOf(run, change.exit, change.errorTail), run.attention)
      })

      const unreadReports = Effect.fn("Routines.unreadReports")(function* (assistant: TaskId) {
        const reports = yield* readers.unreadReports(assistant)
        if (reports.length === 0) return null
        let text = "Since your last turn, your routines posted these in this thread (the user has seen them):\n"
        for (const m of reports) {
          const d = m.metadata ?? {}
          const t = parseTime(m.created_at)
          const at = t === null ? "" : dayTimeText(zone, t)
          const what = d["outcome"] === "failed" ? "failed" : d["outcome"] === "asked" ? "is waiting for the user" : "reported"
          text += `\n### "${str(d["automation"], "A routine")}" ${what} (${str(d["key"], "")}, ${at})\n\n${str(d["text"], m.text).trim()}\n`
        }
        text += "\n---\n\n"
        const out: UnreadReports = { text, reports }
        return out
      })

      const markRead = Effect.fn("Routines.markRead")(function* (assistant: TaskId, reports: ReadonlyArray<Notice>) {
        for (const m of reports) {
          yield* threads.updateItem(assistant, m.id, { metadata: { ...m.metadata, read: true } }).pipe(Effect.ignore)
        }
      })

      const spentToday = (automation: AutomationId, now: number) => repo.spent(automation, Timestamp.make(isoOf(dayStart(zone, now))))

      const stillRunning = Effect.fn("Routines.stillRunning")(function* (a: StoredAutomation) {
        if (!(a.action.kind === "message_assistant" && a.action.mode === "fresh")) return null
        const id = yield* repo.stillRunning(a.id)
        return id === null ? null : yield* tasks.get(id)
      })

      const pruneThreads = Effect.fn("Routines.pruneThreads")(function* (now: number) {
        for (const id of yield* repo.oldRoutineThreads(Timestamp.make(isoOf(now - KEEP_THREAD_DAYS * DAY)))) {
          yield* deletions
            .delete(id, { deleteBranch: false }, Actor.board)
            .pipe(Effect.catch((e) => Effect.logWarning(`task=${id} pruning an old routine thread: ${e._tag === "Conflict" ? e.detail : e._tag}`)))
        }
      })

      return Routines.of({ message, finished, runEnded, unreadReports, markRead, spentToday, stillRunning, pruneThreads, changed, zone })
    }),
  )
}
