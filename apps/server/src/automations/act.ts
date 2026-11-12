import { Cause, Clock, Effect, Exit, Option, Ref } from "effect"
import { AgentConfigId, Effort, Timestamp } from "@huntaway/contracts"
import type { AutomationId, AutomationRun, ProjectId, Task, TaskId } from "@huntaway/contracts"
import type { Invalid } from "@huntaway/contracts"
import type { ChildProcessSpawner } from "effect/process"
import type { ProjectRepoShape } from "../projects/ProjectRepo.ts"
import type { RunsShape } from "../runs/Runs.ts"
import { expandTilde } from "../settings/Folders.ts"
import type { TasksShape } from "../tasks/Tasks.ts"
import type { AutomationRepoShape, StoredAutomation, StoredRun } from "./AutomationRepo.ts"
import { eventLabel, render, untrustedNote } from "./delivery.ts"
import type { Delivery, Vars } from "./delivery.ts"
import { failed, runPrecheck, skipped } from "./precheck.ts"
import type { RunStopped } from "./precheck.ts"
import type { RoutineHostShape } from "./RoutineHost.ts"
import type { RoutinesShape } from "./Routines.ts"
import { activeContains, activeText, formatLocal, isoOf } from "./schedule.ts"
import type { Zone } from "./schedule.ts"

// Running an automation once it's due or asked for (huntaway's automations/running.ts `run_action`, `guards`, `act`):
// the guards first (a routine's assistant is on this host, active hours, the budget, a fresh thread still going, the
// precheck), then the action, and how it went recorded on the run.

/** What made a run. */
export type RunSource = AutomationRun["source"]

/** What running an automation needs. */
export interface ActDeps {
  readonly repo: AutomationRepoShape
  readonly routines: RoutinesShape
  readonly host: RoutineHostShape
  readonly tasks: TasksShape
  readonly runs: RunsShape
  readonly projects: ProjectRepoShape
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]
  readonly agentEnv: Readonly<Record<string, string | undefined>>
  readonly home: string
  /**
   * Fresh-thread routines past the check that their last thread is over and not yet with a thread of their own: a
   * precheck takes a while, and another run checked meanwhile would find no thread running and start one beside it.
   */
  readonly starting: Ref.Ref<ReadonlySet<string>>
  readonly zone: Zone
  readonly targetTask: (project: ProjectId, task: string) => Effect.Effect<Task, Invalid>
}

/** A new run's row. */
export const makeRun = (id: string, automation: AutomationId, source: RunSource, status: AutomationRun["status"], at: Timestamp): StoredRun => ({
  id,
  automation_id: automation,
  source,
  status,
  detail: null,
  outcome: null,
  cost_usd: null,
  task_id: null,
  delivery_id: null,
  event: null,
  count: 1,
  batch_id: null,
  due_at: null,
  created_at: at,
  finished_at: null,
  agent_run_id: null,
  batch_key: null,
  payload: null,
})

/** What a run says it did, for the description of the task it makes or the message it sends. */
const howOf = (source: RunSource, ev: string | null): string => {
  if (source === "schedule") return "on its schedule"
  if (source === "webhook") return ev !== null ? `from a webhook delivery (${ev})` : "from a webhook delivery"
  if (ev !== null) return `from a test delivery (${ev}) on the board`
  return "by hand, from the board"
}

const money = (n: number) => `$${n.toFixed(2)}`

const isEffort = (e: string | null): e is Effort => e !== null && Effort.literals.some((x) => x === e)

/** Why a service refused, as a run's detail says it. */
const why = (e: { readonly _tag: string; readonly reason?: string; readonly detail?: string; readonly id?: string }): string =>
  e.reason ?? e.detail ?? (e._tag === "ProjectNotFound" ? "the project is gone" : e._tag === "TaskNotFound" ? "the task is gone" : e._tag)

const cantPrecheck = (e: string) => failed(`couldn't run its precheck: ${e}`)

