import { Context, Effect, Layer, Option, Schema } from "effect"
import {
  ActionInput,
  ActiveHours,
  AutomationId,
  AutomationRunStatus,
  ProfileId,
  ProjectId,
  RunOutcome,
  RunSource,
  TaskId,
  Timestamp,
  TriggerInput,
} from "@huntaway/contracts"
import type { Action, AutomationRun, Trigger } from "@huntaway/contracts"
import { Db } from "../platform/Db.ts"
import { Bit, NullableJsonColumn, rowsOf } from "../platform/columns.ts"
import { KEEP_PAYLOADS, KEEP_RECENT, KEEP_RUNS } from "./model.ts"
import { storedAction, storedTrigger } from "./stored.ts"

// The `automations` and `automation_runs` tables (docs/plan/04-database.md; huntaway's automations.ts). Single statements
// and small groups; `SqlError` and `SchemaError` are defects. Nothing here waits. An automation's `token` and `secret`
// and a run's `batch_key` and `payload` are read only here, and never go on the wire.

/** An automation as it's kept: what the board shows of it, with its webhook's token and secret. */
export interface StoredAutomation {
  readonly id: AutomationId
  readonly profile_id: ProfileId
  readonly project_id: ProjectId | null
  readonly name: string
  readonly enabled: boolean
  readonly trigger: Trigger
  readonly action: Action
  /** The secret part of its webhook URL. */
  readonly token: string
  /** Deliveries must be signed with it, if set. */
  readonly secret: string | null
  readonly next_run_at: string | null
  readonly last_run_at: string | null
  readonly active_hours: ActiveHours | null
  readonly precheck: string | null
  readonly budget_usd: number | null
  readonly created_at: Timestamp
  readonly updated_at: Timestamp
}

/** A run as it's kept: the wire's, with its coalescing key and the delivery it runs with. */
export interface StoredRun extends Omit<AutomationRun, "task"> {
  readonly agent_run_id: string | null
  readonly batch_key: string | null
  readonly payload: string | null
}

const AutomationRow = Schema.Struct({
  id: AutomationId,
  profile_id: ProfileId,
  project_id: Schema.NullOr(ProjectId),
  name: Schema.String,
  enabled: Bit,
  trigger: Schema.fromJsonString(TriggerInput),
  action: Schema.fromJsonString(ActionInput),
  token: Schema.String,
  secret: Schema.NullOr(Schema.String),
  next_run_at: Schema.NullOr(Schema.String),
  last_run_at: Schema.NullOr(Schema.String),
  active_hours: NullableJsonColumn(ActiveHours),
  precheck: Schema.NullOr(Schema.String),
  budget_usd: Schema.NullOr(Schema.Finite),
  created_at: Timestamp,
  updated_at: Timestamp,
})
/** A row read leniently: one whose trigger or action doesn't read (written by something else) is left out. */
const AutomationRowOrNot = Schema.Union([AutomationRow, Schema.Unknown])
const isAutomationRow = Schema.is(AutomationRow)

const toAutomation = (r: typeof AutomationRow.Type): StoredAutomation => ({ ...r, trigger: storedTrigger(r.trigger), action: storedAction(r.action) })

const RunRow = Schema.Struct({
  id: Schema.String,
  automation_id: AutomationId,
  source: RunSource,
  status: AutomationRunStatus,
  detail: Schema.NullOr(Schema.String),
  outcome: Schema.NullOr(RunOutcome),
  cost_usd: Schema.NullOr(Schema.Finite),
  task_id: Schema.NullOr(TaskId),
  delivery_id: Schema.NullOr(Schema.String),
  event: Schema.NullOr(Schema.String),
  count: Schema.Int,
  batch_id: Schema.NullOr(Schema.String),
  due_at: Schema.NullOr(Schema.String),
  created_at: Timestamp,
  finished_at: Schema.NullOr(Schema.String),
  agent_run_id: Schema.NullOr(Schema.String),
  batch_key: Schema.NullOr(Schema.String),
  payload: Schema.NullOr(Schema.String),
})

