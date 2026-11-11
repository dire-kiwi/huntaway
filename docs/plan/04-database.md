# 4. Database

One SQLite file per host, read and written through Effect's SQL client. The schema is the old one with its history
removed: the same entities and mostly the same columns, because the task row is the wire type the components draw
and because the old database has to be imported into it ([11-migration.md](11-migration.md)).

## The file

- `<data dir>/board.db`. The new server has a data folder of its own (`~/.local/share/huntaway-effect`), so it never
  shares a folder with the old one, and the old `huntaway-2.db` is only ever read, once, by the importer
  ([11-migration.md](11-migration.md#a-data-folder-of-its-own)).
- Opened by `SqliteClient.layer({ filename, busyTimeout: "5 seconds" })` from `@effect/sql-sqlite-node` (Node's
  `node:sqlite`, one connection, WAL on by default). On open: `PRAGMA foreign_keys = ON`, `synchronous = NORMAL`,
  `journal_size_limit = 33554432`.
- `synchronous = NORMAL` keeps its old consequence: a power cut can lose the last commits, and the run followers
  re-apply output after the saved offset. Handlers stay idempotent for that reason.
- **Never `ANALYZE`**, as now, and keep the query-plan notes that go with it (the `+type` hint on thread queries,
  the partial indexes): [inventory](inventory/09-data-model.md), section 9.
- **Slow reads go to a worker** with its own read-only connection: analytics, token and context statistics, disk
  usage, the backup's `VACUUM INTO`. `node:sqlite` is synchronous, so anything slow on the main connection stalls
  every socket; the old server learned this and so keeps `lag.ts`, which is carried over as the `Lag` service.

## Access

`platform/Db.ts` is the only module that touches `SqlClient` directly for transactions. Everything else goes through
repositories.

```ts
export class Db extends Context.Service<Db, {
  /** One transaction. Events emitted inside are published after it commits; none if it rolls back. */
  tx<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>
  readonly sql: SqlClient.SqlClient
}>()("huntaway/platform/Db") {}
```

- **A repository is a service per table family** (`TaskRepo`, `RunRepo`, `ThreadStore`, `ProjectRepo`…) whose
  methods are single statements or small groups, built with `SqlSchema.findAll`, `findOne` and `void` and a row
  schema. It fails with nothing: `SqlError` and `SchemaError` are defects (`Effect.orDie`), as in the package's own
  SQL example.
- **A row schema turns columns into the entity**: `Bit` (0/1 to boolean), `JsonColumn(schema, fallback)` (text to a
  validated value, the fallback on a value that does not parse, logged once per column), and the timestamp brand.
  The task's row schema produces the wire `Task` plus `ServerOnly` fields.
- **A transaction never contains a wait.** `Db.tx` takes an Effect, so the type cannot forbid one; the structural
  test does, by failing on any import of `Proc`, `HttpClient`, `FileSystem` or `Effect.sleep` in a file under a
  `*/store/` or `*Repo.ts` path, and reviewers hold the rest.
- **Nested `Db.tx` joins the outer transaction** (a savepoint), which the SQL client already does.

### Emit after commit

`Events.emit(event)` inside `Db.tx` appends to a buffer that belongs to that transaction; `Db.tx` publishes the
buffer after the commit and drops it on a rollback. Outside a transaction `emit` publishes at once. The buffer is a
`Context.Reference` that `Db.tx` provides, so no caller passes it.

```ts
const update = Effect.fn("Tasks.update")(function* (id: TaskId, patch: TaskPatch) {
  return yield* locks.withLock(["task", id])(
    Effect.gen(function* () {
      const decided = yield* db.tx(
        Effect.gen(function* () {
          const before = yield* tasks.get(id) // TaskNotFound
          const decision = yield* decideUpdate(before, patch, yield* facts(before)) // no services; Conflict | Invalid
          const after = yield* tasks.write(id, decision.columns)
          yield* events.emit({ type: "task", task: after })
          return { before, after, decision }
        })
      )
      yield* lifecycle.afterTaskChange(decided) // the reconcilers this change could affect
      return decided.after
    })
  )
})
```

`decideUpdate` is a function of its arguments: it needs no service and does no I/O, and returns the columns to write
or fails. `facts(before)` reads what the decision needs from other tables (is a run going, what else is in the merge
lane). A fact that needs a wait (asking GitHub whether the PR is approved) is read before the lock is taken, and the
decision checks inside the transaction that the row it was read for has not changed (`updated_at`), failing with
`Conflict("changed_meanwhile")`. That is the old `update_task_if` rule, written down once.

## Migrations

Effect's `Migrator` runs migrations whose id is above the highest one applied and fails on a duplicate id. With many
branches open at once that is the old numbered scheme's problem again: a migration merged later with a lower number
is skipped. So the server has its own small runner, with the rules the old one ended up with (HA-393):

- A migration is a file `apps/server/migrations/YYYY-MM-DD-a-few-words.ts` whose default export is
  `migration({ after?: [names], foreignKeys?: false, run })`, where `run` is an Effect using `SqlClient`.
- The runner sorts by name, takes `BEGIN IMMEDIATE`, and runs each one not in the `migrations(name, applied_at)`
  table, in its own transaction, recording it. Unknown recorded names (a newer build's) are left alone.
- A migration that changes rows or rebuilds a table says what it comes `after`. Once on `main` a migration is never
  edited, renamed or deleted. A test runs recent pairs in both orders on sample rows and fails if the result
  differs.
- The first migration, `2026-…-initial.ts`, creates the whole schema below. There is no history to replay.
- **Back up before migrating**: when the set of applied names differs from the build's, `VACUUM INTO
  backups/board-<from>-to-<to>-<time>.db` first (in the worker), keep the newest two and the newest from before a
  version change, and refuse to start if the backup cannot be made (`--skip-db-backup` overrides, once).

## The schema

Every table of the old database is in [the inventory](inventory/09-data-model.md) (section 3a) with its columns,
indexes and JSON shapes. The new schema is that, with these changes. A table not named here is carried as it is.

### Dropped

| Table or column                                                                       | Why                                                                    |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `messages`, `thread_item_origins`                                                      | Threads are items; an item records the write that made it              |
| `threads.converter`, `writes`, `error`, `rebuilt_at`, `flipped_at`, `flipped_writes`   | Machinery for moving threads onto items                                |
| `thread_items.turn_id`, `live`; `thread_requests.turn_id`                              | Written, never read                                                    |
| `tasks.subproject`, `thread_items`, `thread_source`, `now_at`                          | Legacy                                                                 |
| `tasks.queued_message`, `queued_from_agent`, `queued_user_text`, `queued_routine`, `queued_routine_runs`, `steering` | Replaced by rows (below)                 |
| `profiles.claude_config_dir`, `profiles.summarizer`, `projects.summarizer`, `projects.subproject_pull_requests`, `pens.hidden` | Mirrors and dead columns        |
| `named_migrations`, `db_origin`                                                        | Replaced by `migrations`; the two-file scheme is gone                  |
| `settings` rows `thread_items`, `thread_batch`, `workflows_reviews_moved`, `demo_todos_seeded`, `telegram*` | Migration flags, and Telegram                     |
| `review_thread_skills`, `thread_mcp_servers`                                           | Merged into `thread_tools`                                             |

### Renamed or reshaped

| Old                                   | New                                                                                                  |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `claude_configs`                      | `agent_configs` (same columns). Columns that point at it keep the wire's name, `claude_config_id`     |
| `runs.rowid` as the order             | `runs.seq INTEGER PRIMARY KEY AUTOINCREMENT`, with `id TEXT NOT NULL UNIQUE`. "Later run" is `seq`    |
| `runs.stop_requested` 0/1/2           | `runs.stop TEXT NOT NULL DEFAULT 'none'`: `none`, `requested`, `interrupted`                          |
| `runs.kind` `prompt`, `compact`       | Adds `review` back as a real kind for review, summary and workflow-step threads' runs                 |
| `workflow_runs.rowid` as the order    | `workflow_runs.seq` the same way                                                                      |
| `tasks.summary` (object or list)      | `tasks.summaries` (always a JSON list)                                                                |
| `permission_requests.message_id`, `checkpoints.message_id`, `runs.turn_message_id` | `write_no` in each: the same numbers under their real name |
| `settings` key `approval_rules:<profile id>` | `profiles.approval_rules` (JSON, null = the defaults)                                          |
| `settings` keys holding secrets (`vapid_private_key`, `telemetry_password`); `links.token`; `automations.token`/`secret`; `agent_configs.api_key`/`management_key`; `profiles.asana_token`; docs-site tokens | Stay where they are, but only their repository selects them, and it returns `Redacted` values. No general-purpose query reads those columns, and no wire schema has a field for them |
| `mcp_calls.status` default `pending`  | `executing` or `done` only                                                                            |
| `projects.is_git`, `has_commits` (read from disk on every row) | Columns, refreshed when the project is read for a run, on a `git` action and by a slow sweep |

### New

```sql
-- One row per database, for things counted across the board.
CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL) STRICT;
-- 'thread_write': the board-wide write number (was the messages table's AUTOINCREMENT sequence)

-- A message waiting for the task's next run. Was one concatenated text with four flag columns.
CREATE TABLE task_queue (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  text TEXT NOT NULL,                          -- '' for an automation run parked with no text
  source TEXT NOT NULL,                        -- user | agent | routine | automation | board
  automation_run_id TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX task_queue_task ON task_queue(task_id, seq);

-- A message written to a live run's input and not yet taken in. Was a JSON list on the task.
CREATE TABLE task_steers (
  id TEXT PRIMARY KEY,                         -- also the uuid of the stream-json line
  seq INTEGER NOT NULL,                        -- order of sending within the task
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  text TEXT NOT NULL,
  source TEXT NOT NULL,
  automation_run_id TEXT,
  written INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
) STRICT;

-- Tools a review, summary or workflow-step thread has that differ from its project's.
CREATE TABLE thread_tools (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  skills TEXT NOT NULL DEFAULT '[]',
  disabled_mcp_servers TEXT NOT NULL DEFAULT '[]'
) STRICT;

CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;
```

All tables are created `STRICT`, so SQLite refuses a value it cannot convert to the column's type instead of storing
it as it came (checked on Node 26: text into an `INTEGER` column fails). The old server checked types by hand at the
edge for the lack of this.

### The queue and steers

The wire still shows `queued_message` (one text) and `steering` (a list). The task's row schema fills them from the
rows: `queued_message` is the queue's texts joined with a blank line, or null. What the old flags encoded is now read
off the rows: "everything queued came from agents" is "no row has source `user`"; "the user's own part" is the
`user` rows' text; the automation runs a queued message carries are the rows' `automation_run_id`s.
[The inventory](inventory/01-run-lifecycle.md) (section 9, _Turns, steering, closing the input_) has the rules for
when a message is steered, queued, requeued ahead, or taken by a run.

### Write numbers

Every board-side write to a thread takes the next `thread_write` number in the same transaction. It is the `<n>` in
item ids of the form `legacy:<n>[:<block>]`, the `write_no` of the items and requests it creates, and what
`permission_requests`, `checkpoints` and `runs` point at. It gives a strict order across the whole board that does
not depend on clocks, which is what "has the conversation moved on since this prompt" needs. The importer seeds the
counter from the old sequence's high-water mark and keeps every existing id.

### Thread tables

```sql
CREATE TABLE threads (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL DEFAULT 0,              -- last saved event number; survives pruning of thread_events
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE thread_items (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  pos INTEGER NOT NULL,                        -- order; gaps allowed
  type TEXT NOT NULL,
  parent_id TEXT,
  write_no INTEGER,                            -- the write that made it; null for an item an agent's output made
  data TEXT NOT NULL,                          -- the Item, as JSON
  meta TEXT,                                   -- what the board knows that the item does not say (ItemMeta)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (task_id, id)
) STRICT, WITHOUT ROWID;
CREATE UNIQUE INDEX thread_items_pos ON thread_items(task_id, pos);
CREATE INDEX thread_items_user_time ON thread_items(type, created_at) WHERE type = 'user_message';
```

`thread_requests` and `thread_events` follow the old shape the same way (`write_no` on requests). Events are kept
for 24 hours, as now.

## What is not in the database

- A run's output, input and markers: its folder under `runs/` ([07-agents.md](07-agents.md#the-run-folder)).
- Uploaded files (`attachments/`), task documents' work folders (`documents/`), skills synced for runs, cloned skill
  sources, the hub's SSH key, downloaded releases (`app/`), the three identity files (`host_id`, `auth_token`,
  `hub_token`). The layout inside the data folder is the old one ([inventory](inventory/07-server-root-api.md),
  section 3), so the same code paths and habits apply.
- Usage per config, link connections, pairing codes, release check results: memory, rebuilt at startup.