/** Where a precheck runs: the assistant's workspace for a routine, the project's folder for a project's automation. */
const precheckDir = Effect.fnUntraced(function* (d: ActDeps, a: StoredAutomation) {
  if (a.project_id !== null) {
    const p = yield* d.projects.get(a.project_id)
    if (p._tag === "None") return yield* cantPrecheck("the project is gone")
    return expandTilde(p.value.repo_path, d.home)
  }
  const assistant = yield* d.host.assistant(a.profile_id).pipe(Effect.mapError((e) => cantPrecheck(e.reason)))
  // Only its own workspace: not one that's become a symlink, which could be another's.
  return yield* d.host.workspace(assistant).pipe(Effect.mapError((e) => cantPrecheck(e.reason)))
})

/** What a run checks before it does anything; what its precheck printed, if it has one. */
const guards = Effect.fnUntraced(function* (d: ActDeps, a: StoredAutomation, source: RunSource, now: number) {
  // A routine whose profile's assistant has moved to another host: not one that wakes the assistant left here.
  if (a.project_id === null) {
    const elsewhere = yield* d.host.elsewhere(a.profile_id)
    if (elsewhere !== null) return yield* failed(elsewhere)
  }
  const byHand = source === "manual"
  const hours = a.active_hours
  if (!byHand && a.trigger.kind !== "at" && hours !== null && !activeContains(hours, now, d.zone)) {
    return yield* skipped(`Skipped: outside its active hours (${activeText(hours)})`)
  }
  if (!byHand && a.budget_usd !== null) {
    const spent = yield* d.routines.spentToday(a.id, now)
    if (spent >= a.budget_usd) {
      return yield* skipped(`Skipped: over budget (its runs today cost ${money(spent)}, and its budget is ${money(a.budget_usd)} a day)`)
    }
  }
  if (!byHand) {
    const t = yield* d.routines.stillRunning(a)
    if (t !== null) return yield* skipped(`Skipped: its last run (A-${t.number}) is still going`)
  }
  if (a.precheck === null) return null
  return yield* runPrecheck(d.spawner, d.agentEnv, a.precheck, yield* precheckDir(d, a))
})

/** The task the action made or messaged; or why it couldn't (with the task, if it made one but couldn't start it). */
const action = Effect.fnUntraced(function* (d: ActDeps, a: StoredAutomation, run: string, vars: Vars, ev: string | null) {
  const how = howOf(vars.source === "schedule" || vars.source === "webhook" || vars.source === "manual" ? vars.source : "manual", ev)
  const act = a.action
  if (a.project_id === null) {
    if (act.kind !== "message_assistant") return yield* failed("a routine can only message the assistant")
    return yield* d.routines.message(a, run, vars, how, act.message, act.mode)
  }
  const found = yield* d.projects.get(a.project_id)
  if (found._tag === "None") return yield* failed("the project is gone")
  const project = found.value
  if (project.archived_at !== null) return yield* failed("the project is archived")
  if (act.kind === "message_assistant") return yield* failed("message_assistant is for a profile's routines")
  if (act.kind === "create_task") {
    const [rendered, titleUntrusted] = render(act.title, vars, "title")
    const title = rendered !== "" ? rendered : `${a.name} (${formatLocal(d.zone, vars.now)})`
    const [body, bodyUntrusted] = render(act.description, vars, "text")
    let text = titleUntrusted || bodyUntrusted ? untrustedNote(vars, titleUntrusted) : ""
    if (body.trim() !== "") text += `${body.trimEnd()}\n\n`
    text += `*Created by the automation "${a.name}" ${how}.*`
    const t = yield* d.tasks
      .create(
        {
          project_id: project.id,
          title,
          description: text,
          status: act.status,
          task_type: act.task_type,
          labels: act.labels ?? [],
          claude_config_id: act.claude_config_id === null ? null : AgentConfigId.make(act.claude_config_id),
          model: act.model,
          effort: isEffort(act.effort) ? act.effort : null,
        },
        { _tag: "Automation", automation_id: a.id },
      )
      .pipe(Effect.mapError((e) => failed(why(e))))
    // Its first run is the automation run's, for its budget (and the task's later work isn't).
    if (act.start) {
      yield* d.runs
        .send(t.id, { text: "", source: "automation", automation_run_id: run })
        .pipe(Effect.mapError((e) => failed(`created the task, but couldn't start its agent: ${why(e)}`, t.id)))
    }
    return t.id
  }
  const t = yield* d.targetTask(project.id, act.task_id).pipe(Effect.mapError((e) => failed(e.reason)))
  const [body, untrusted] = render(act.message, vars, "text")
  const note = untrusted ? untrustedNote(vars, false) : ""
  // The run that takes it in is the automation run's, for its budget.
  yield* d.runs
    .send(t.id, { text: `From the automation "${a.name}", ${how}:\n\n${note}${body.trim()}`, source: "automation", automation_run_id: run })
    .pipe(Effect.mapError((e) => failed(why(e), t.id)))
  return t.id
})