const automationRows = rowsOf(AutomationRowOrNot)
const runRows = rowsOf(RunRow)
const ArchivedRow = Schema.Struct({ id: AutomationId, archived: Bit })
const archivedRows = rowsOf(ArchivedRow)
const IdRow = Schema.Struct({ id: Schema.String })
const idRows = rowsOf(IdRow)
const CostRow = Schema.Struct({ cost: Schema.NullOr(Schema.Finite) })
const costRows = rowsOf(CostRow)
const CountRow = Schema.Struct({ n: Schema.Int })
const countRows = rowsOf(CountRow)
const PayloadRow = Schema.Struct({ payload: Schema.String })
const payloadRows = rowsOf(PayloadRow)
const AutomationIdRow = Schema.Struct({ automation_id: AutomationId })
const automationIdRows = rowsOf(AutomationIdRow)

const automations = <E>(statement: Effect.Effect<ReadonlyArray<unknown>, E>) =>
  Effect.map(automationRows(statement), (rows) => rows.filter(isAutomationRow).map(toAutomation))
const firstOf = <A>(found: Effect.Effect<ReadonlyArray<A>>) => Effect.map(found, (list) => list[0] ?? null)
const n = <E>(statement: Effect.Effect<ReadonlyArray<unknown>, E>) => Effect.map(countRows(statement), (rows) => rows[0]?.n ?? 0)

/**
 * What a run's cost is counted as: as it recorded it, else its routine thread's so far, else its share of the agent run
 * that took its message in so far.
 */
const COST = `COALESCE(SUM(COALESCE(r.cost_usd, t.cost_usd, x.cost_usd / (SELECT COUNT(*) FROM automation_runs y WHERE y.agent_run_id = r.agent_run_id), 0)), 0) AS cost
  FROM automation_runs r
    LEFT JOIN tasks t ON t.id = r.task_id AND t.task_type = 'routine'
    LEFT JOIN runs x ON x.id = r.agent_run_id`

const RUN = `id, automation_id, source, status, detail, outcome, cost_usd, task_id, delivery_id, event, count, batch_id, due_at, created_at,
  finished_at, agent_run_id, batch_key, payload`

/** What a change to an automation writes; what is left out stays. Trigger and action are kept as JSON with sorted keys. */
export interface AutomationColumns {
  readonly name?: string
  readonly enabled?: boolean
  readonly trigger?: string
  readonly action?: string
  readonly token?: string
  readonly secret?: string | null
  readonly next_run_at?: string | null
  readonly last_run_at?: string | null
  readonly active_hours?: string | null
  readonly precheck?: string | null
  readonly budget_usd?: number | null
}

export interface AutomationRepoShape {
  readonly get: (id: string) => Effect.Effect<StoredAutomation | null>
  /** A project's automations, oldest first. */
  readonly list: (project: ProjectId) => Effect.Effect<ReadonlyArray<StoredAutomation>>
  /** A profile's routines (its automations in no project), oldest first. */
  readonly listRoutines: (profile: ProfileId) => Effect.Effect<ReadonlyArray<StoredAutomation>>
  /** The automations that are on and have a next run, each with whether its project is archived. */
  readonly scheduled: Effect.Effect<ReadonlyArray<{ readonly automation: StoredAutomation; readonly archived: boolean }>>
  readonly insert: (a: StoredAutomation, trigger: string, action: string) => Effect.Effect<void>
  readonly update: (id: AutomationId, columns: AutomationColumns, now: Timestamp) => Effect.Effect<void>
  readonly delete: (id: AutomationId) => Effect.Effect<void>
  /** When it last ran (not a change to it: `updated_at` stays). */
  readonly setLastRun: (id: AutomationId, at: Timestamp) => Effect.Effect<void>
  /**
   * Claims a scheduled run: its next run moved on to `next` (and for `once`, the automation turned off), if it's still on
   * and still due at `due`. False if something else claimed it first.
   */
  readonly claim: (id: AutomationId, due: string, next: string | null, once: boolean) => Effect.Effect<boolean>

