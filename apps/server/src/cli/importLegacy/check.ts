import { Effect, FileSystem } from "effect"
import type { SqlClient } from "effect/sql"
import type { ImportContext } from "./family.ts"
import type { OldDb } from "./oldDb.ts"
import type { Problem, Report } from "./report.ts"

// `--check` (docs/plan/11-migration.md, `--check`): the old database against the new board, after an import or on its
// own against an existing pair. What it compares:
// - row counts per table, old against new, with the expected differences (dropped tables, the queue, a rehearsal's
//   withheld credentials, the `messages` rows carried as items);
// - per task: its key is its alone, its item and request counts and the ids of its first and last items match, and its
//   cost stands to its runs' costs as it did;
// - no stored path is relative; a ready worktree or a work folder that is not on disk is a note (the old board has the
//   same gap, and the importer cannot fill it).
// Every JSON value was checked with the new schema as it was written (the report's `json`). The 200-thread sample that
// compares the two servers' answers needs both servers running: `scripts/compare-threads.mjs` does it.

/** Old tables whose rows are written one for one into the new table of the same or another name. */
const ONE_FOR_ONE: ReadonlyArray<readonly [old: string, table: string, credential?: true]> = [
  ["profiles", "profiles"],
  ["claude_configs", "agent_configs"],
  ["projects", "projects"],
  ["tasks", "tasks"],
  ["threads", "threads"],
  ["thread_requests", "thread_requests"],
  ["runs", "runs"],
  ["token_usage", "token_usage"],
  ["call_usage", "call_usage"],
  ["context_stats", "context_stats"],
  ["review_stats", "review_stats"],
  ["checkpoints", "checkpoints"],
  ["pr_watches", "pr_watches"],
  ["pr_states", "pr_states"],
  ["documents", "documents"],
  ["approval_log", "approval_log"],
  ["permission_requests", "permission_requests"],
  ["desktop_ops", "desktop_ops"],
  ["skill_sources", "skill_sources"],
  ["agent_skills", "agent_skills"],
  ["agent_mcp_servers", "agent_mcp_servers"],
  ["agent_tool_switches", "agent_tool_switches"],
  ["project_agent_tools", "project_agent_tools"],
  ["pens", "pens"],
  ["docs", "docs"],
  ["doc_versions", "doc_versions"],
  ["doc_pages", "doc_pages"],
  ["doc_labels", "doc_labels"],
  ["doc_images", "doc_images"],
  ["doc_version_images", "doc_version_images"],
  ["doc_comments", "doc_comments"],
  ["docs_site_clients", "docs_site_clients"],
  ["docs_site_connections", "docs_site_connections", true],
  ["docs_site_published", "docs_site_published"],
  ["automations", "automations"],
  ["automation_runs", "automation_runs"],
  ["workflows", "workflows"],
  ["workflow_runs", "workflow_runs"],
  ["links", "links", true],
  ["push_subscriptions", "push_subscriptions", true],
  ["setting_versions", "setting_versions"],
  ["telemetry_outbox", "telemetry_outbox", true],
]

/** Columns of the new board that hold a path on disk, and whether an absent one is worth a note. */
const PATHS: ReadonlyArray<readonly [table: string, column: string, key: string]> = [
  ["projects", "repo_path", "key"],
  ["projects", "scratch_path", "key"],
  ["projects", "worktrees_root", "key"],
  ["projects", "repo_root", "key"],
  ["tasks", "work_dir", "id"],
  ["tasks", "worktree_path", "id"],
]

type Row = Readonly<Record<string, unknown>>
const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : 0)
const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "")

/** Rows by a key column, for comparing per task. */
const byKey = (rows: ReadonlyArray<Row>, key: string) => new Map(rows.map((r) => [str(r[key]), r]))

