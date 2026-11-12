import { Effect, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { elapsedMs } from "../Telemetry.ts"
import type { Row } from "../Telemetry.ts"

// `huntaway telemetry backfill` (the old telemetry/backfill.ts, HA-284): a host's history from before it sent
// telemetry, for the profiles that send now, from the tables the board's analytics read: runs and their `token_usage`
// (`run_end`, `run_usage`), `call_usage` (`side_call`), `approval_log` (`permission`), `review_stats` (`review`),
// `mcp_calls` (`board_tool`) and `automation_runs` (`automation_run`).
//
// Nothing is counted twice. Each row is picked by when the server would have sent it, and only if that's before
// `telemetry_since` (when the host started sending): a run by when its tokens were counted (`usage_at`), not when it
// started, so a run that was going when sending started, and was sent when it ended, isn't sent again; a prompt by when
// it was decided; an automation's run by when it finished; a board tool call by when it began (`Telemetry.beganSince`).
// And each batch's deduplication token is made from its rows' ids, so running it again sends nothing ClickHouse
// doesn't drop (within the tables' last 1000 inserts).

const BATCH = 1000

export interface Batch {
  readonly table: "events"
  /** The token's part that says what the rows are: their kind and first and last ids. */
  readonly key: string
  readonly rows: ReadonlyArray<Row>
}

const Profile = Schema.Struct({ id: Schema.String, name: Schema.String, telemetry_titles: Schema.Int, claude_config_ids: Schema.String })
const ConfigIds = Schema.fromJsonString(Schema.Array(Schema.String))

type Any = Record<string, unknown>
const s = (v: unknown) => (typeof v === "string" ? v : "")
const n = (v: unknown) => (typeof v === "number" ? v : 0)
const sn = (v: unknown) => (typeof v === "string" ? v : null)

/** Every row to send from before `until`, in batches of BATCH. */
export const collect = Effect.fnUntraced(function* (until: string) {
  const sql = yield* SqlClient.SqlClient
  const q = (text: string, params: ReadonlyArray<unknown> = []) => sql.unsafe<Any>(text, [...params]).pipe(Effect.orDie)
  const profiles = new Map<string, { readonly name: string; readonly titles: boolean }>()
  const sendingProfiles = yield* Schema.decodeUnknownEffect(Schema.Array(Profile))(
    yield* q("SELECT id, name, telemetry_titles, claude_config_ids FROM profiles WHERE telemetry = 1 ORDER BY created_at, rowid"),
  ).pipe(Effect.orDie)
  for (const p of sendingProfiles) profiles.set(p.id, { name: p.name, titles: p.telemetry_titles !== 0 })
  if (profiles.size === 0) return []

  // The task columns (as `TelemetryRepo.taskContext`), for the tasks of the profiles that send.
  const tasks = new Map<string, Row>()
  for (const t of yield* q("SELECT t.id, t.profile_id, t.project_id, t.number, t.title, p.key FROM tasks t LEFT JOIN projects p ON p.id = t.project_id")) {
    const p = profiles.get(s(t["profile_id"]))
    if (p === undefined) continue
    const key = s(t["key"])
    tasks.set(s(t["id"]), {
      profile: p.name,
      project_id: s(t["project_id"]),
      project_key: key,
      task_id: s(t["id"]),
      task_key: key === "" ? "" : `${key}-${n(t["number"])}`,
      task_title: p.titles ? s(t["title"]) : "",
    })
  }
  const ofTask = (id: unknown) => (typeof id === "string" ? tasks.get(id) : undefined)
  const batches: Array<Batch> = []
  const add = (kind: string, rows: ReadonlyArray<{ readonly id: string | number; readonly row: Row }>) => {
    for (let i = 0; i < rows.length; i += BATCH) {
      const part = rows.slice(i, i + BATCH)
      const first = part[0]
      const last = part.at(-1)
      if (first === undefined || last === undefined) continue
      batches.push({ table: "events", key: `${kind}:${first.id}-${last.id}:${part.length}`, rows: part.map((r) => r.row) })
    }
  }

  // Runs: run_usage for each model, and run_end, by when they were counted.
  const usage = new Map<string, Array<Any>>()
  for (const u of yield* q("SELECT u.* FROM token_usage u JOIN runs r ON r.id = u.run_id WHERE r.usage_at IS NOT NULL AND r.usage_at < ?", [until])) {
    usage.set(s(u["run_id"]), [...(usage.get(s(u["run_id"])) ?? []), u])
  }
  const runs: Array<{ id: string | number; row: Row }> = []
  for (const r of yield* q("SELECT * FROM runs WHERE status = 'exited' AND usage_at IS NOT NULL AND usage_at < ? ORDER BY seq", [until])) {
    const t = ofTask(r["task_id"])
    if (t === undefined) continue
    const ts = sn(r["ended_at"]) ?? s(r["created_at"])
    const id = `${n(r["seq"])}`
    const session = sn(r["usage_session"]) ?? sn(r["session_id"]) ?? ""
    let cost = 0
    let main: Any | null = null
    for (const u of usage.get(s(r["id"])) ?? []) {
      cost += n(u["cost_usd"])
      if (main === null || n(u["output_tokens"]) > n(main["output_tokens"])) main = u
      runs.push({
        id,
        row: {
          ...t,
          ts,
          event: "run_usage",
          run_id: r["id"],
          kind: r["kind"],
          runtime: u["runtime"],
          model: u["model"],
          session_id: session,
          input_tokens: n(u["input_tokens"]),
          output_tokens: n(u["output_tokens"]),
          cache_read_tokens: n(u["cache_read_tokens"]),
          cache_write_tokens: n(u["cache_write_tokens"]),
          reasoning_tokens: n(u["reasoning_tokens"]),
          cost_usd: n(u["cost_usd"]),
          estimated: n(u["estimated"]) !== 0,
          attrs: { backfill: true },
        },
      })
    }
    runs.push({
      id,
      row: {
        ...t,
        ts,
        event: "run_end",
        run_id: r["id"],
        kind: r["kind"],
        runtime: main === null ? "" : s(main["runtime"]),
        model: main === null ? "" : s(main["model"]),
        session_id: session,
        status: sn(r["result_error"]) !== null ? "error" : n(r["saw_result"]) !== 0 ? "success" : "no_result",
        outcome: s(r["attention"]),
        exit_code: -1,
        duration_ms: elapsedMs(s(r["created_at"]), ts),
        cost_usd: cost,
        error: s(r["result_error"]),
        attrs: { backfill: true, stopped: s(r["stop"]), finished: n(r["finished"]) !== 0 },
      },
    })
  }
  add("runs", runs)

  // Side calls: a task's with its task, a config's with the first profile that sends and has it.
  const configs = new Map<string, Row>()
  for (const p of sendingProfiles) {
    for (const id of Option.getOrElse(Schema.decodeOption(ConfigIds)(p.claude_config_ids), () => [])) {
      if (!configs.has(id)) configs.set(id, { profile: p.name })
    }
  }
  const calls: Array<{ id: string | number; row: Row }> = []
  for (const u of yield* q("SELECT * FROM call_usage WHERE at < ? ORDER BY id", [until])) {
    const who = u["task_id"] !== null ? ofTask(u["task_id"]) : typeof u["config_id"] === "string" ? configs.get(u["config_id"]) : undefined
    if (who === undefined) continue
    calls.push({
      id: n(u["id"]),
      row: {
        ...who,
        ts: u["at"],
        event: "side_call",
        kind: u["purpose"],
        runtime: u["runtime"],
        model: u["model"],
        input_tokens: n(u["input_tokens"]),
        output_tokens: n(u["output_tokens"]),
        cache_read_tokens: n(u["cache_read_tokens"]),
        cache_write_tokens: n(u["cache_write_tokens"]),
        reasoning_tokens: n(u["reasoning_tokens"]),
        cost_usd: n(u["cost_usd"]),
        attrs: { backfill: true, ...(typeof u["config_id"] === "string" ? { config_id: u["config_id"] } : {}) },
      },
    })
  }
  add("calls", calls)

  // Permission prompts and the calls rules decided, by when they were decided.
  const perms: Array<{ id: string | number; row: Row }> = []
  for (const a of yield* q("SELECT rowid AS rid, * FROM approval_log WHERE outcome != 'pending' AND coalesce(decided_at, created_at) < ? ORDER BY rowid", [
    until,
  ])) {
    const t = ofTask(a["task_id"])
    if (t === undefined) continue
    const decided = sn(a["decided_at"])
    perms.push({
      id: n(a["rid"]),
      row: {
        ...t,
        ts: decided ?? a["created_at"],
        event: "permission",
        tool: a["tool_name"],
        status: a["decision"],
        outcome: a["outcome"],
        wait_ms: decided === null ? 0 : elapsedMs(s(a["created_at"]), decided),
        attrs: { backfill: true, rule: a["rule"], by: s(a["answered_by"]) },
      },
    })
  }
  add("permissions", perms)

  const reviews: Array<{ id: string | number; row: Row }> = []
  for (const r of yield* q("SELECT * FROM review_stats WHERE at < ? ORDER BY id", [until])) {
    const t = ofTask(r["task_id"])
    if (t === undefined) continue
    reviews.push({
      id: n(r["id"]),
      row: {
        ...t,
        ts: r["at"],
        event: "review",
        run_id: s(r["run_id"]),
        status: r["verdict"],
        effort: s(r["effort"]),
        attrs: { backfill: true, round: r["round"], serious: r["serious"], minor: r["minor"] ?? "", reviewer: s(r["label"]), thread_id: r["thread_id"] },
      },
    })
  }
  add("reviews", reviews)

  const tools: Array<{ id: string | number; row: Row }> = []
  for (const m of yield* q("SELECT rowid AS rid, id, run_id, task_id, tool, status, error, created_at FROM mcp_calls WHERE created_at < ? ORDER BY rowid", [
    until,
  ])) {
    const t = ofTask(m["task_id"])
    if (t === undefined) continue
    tools.push({
      id: n(m["rid"]),
      row: {
        ...t,
        ts: m["created_at"],
        event: "board_tool",
        run_id: m["run_id"],
        tool: m["tool"],
        status: m["error"] === null ? "ok" : "error",
        attrs: { backfill: true },
      },
    })
  }
  add("tools", tools)

  const autos: Array<{ id: string | number; row: Row }> = []
  for (const r of yield* q(
    `SELECT r.rowid AS rid, r.source, r.status, r.task_id, r.created_at, r.finished_at, a.profile_id, a.project_id, a.name, p.key
       FROM automation_runs r JOIN automations a ON a.id = r.automation_id LEFT JOIN projects p ON p.id = a.project_id
      WHERE r.finished_at IS NOT NULL AND r.finished_at < ? ORDER BY r.rowid`,
    [until],
  )) {
    const p = profiles.get(s(r["profile_id"]))
    if (p === undefined) continue
    autos.push({
      id: n(r["rid"]),
      row: {
        profile: p.name,
        project_id: s(r["project_id"]),
        project_key: s(r["key"]),
        ts: r["finished_at"],
        event: "automation_run",
        kind: r["source"],
        status: r["status"],
        duration_ms: elapsedMs(s(r["created_at"]), s(r["finished_at"])),
        attrs: { backfill: true, automation: r["name"], task: s(r["task_id"]) },
      },
    })
  }
  add("automations", autos)
  return batches
})