  readonly insertRun: (run: StoredRun) => Effect.Effect<void>
  readonly getRun: (id: string) => Effect.Effect<StoredRun | null>
  /** An automation's latest runs, newest first. */
  readonly runs: (automation: AutomationId, limit: number) => Effect.Effect<ReadonlyArray<StoredRun>>
  /** Ends a run: its status, the task it made or messaged (kept if none), why, and when. */
  readonly finishRun: (id: string, status: AutomationRun["status"], task: TaskId | null, detail: string | null, at: Timestamp) => Effect.Effect<void>
  /** Links a run to the task it made or messaged (null: none after all). */
  readonly setRunTask: (id: string, task: TaskId | null) => Effect.Effect<void>
  /** How a routine thread's run ended, and what it cost. */
  readonly setOutcome: (id: string, outcome: AutomationRun["outcome"], cost: number | null) => Effect.Effect<void>
  /** Runs left `running` by a server that stopped become failed, and aren't run again. How many. */
  readonly markInterrupted: (at: Timestamp) => Effect.Effect<number>
  /** Drops old runs and payloads (see `KEEP_RUNS`); never pending or running ones, nor the last two days' that cost something. */
  readonly prune: (dedupeCutoff: Timestamp, costsSince: Timestamp) => Effect.Effect<void>

  /** The earlier run with this delivery id since `since` that counts (pending, coalesced, running or ok), if any. */
  readonly seenDelivery: (automation: AutomationId, delivery: string, since: Timestamp) => Effect.Effect<string | null>
  /** The pending run deliveries with this coalescing key join, if any. */
  readonly pendingBatch: (automation: AutomationId, key: string) => Effect.Effect<string | null>
  /** A delivery joins a pending batch: one more, which runs with the latest delivery's values. */
  readonly joinBatch: (batch: string, payload: string, delivery: string | null, event: string | null) => Effect.Effect<void>
  readonly pendingCount: (automation: AutomationId) => Effect.Effect<number>
  /** The pending runs whose window has closed by `at`, oldest first. */
  readonly pendingDue: (at: Timestamp) => Effect.Effect<ReadonlyArray<StoredRun>>
  /** Claims a pending run: `running`, or `skipped` with why. False if it isn't pending any more. */
  readonly claimPending: (id: string, status: "running" | "skipped", detail: string | null, at: Timestamp) => Effect.Effect<boolean>
  /** The latest delivery kept, for the next test delivery. */
  readonly latestPayload: (automation: AutomationId) => Effect.Effect<string | null>

  /** What an automation's runs kept have cost, since `since` (all of them for null). */
  readonly spent: (automation: AutomationId, since: Timestamp | null) => Effect.Effect<number>
  /** A run's share of the agent run that took its message in, so far. */
  readonly shareSoFar: (run: string) => Effect.Effect<number | null>
  /** The routine thread of an earlier fresh run that's still working or waiting for its usage limit, if any. */
  readonly stillRunning: (automation: AutomationId) => Effect.Effect<TaskId | null>
  /** The run a routine thread is for. */
  readonly runOfTask: (task: TaskId) => Effect.Effect<StoredRun | null>
  /**
   * An agent run ended: the automation runs it took the messages of record what it cost, split evenly between them. The
   * automations whose runs those are.
   */
  readonly agentRunEnded: (run: string) => Effect.Effect<ReadonlyArray<AutomationId>>
  /** Routine threads not running nor waiting whose last activity was before `cutoff`. */
  readonly oldRoutineThreads: (cutoff: Timestamp) => Effect.Effect<ReadonlyArray<TaskId>>
}