/** Every difference `--check` finds between the old database and the new board; notes go straight to the report. */
export const checkImport = Effect.fnUntraced(function* (old: OldDb, board: SqlClient.SqlClient, ctx: ImportContext, report: Report) {
  const fs = yield* FileSystem.FileSystem
  const problems: Array<Problem> = []
  const q = (statement: string) => board.unsafe<Row>(statement).pipe(Effect.orDie)
  const problem = (table: string, key: string, error: string) => problems.push({ table, key, error })
  const newTables = new Set((yield* q(`SELECT name FROM sqlite_master WHERE type = 'table'`)).map((r) => str(r["name"])))

  // Row counts. A rehearsal's credentials are not written; a row that failed is in the report already, and is counted
  // here too, so the check fails on it whatever the report says.
  for (const [oldTable, table, credential] of ONE_FOR_ONE) {
    if (!old.tables.has(oldTable) || !newTables.has(table)) continue
    const before = num((yield* old.query(`SELECT count(*) AS n FROM "${oldTable}"`))[0]?.["n"])
    const after = num((yield* q(`SELECT count(*) AS n FROM "${table}"`))[0]?.["n"])
    const expected = credential === true && ctx.rehearsal ? 0 : before
    if (after !== expected) problem(table, "*", `${after} rows, expected ${expected} (old ${oldTable}: ${before})`)
  }

  // Per task.
  const oldItems = old.tables.has("thread_items")
    ? byKey(
        yield* old.query(`SELECT task_id, count(*) AS n,
          (SELECT id FROM thread_items f WHERE f.task_id = i.task_id ORDER BY pos ASC LIMIT 1) AS first,
          (SELECT id FROM thread_items l WHERE l.task_id = i.task_id ORDER BY pos DESC LIMIT 1) AS last
          FROM thread_items i GROUP BY task_id`),
        "task_id",
      )
    : new Map<string, Row>()
  const newItems = byKey(
    yield* q(`SELECT task_id, count(*) AS n,
      (SELECT id FROM thread_items f WHERE f.task_id = i.task_id ORDER BY pos ASC LIMIT 1) AS first,
      (SELECT id FROM thread_items l WHERE l.task_id = i.task_id ORDER BY pos DESC LIMIT 1) AS last
      FROM thread_items i GROUP BY task_id`),
    "task_id",
  )
  const carried = old.tables.has("messages")
    ? byKey(yield* old.query(`SELECT task_id, count(*) AS n FROM messages GROUP BY task_id`), "task_id")
    : new Map<string, Row>()
  const countBy = (rows: ReadonlyArray<Row>) => new Map(rows.map((r) => [str(r["task_id"]), num(r["n"])]))
  const oldRequests = old.tables.has("thread_requests")
    ? countBy(yield* old.query(`SELECT task_id, count(*) AS n FROM thread_requests GROUP BY task_id`))
    : new Map()
  const newRequests = countBy(yield* q(`SELECT task_id, count(*) AS n FROM thread_requests GROUP BY task_id`))
  const runCost = (rows: ReadonlyArray<Row>) => new Map(rows.map((r) => [str(r["id"]), num(r["cost"]) - num(r["runs"])]))
  const oldCost = runCost(
    yield* old.query(`SELECT t.id, t.cost_usd AS cost, (SELECT coalesce(sum(cost_usd), 0) FROM runs WHERE task_id = t.id) AS runs FROM tasks t`),
  )
  const newCost = runCost(yield* q(`SELECT t.id, t.cost_usd AS cost, (SELECT coalesce(sum(cost_usd), 0) FROM runs WHERE task_id = t.id) AS runs FROM tasks t`))
  const tasks = yield* q(`SELECT id, project_id, number, kind FROM tasks`)
  const keys = new Map<string, string>()
  for (const t of tasks) {
    const id = str(t["id"])
    if (t["project_id"] !== null && t["kind"] === "task") {
      const key = `${str(t["project_id"])}#${num(t["number"])}`
      const other = keys.get(key)
      if (other !== undefined) problem("tasks", id, `has the same project and number as ${other}`)
      keys.set(key, id)
    }
    const o = oldItems.get(id)
    const n = newItems.get(id)
    const stray = num(carried.get(id)?.["n"])
    if (num(n?.["n"]) < num(o?.["n"]) + stray) problem("thread_items", id, `${num(n?.["n"])} items, expected at least ${num(o?.["n"]) + stray}`)
    if (o !== undefined && stray === 0) {
      if (num(n?.["n"]) !== num(o["n"])) problem("thread_items", id, `${num(n?.["n"])} items, old ${num(o["n"])}`)
      if (str(n?.["first"]) !== str(o["first"]) || str(n?.["last"]) !== str(o["last"]))
        problem("thread_items", id, `first and last items ${str(n?.["first"])}…${str(n?.["last"])}, old ${str(o["first"])}…${str(o["last"])}`)
    }
    if ((newRequests.get(id) ?? 0) !== (oldRequests.get(id) ?? 0))
      problem("thread_requests", id, `${newRequests.get(id) ?? 0} requests, old ${oldRequests.get(id) ?? 0}`)
    const before = oldCost.get(id)
    const after = newCost.get(id)
    if (before !== undefined && after !== undefined && Math.abs(before - after) > 1e-9)
      problem("tasks", id, `cost less its runs' is ${after.toFixed(6)}, old ${before.toFixed(6)}`)
  }

  // Paths.
  for (const [table, column, key] of PATHS) {
    if (!newTables.has(table)) continue
    const rows = yield* q(
      `SELECT "${key}" AS key, "${column}" AS path${table === "tasks" ? ", worktree_state" : ""} FROM "${table}" WHERE "${column}" IS NOT NULL AND "${column}" <> ''`,
    )
    for (const r of rows) {
      const path = str(r["path"])
      if (!path.startsWith("/")) {
        problem(table, str(r["key"]), `${column} is relative: ${path}`)
        continue
      }
      const worthANote = column === "work_dir" || (column === "worktree_path" && r["worktree_state"] === "ready")
      if (worthANote && !(yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false))))
        yield* report.note(table, str(r["key"]), `${column} ${path} is not on disk`)
    }
  }
  return problems
})