/** Takes the automation's place among those starting a fresh thread; false if it's there already. */
const takeStart = (starting: Ref.Ref<ReadonlySet<string>>, id: string) =>
  Ref.modify(starting, (all): readonly [boolean, ReadonlySet<string>] => (all.has(id) ? [false, all] : [true, new Set([...all, id])]))

/**
 * Does what the automation does for run `run`, once it has passed its guards, and records how it went (and when it last
 * ran). The run as it ended.
 */
export const act = (d: ActDeps, a: StoredAutomation, run: string, source: RunSource, delivery: Delivery | null, count: number) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const ev = delivery === null ? null : eventLabel(delivery)
    const waits = source !== "manual" && a.action.kind === "message_assistant" && a.action.mode === "fresh"
    const body: Effect.Effect<TaskId, RunStopped> = Effect.gen(function* () {
      const precheck = yield* guards(d, a, source, now)
      // Where Google stands for a routine that asks, as it starts.
      const google =
        a.action.kind === "message_assistant" && a.project_id === null && a.action.message.includes("{{google}}") ? yield* d.host.google(a.profile_id) : null
      const vars: Vars = { automation: a.name, source, delivery, count, now, zone: d.zone, precheck, google }
      return yield* action(d, a, run, vars, ev)
    })
    const guarded: Effect.Effect<TaskId, RunStopped> = waits
      ? Effect.flatMap(takeStart(d.starting, a.id), (took) =>
          took
            ? Effect.ensuring(
                body,
                Ref.update(d.starting, (all) => new Set([...all].filter((x) => x !== a.id))),
              )
            : Effect.fail(skipped("Skipped: its last run is still starting")),
        )
      : body
    const exit = yield* Effect.exit(guarded)
    const at = Timestamp.make(isoOf(yield* Clock.currentTimeMillis))
    if (Exit.isSuccess(exit)) yield* d.repo.finishRun(run, "ok", exit.value, null, at)
    else {
      const stopped = Option.getOrUndefined(Cause.findErrorOption(exit.cause))
      if (stopped === undefined) {
        yield* Effect.logError(`automation ${a.id}: running it`, exit.cause)
        yield* d.repo.finishRun(run, "failed", null, "it failed: see the server's log", at)
      } else if (stopped.skipped) yield* d.repo.finishRun(run, "skipped", null, stopped.detail, at)
      else {
        yield* Effect.logWarning(`automation ${a.id}: automation "${a.name}" failed: ${stopped.detail}`)
        yield* d.repo.finishRun(run, "failed", stopped.task, stopped.detail, at)
      }
    }
    yield* d.repo.setLastRun(a.id, at)
    yield* d.routines.changed(a)
    return yield* d.repo.getRun(run)
  }).pipe(Effect.annotateLogs({ module: "automations" }))