export class AutomationRepo extends Context.Service<AutomationRepo, AutomationRepoShape>()("huntaway-server/automations/AutomationRepo") {
  static readonly layer = Layer.effect(
    AutomationRepo,
    Effect.gen(function* () {
      const { sql } = yield* Db
      const run = sql.literal(RUN)
      const cost = sql.literal(COST)

      const scheduled = Effect.gen(function* () {
        const all = yield* automations(sql`SELECT * FROM automations WHERE enabled = 1 AND next_run_at IS NOT NULL ORDER BY created_at, id`)
        const archived = yield* archivedRows(
          sql`SELECT a.id AS id, p.archived_at IS NOT NULL AS archived FROM automations a JOIN projects p ON p.id = a.project_id
            WHERE a.enabled = 1 AND a.next_run_at IS NOT NULL`,
        )
        // A routine has no project, so it's never archived.
        return all.map((automation) => ({ automation, archived: archived.some((r) => r.id === automation.id && r.archived) }))
      })

      const insert: AutomationRepoShape["insert"] = (a, trigger, action) =>
        sql`INSERT INTO automations ${sql.insert({
          id: a.id,
          profile_id: a.profile_id,
          project_id: a.project_id,
          name: a.name,
          enabled: a.enabled ? 1 : 0,
          trigger,
          action,
          token: a.token,
          secret: a.secret,
          next_run_at: a.next_run_at,
          last_run_at: a.last_run_at,
          active_hours: a.active_hours === null ? null : activeHoursJson(a.active_hours),
          precheck: a.precheck,
          budget_usd: a.budget_usd,
          created_at: a.created_at,
          updated_at: a.updated_at,
        })}`.pipe(Effect.asVoid, Effect.orDie)

      const update: AutomationRepoShape["update"] = (id, columns, now) => {
        const values: Record<string, string | number | null> = { updated_at: now }
        for (const [k, v] of Object.entries(columns)) {
          if (v === undefined) continue
          values[k] = typeof v === "boolean" ? (v ? 1 : 0) : v
        }
        return sql`UPDATE automations SET ${sql.update(values)} WHERE id = ${id}`.pipe(Effect.asVoid, Effect.orDie)
      }

      const insertRun: AutomationRepoShape["insertRun"] = (r) =>
        sql`INSERT INTO automation_runs ${sql.insert({
          id: r.id,
          automation_id: r.automation_id,
          source: r.source,
          status: r.status,
          detail: r.detail,
          task_id: r.task_id,
          agent_run_id: r.agent_run_id,
          delivery_id: r.delivery_id,
          event: r.event,
          count: r.count,
          batch_key: r.batch_key,
          batch_id: r.batch_id,
          payload: r.payload,
          due_at: r.due_at,
          outcome: r.outcome,
          cost_usd: r.cost_usd,
          created_at: r.created_at,
          finished_at: r.finished_at,
        })}`.pipe(Effect.asVoid, Effect.orDie)

      const prune: AutomationRepoShape["prune"] = (cutoff, costsSince) =>
        Effect.gen(function* () {
          const ids = yield* idRows(sql`SELECT id FROM automations`)
          for (const { id } of ids) {
            const newest = (limit: number) =>
              sql`SELECT id FROM automation_runs WHERE automation_id = ${id} ORDER BY created_at DESC, rowid DESC LIMIT ${limit}`
            // The runs that made or messaged a task (or cost something) in the last two days count toward today's budget.
            const kept = sql`(created_at >= ${costsSince} AND (COALESCE(cost_usd, 0) > 0 OR (status = 'ok' AND task_id IS NOT NULL)))`
            yield* sql`DELETE FROM automation_runs WHERE automation_id = ${id} AND status NOT IN ('pending', 'running')
              AND id NOT IN (${newest(KEEP_RUNS)}) AND NOT ${kept}`
            yield* sql`DELETE FROM automation_runs WHERE automation_id = ${id} AND status NOT IN ('pending', 'running') AND created_at < ${cutoff}
              AND id NOT IN (${newest(KEEP_RECENT)}) AND NOT ${kept}`
            yield* sql`UPDATE automation_runs SET payload = NULL WHERE automation_id = ${id} AND payload IS NOT NULL
              AND status NOT IN ('pending', 'running') AND id NOT IN
              (SELECT id FROM automation_runs WHERE automation_id = ${id} AND payload IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT ${KEEP_PAYLOADS})`
          }
        }).pipe(Effect.orDie)

      const agentRunEnded: AutomationRepoShape["agentRunEnded"] = (agentRun) =>
        Effect.gen(function* () {
          yield* sql`UPDATE automation_runs SET cost_usd = (SELECT cost_usd FROM runs WHERE id = ${agentRun})
            / (SELECT COUNT(*) FROM automation_runs WHERE agent_run_id = ${agentRun}) WHERE agent_run_id = ${agentRun}`
          const rows = yield* automationIdRows(sql`SELECT DISTINCT automation_id FROM automation_runs WHERE agent_run_id = ${agentRun}`)
          return rows.map((r) => r.automation_id)
        }).pipe(Effect.orDie)

      return AutomationRepo.of({
        get: (id) => firstOf(automations(sql`SELECT * FROM automations WHERE id = ${id}`)),
        list: (project) => automations(sql`SELECT * FROM automations WHERE project_id = ${project} ORDER BY created_at, id`),
        listRoutines: (profile) => automations(sql`SELECT * FROM automations WHERE profile_id = ${profile} AND project_id IS NULL ORDER BY created_at, id`),
        scheduled,
        insert,
        update,
        delete: (id) => sql`DELETE FROM automations WHERE id = ${id}`.pipe(Effect.asVoid, Effect.orDie),
        setLastRun: (id, at) => sql`UPDATE automations SET last_run_at = ${at} WHERE id = ${id}`.pipe(Effect.asVoid, Effect.orDie),
        claim: (id, due, next, once) =>
          idRows(
            sql`UPDATE automations SET next_run_at = ${next}, enabled = CASE WHEN ${once ? 1 : 0} = 1 THEN 0 ELSE enabled END
              WHERE id = ${id} AND next_run_at = ${due} AND enabled = 1 RETURNING id`,
          ).pipe(Effect.map((rows) => rows.length > 0)),

        insertRun,
        getRun: (id) => firstOf(runRows(sql`SELECT ${run} FROM automation_runs WHERE id = ${id}`)),
        runs: (automation, limit) =>
          runRows(sql`SELECT ${run} FROM automation_runs WHERE automation_id = ${automation} ORDER BY created_at DESC, rowid DESC LIMIT ${limit}`),
        finishRun: (id, status, task, detail, at) =>
          sql`UPDATE automation_runs SET status = ${status}, task_id = COALESCE(${task}, task_id), detail = ${detail}, finished_at = ${at}
            WHERE id = ${id}`.pipe(Effect.asVoid, Effect.orDie),
        setRunTask: (id, task) => sql`UPDATE automation_runs SET task_id = ${task} WHERE id = ${id}`.pipe(Effect.asVoid, Effect.orDie),
        setOutcome: (id, outcome, c) =>
          sql`UPDATE automation_runs SET outcome = ${outcome}, cost_usd = ${c} WHERE id = ${id}`.pipe(Effect.asVoid, Effect.orDie),
        markInterrupted: (at) =>
          idRows(
            sql`UPDATE automation_runs SET status = 'failed', finished_at = ${at},
              detail = 'Interrupted: the server stopped while this ran, so it may or may not have taken effect. It is not run again.'
              WHERE status = 'running' RETURNING id`,
          ).pipe(Effect.map((rows) => rows.length)),
        prune,

        seenDelivery: (automation, delivery, since) =>
          firstOf(
            idRows(
              sql`SELECT id FROM automation_runs WHERE automation_id = ${automation} AND delivery_id = ${delivery} AND created_at >= ${since}
                AND status IN ('pending', 'coalesced', 'running', 'ok') ORDER BY created_at LIMIT 1`,
            ),
          ).pipe(Effect.map((r) => r?.id ?? null)),
        pendingBatch: (automation, key) =>
          firstOf(
            idRows(sql`SELECT id FROM automation_runs WHERE automation_id = ${automation} AND status = 'pending' AND COALESCE(batch_key, '') = ${key} LIMIT 1`),
          ).pipe(Effect.map((r) => r?.id ?? null)),
        joinBatch: (batch, payload, delivery, event) =>
          sql`UPDATE automation_runs SET count = count + 1, payload = ${payload}, delivery_id = COALESCE(delivery_id, ${delivery}), event = ${event}
            WHERE id = ${batch}`.pipe(Effect.asVoid, Effect.orDie),
        pendingCount: (automation) => n(sql`SELECT COUNT(*) AS n FROM automation_runs WHERE automation_id = ${automation} AND status = 'pending'`),
        pendingDue: (at) => runRows(sql`SELECT ${run} FROM automation_runs WHERE status = 'pending' AND due_at <= ${at} ORDER BY due_at`),
        claimPending: (id, status, detail, at) =>
          idRows(
            sql`UPDATE automation_runs SET status = ${status}, detail = ${detail}, finished_at = ${status === "skipped" ? at : null}
              WHERE id = ${id} AND status = 'pending' RETURNING id`,
          ).pipe(Effect.map((rows) => rows.length === 1)),
        latestPayload: (automation) =>
          firstOf(
            payloadRows(
              sql`SELECT payload FROM automation_runs WHERE automation_id = ${automation} AND payload IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1`,
            ),
          ).pipe(Effect.map((r) => r?.payload ?? null)),

        spent: (automation, since) =>
          firstOf(
            costRows(
              since === null
                ? sql`SELECT ${cost} WHERE r.automation_id = ${automation}`
                : sql`SELECT ${cost} WHERE r.automation_id = ${automation} AND r.created_at >= ${since}`,
            ),
          ).pipe(Effect.map((r) => r?.cost ?? 0)),
        shareSoFar: (id) =>
          firstOf(
            costRows(
              sql`SELECT x.cost_usd / (SELECT COUNT(*) FROM automation_runs y WHERE y.agent_run_id = x.id) AS cost
                FROM automation_runs r JOIN runs x ON x.id = r.agent_run_id WHERE r.id = ${id}`,
            ),
          ).pipe(Effect.map((r) => r?.cost ?? null)),
        stillRunning: (automation) =>
          firstOf(
            idRows(
              sql`SELECT t.id AS id FROM automation_runs r JOIN tasks t ON t.id = r.task_id
                WHERE r.automation_id = ${automation} AND t.task_type = 'routine' AND (t.running = 1 OR t.waiting = 1) ORDER BY r.created_at DESC LIMIT 1`,
            ),
          ).pipe(Effect.map((r) => (r === null ? null : TaskId.make(r.id)))),
        runOfTask: (task) => firstOf(runRows(sql`SELECT ${run} FROM automation_runs WHERE task_id = ${task} ORDER BY created_at DESC, rowid DESC LIMIT 1`)),
        agentRunEnded,
        oldRoutineThreads: (cutoff) =>
          idRows(
            sql`SELECT id FROM tasks WHERE task_type = 'routine' AND running = 0 AND waiting = 0 AND last_activity_at < ${cutoff} ORDER BY created_at`,
          ).pipe(Effect.map((rows) => rows.map((r) => TaskId.make(r.id)))),
      })
    }),
  )
}

const encodeActive = Schema.encodeUnknownOption(Schema.fromJsonString(ActiveHours))
/** Active hours as their column keeps them. */
const activeHoursJson = (h: ActiveHours): string => Option.getOrElse(encodeActive(h), () => "null")
