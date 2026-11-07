# Telemetry in ClickHouse

Plan for task HA-284: send Huntaway's telemetry to ClickHouse, so it can be queried across hosts and kept for longer
than a board keeps it. That means what agents did and cost, how each server is behaving, and the servers' logs.

Four subagents did the research on 2026-11-07. One covered this code, one ClickHouse, one the agent CLIs' own
telemetry, and one OpenTelemetry pipelines. They worked from primary docs and source, linked below. Nothing was
installed or run, except a probe of the OpenTelemetry JS SDK's size and start-up time. Huntaway is described as of
`master` at `b946171` (schema 102).

**In one line:** each server writes typed rows straight to ClickHouse's HTTP interface with `fetch`. The rows go
through an outbox table in its SQLite database, so there is no new dependency and no collector, and a laptop that was
offline catches up later. The agents' own OpenTelemetry is pointed at the server that started them: Claude Code and
Codex both export OTLP/JSON. The server tags those events with the run, strips what shouldn't leave the machine, and
sends them through the same outbox. ClickHouse 26.8 LTS runs on a new 4 GiB VM, with Grafana in front of it.

## What it's for

Questions the board can't answer today:

- **Cost:** what agents cost per project, model, runtime and week, across every host. Which tasks were expensive, and
  why: turns, retries, cache misses, compactions.
- **Time:** where the time goes in a run. API latency, tool calls, waiting on permission prompts, review rounds and the
  merge queue.
- **Tools and prompts:** which tools fail, which permission prompts come up most and how long they wait. Those are
  candidates for approval rules.
- **Host health:** event-loop stalls, memory, slow routes, errors, restarts and updates, and links that drop.
- **Logs:** every server's logs, searchable in one place rather than per host in journald or a terminal.

Not goals:

- **Replacing the board's Analytics page.** It keeps reading SQLite, per host, and works without ClickHouse. A later step
  could have it read ClickHouse for views across hosts.
- **Telemetry about other people's installs.** It's off by default and only goes to a ClickHouse that its owner sets up.
  Huntaway never phones home.
- **Tracing the server's own requests.** See _Later_.

## What there is today

- **Token and cost data** (`apps/server/src/agent/tokens.ts`):
  - `token_usage` has one row per run and model: input, output, cache read and write, and reasoning tokens, `cost_usd`
    and `runtime`.
  - It's counted after a run ends, from `runs/<id>/out.jsonl`, by `on_run_ended` (`tokens.ts:658`). For Claude it diffs
    the `result` line's `modelUsage`. That's needed because a resumed session's totals are cumulative, so summing
    results counts the earlier turns twice. For Codex it diffs `thread/tokenUsage/updated`.
  - `runs` has the kind, the times, `cost_usd`, `session_id` and `result_error`. It doesn't have the model, which is
    only in `token_usage`, or the exit code, which is only in the run folder's `exit` file. Run folders are pruned
    after 14 days.
  - `analytics.ts` builds the board's reports from these tables, plus `approval_log`, `review_stats`, `call_usage` (title
    and window-restart calls), `mcp_calls`, `context_stats` and `automation_runs`.
- **Health:**
  - `lag.ts` keeps an event-loop delay histogram and each route's time on the thread, in memory only
    (`GET /api/debug/event-loop`).
  - `crash.ts` logs uncaught errors.
  - Link changes (`hosts/hub.ts:583`, `:596`) and update checks (`update/`) are only log lines.
- **Logs:** plain text written with `console.*` to stderr, about 335 calls. `stamp_console` (`serve.ts:70`) puts the
  time in front of each line. The server doesn't keep a log file of its own: systemd's journal, the desktop app (its
  last 40 lines) or `test-server.sh` keep its output.
- **Clients:** the web UI, the desktop app and the mobile app report no errors anywhere.
- **Dependencies:** the server has one runtime dependency, `ws`, and its memory use is watched closely (the README's
  _Memory_ section).
- **Agent environment:** `agent/runner/launch.ts` builds every run's command line and environment, with the task,
  project, profile, model and run in scope. Claude runs get their env at `launch.ts:379`. Codex runs go through
  `huntaway codex-run`, which starts one `codex app-server` per run (`agent/codex/rpc.ts:56`). Variables the server
  reads itself must be listed in `SERVE_ENV` (`agent/runs.ts:182`) so that agents don't inherit them.
- **Run secrets:** each run already has a secret of its own for the board's MCP servers, an HMAC of the host token
  (`run_secret`, `mcp/http.ts:77`), served at `/api/mcp/<run id>/…` on the host's internal URL. A run can only act as
  itself and never holds the host's token. The agents' telemetry can come back the same way.
- **Shutdown:** `shutdown` (`serve.ts:663`) and the restart behind updates (`update/admin.ts:500`, `process.exit(75)`)
  both exit at once, with no hook for flushing. A durable outbox means none is needed.

## The shape of it

Three ways were compared:

| Approach                                                                                                            | Gains                                                                                                                                | Costs                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(a)** The server writes its own typed tables over HTTP                                                            | Columns, sort keys and TTL are ours, and SQL is pleasant. No extra process. Buffering is an outbox in SQLite, which we already have. | Doesn't cover the agents' own OTLP by itself.                                                                                                                                                                                                                                           |
| **(b)** Everything is sent as OTLP to an OpenTelemetry Collector, whose `clickhouseexporter` writes the OTel schema | The standard pipe. The agents work out of the box, and so does HyperDX.                                                              | Every attribute is a string in a `Map` column, so queries cast them. Domain facts (task, run, cost) become attribute bags. Every laptop needs its own collector with a disk queue, because a central one can't be reached offline. The exporter is beta for logs and alpha for metrics. |
| **(c)** Hybrid: (a) for the server's events, a collector for the agents                                             | The best of both.                                                                                                                    | Still a collector to run on each machine.                                                                                                                                                                                                                                               |

This plan is **(a), stretched to cover the agents**. Huntaway already sets each agent's environment, so it points their
OTLP/HTTP-JSON exporters at itself. It receives that data, maps it onto typed columns and sends it through the same
outbox. That gives the agents' events without a collector, and the server can enforce an allowlist of what leaves. A
collector stays possible later: point the agents' endpoint at one instead.

It was ruled out to instrument the server with `@opentelemetry/sdk-node`:

- It means 70–190 packages (40–68 MB) and 200–350 ms of start-up, as measured.
- HTTP spans from `node:http` under ESM need Node's experimental loader hook, which Node 26 warns is deprecated.
- Spans of board API calls say little that `lag.ts` doesn't already.

OTLP/JSON is stable, so a hand-written receiver is small. The rows the server writes are its own and need no OTel
encoding at all.

## 1. Where ClickHouse runs

The recommendation is a **new Proxmox VM, 208 `telemetry`**:

- **The VM:** 2 vCPU, 4 GiB of RAM and 100 GB of disk, on Ubuntu 24.04, LAN-only like VM 203.
- **Compose:** Docker Compose with two services:
  - `clickhouse/clickhouse-server:26.8`. That's the current LTS (26.8.34, 2026-10-22, supported to about August 2027),
    and the tag is pinned because Docker Hub has no `lts` tag.
  - Grafana, with the official `grafana-clickhouse-datasource` plugin (4.23).
- **ClickHouse config (`config.d`)** for a small machine, following
  [Altinity's low-memory profile](https://kb.altinity.com/altinity-kb-setup-and-maintenance/configure_clickhouse_for_low_mem_envs/):
  - `max_server_memory_usage_to_ram_ratio` 0.75
  - `mark_cache_size` 256 MB, `index_mark_cache_size` 64 MB, `uncompressed_cache_size` 16 MB
  - `background_pool_size` 2, `max_threads` 2, `max_concurrent_queries` 8
  - Remove `trace_log`, `text_log`, `query_thread_log`, `processors_profile_log` and `opentelemetry_span_log`.
  - Give `query_log` and `part_log` a 7-day TTL.
  - Keep `metric_log` and `asynchronous_metric_log`, which ClickHouse's built-in `/dashboard` reads.
  - ClickHouse's [own guidance](https://clickhouse.com/docs/operations/tips) is that 2 GB works "with tuning" at low
    ingest. 4 GiB gives that headroom and leaves room for Grafana.
- **Users**, made with SQL ([user](https://clickhouse.com/docs/sql-reference/statements/create/user),
  [quota](https://clickhouse.com/docs/sql-reference/statements/create/quota)):
  - An admin user, for DDL.
  - **One writer per host**, with `INSERT` on `huntaway.*` only, restricted to `HOST IP '192.168.50.0/24'` and kept in
    check by a quota. A settings profile pins `async_insert=1`, `wait_for_async_insert=1` and
    `input_format_skip_unknown_fields=1`. One user per host means one host can be revoked.
  - A read-only `grafana` user with `SELECT` on `huntaway.*`.
- **Backups:** a nightly `BACKUP DATABASE huntaway TO Disk('backups', …)`, incremental from a weekly full backup
  ([backup](https://clickhouse.com/docs/operations/backup)), copied off with the VM's other backups.
- **Network:** plain HTTP on the LAN to start with, like the other LAN apps. TLS comes first if anything is ever exposed
  beyond the LAN. Laptops away from home keep their rows in their outbox and send them when they're back.

Alternatives:

- **ClickHouse Cloud:** Basic is about $160–190 a month for this workload. Inserts every few seconds would keep the
  service from idling. That figure is inferred from the
  [billing examples](https://clickhouse.com/docs/cloud/manage/billing/overview) ($186 a month at 24/7) and not
  measured. It's worth it only if the data has to be reachable from outside without exposing the homelab.
- **ClickStack all-in-one image:** it needs 4 GB or more on its own, brings MongoDB with it and is "not recommended for
  production". HyperDX can be added later against this ClickHouse, if Grafana isn't enough.
- **No server at all:** each host writes JSONL files and `clickhouse-local` queries a synced folder. That's possible,
  but nothing is live, so it's kept as a fallback.

Setting up the VM is work for the `proxmox` project (PRO). The Compose file and `config.d` belong there too, in
`vms/208-telemetry.md`.

## 2. Tables

A `huntaway` database with four tables. Their DDL lives in this repository, because the exporter's columns follow it,
as `apps/server/src/telemetry/schema.sql`. `huntaway telemetry init --url … --user <admin>` applies it. The command can
run any number of times, and changes are written as `ADD COLUMN IF NOT EXISTS`, which is a metadata-only change
([ALTER](https://clickhouse.com/docs/sql-reference/statements/alter/column)).

Hosts on different versions don't break each other:

- An older host leaves new columns at their defaults.
- A newer host's extra fields are dropped until `init` runs again, because the writer profile sets
  `input_format_skip_unknown_fields`.

Design rules:

- The columns that are known get types. Anything else goes in a `Map(LowCardinality(String), String)`.
- `LowCardinality(String)` for host, event, model, tool and status.
- `DateTime64(3, 'UTC')` with `CODEC(Delta, ZSTD)`.
- Defaults instead of `Nullable`.
- Monthly partitions, only so that TTL can drop whole parts.
- No materialized views until a query is slow. At under about 100M rows a year, `GROUP BY` on the raw table takes
  milliseconds.

```sql
CREATE TABLE huntaway.events (            -- the server's own events (§4)
  ts DateTime64(3, 'UTC') CODEC(Delta, ZSTD(1)),
  inserted_at DateTime DEFAULT now(),
  host_id LowCardinality(String), host_name LowCardinality(String), version LowCardinality(String),
  profile LowCardinality(String),
  project_id LowCardinality(String), project_key LowCardinality(String),
  task_id String, task_key String, task_title String,   -- task_title is empty unless titles are sent (§7)
  run_id String, session_id String,
  event LowCardinality(String),           -- run_start, run_end, run_usage, task_status, permission, review, merge, …
  kind LowCardinality(String),            -- run kind (prompt, compact, review), task kind, …
  runtime LowCardinality(String), model LowCardinality(String), effort LowCardinality(String),
  tool LowCardinality(String), status LowCardinality(String), outcome LowCardinality(String),
  duration_ms UInt64 DEFAULT 0, wait_ms UInt64 DEFAULT 0, num_turns UInt32 DEFAULT 0,
  input_tokens UInt64 DEFAULT 0, output_tokens UInt64 DEFAULT 0,
  cache_read_tokens UInt64 DEFAULT 0, cache_write_tokens UInt64 DEFAULT 0, reasoning_tokens UInt64 DEFAULT 0,
  cost_usd Float64 DEFAULT 0, estimated Bool DEFAULT false,
  exit_code Int32 DEFAULT 0, error String CODEC(ZSTD(3)),
  attrs Map(LowCardinality(String), String),
  INDEX run_bf run_id TYPE bloom_filter GRANULARITY 4
) ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (project_id, task_id, ts)
TTL toDateTime(ts) + INTERVAL 2 YEAR
SETTINGS non_replicated_deduplication_window = 1000, ttl_only_drop_parts = 1;
```

The other three follow the same pattern:

- **`agent_events`:** the agents' OpenTelemetry events, mapped in §6, one row per event. Columns: `ts`, the host,
  profile, project, task and run columns, `runtime`, `agent_version`, `event` (`api_request`, `tool_result`,
  `tool_decision`, `api_error`, `user_prompt`, `compaction`, `sse_event`, …), `session_id`, `prompt_id`, `model`,
  `tool`, `decision`, `decision_source`, `success`, `duration_ms`, `status_code`, the token and `cost_usd` columns,
  `error` and `attrs`.
  - It's ordered by `(project_id, task_id, ts)` and kept for one year.
  - It joins `events` on `run_id`, and on `session_id`, which is `runs.session_id` for Claude.
- **`logs`:** `ts`, `host_id`, `host_name`, `version`, `level`, `module`, `message String CODEC(ZSTD(3))`, `task_id`,
  `run_id` and `attrs`. It's ordered by `(host_id, level, ts)`, with daily partitions and a 30-day TTL.
- **`metrics`:** samples, `ts`, `host_id`, `name`, `value Float64` and `labels Map(…)`. It's ordered by
  `(name, host_id, ts)` and kept for 90 days.

Retries aren't counted twice. That relies on two things: every insert carries `insert_deduplication_token`, and the
tables set `non_replicated_deduplication_window`, which defaults to 0 on a non-replicated MergeTree, so without it
nothing is deduplicated ([dedup](https://clickhouse.com/docs/guides/developer/deduplicating-inserts-on-retries)).

## 3. The exporter

The exporter is a new module, `apps/server/src/telemetry.ts`, with a `telemetry/` folder for the receiver and the
mapping. There's one call for the rest of the server: `telemetry.emit(table, row)`. It does nothing unless telemetry
is set up and the row's profile sends.

- **Outbox:** a migration (schema 103) adds the table:

  ```sql
  telemetry_outbox (id INTEGER PRIMARY KEY, target TEXT, row TEXT, at TEXT)
  ```

  `emit` adds a row. An OTLP request's events go in one transaction.
  - The outbox is capped at 200,000 rows or 100 MB, whichever comes first. Past that, the oldest rows are dropped and
    counted.
  - When sending works again, a `telemetry_dropped` event says how many rows were lost.
  - The cap matters when ClickHouse is down for days, or when a laptop is away for a fortnight.

- **Flushing:**
  - Every 10 seconds, or at 1,000 rows, each target's rows are sent as one `POST /?query=INSERT INTO huntaway.<target>
    FORMAT JSONEachRow`.
  - Bodies are gzipped with async `zlib.gzip`, so the work stays off the event loop.
  - Credentials go in the `X-ClickHouse-User` and `X-ClickHouse-Key` headers. `AbortSignal.timeout(30_000)` limits
    each request, as the server's other `fetch` calls do.
  - That is about 40 lines of code. `@clickhouse/client` 1.25 has no dependencies, but it has no retries either, and the
    write path doesn't need what it does offer.
  - ClickHouse's guidance is at least 1,000 rows per insert, or about one insert a second
    ([insert strategy](https://clickhouse.com/docs/best-practices/selecting-an-insert-strategy)). A few hosts every 10
    seconds is far below where parts would pile up, and `async_insert` covers the rest.
- **Retries without duplicates:**
  - Before a batch is sent, the setting `telemetry_inflight` records its target and its first and last outbox ids. The
    batch's token is `<host_id>:<target>:<first>-<last>`.
  - When the insert succeeds, those rows are deleted and the setting is cleared.
  - After a failure, or a restart mid-send, exactly that range is sent again with the same token. Otherwise, rows that
    arrived meanwhile would make a different batch, with a different token, and ClickHouse would accept it again.
- **Backoff:** from 10 seconds to 5 minutes, with jitter.
  - A 4xx other than 429 is a configuration error, such as a wrong password, a missing table or a missing grant. The
    exporter stops and says so in the status, rather than retrying for ever.
- **No flush on exit:** the outbox is in the database, so `shutdown`, an update's `exit(75)` and a crash lose nothing.
  The next start sends what's left.
- **Settings:** host settings, through the whitelist in `api/host.ts`:
  - `telemetry_url` and `telemetry_database` (default `huntaway`)
  - `telemetry_user`, and `telemetry_password`, which is never returned by the API, like `telegram_token:<profile>`
  - `telemetry_logs`: `off`, `warn` (the default) or `info`
  - `telemetry_agents`: on or off
  - A host without a UI can be set up with `--telemetry-url` / `IA_TELEMETRY_URL`, with the credentials in the URL. It
    goes into `SERVE_ENV` and the flag table in `docs/guide/server.md`.
  - Test servers and PR previews never set it, so they never send anything.
- **Status:** `GET /api/telemetry` returns the rows queued per target, when the last send succeeded, the last error and
  the rows dropped.
- **UI:** Settings → the host's page (`HostPage.tsx`) gets a **Telemetry** section:
  - Fields for URL, database, user and password (write-only).
  - A **Test** button, which sends an empty `INSERT INTO huntaway.events` and so checks the address, the login and the
    grant all at once.
  - The status line and the two toggles.
  - Each profile's settings get **Send this profile's tasks** (§7).
  - Hosts reached through the hub are set up from the same page, as their other settings are.

## 4. Events the server sends

| Event                  | Sent from                                                 | Fields beyond the common ones                                                                                                                        |
| ---------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server_start`         | `serve.ts`, once it's ready                               | `version`, build id, boot id, Node version, platform                                                                                                 |
| `server_update`        | `update/release.ts`, `update/admin.ts` before `exec`      | from and to version, how (release, checkout)                                                                                                         |
| `run_start`            | `agent/runs.ts` `start`                                   | `kind`, `runtime`, `model`, `effort`, permission mode, `session_id`                                                                                  |
| `run_end`              | `tokens.on_run_ended`, after `token_usage` is counted     | `status` (result subtype), `exit_code` and signal from the `exit` file, `duration_ms`, `num_turns`, `cost_usd`, `error`, whether it needed attention |
| `run_usage`            | the same place, one per model                             | tokens, `cost_usd` and `estimated` from that run's `token_usage` row                                                                                 |
| `side_call`            | the code that writes `call_usage`                         | title and window-restart calls: model, tokens, cost                                                                                                  |
| `task_status`          | the task status change                                    | from, to, resolution                                                                                                                                 |
| `permission`           | the `approval_log` insert (`agent/approval_rules.ts:488`) | `tool`, decision, `outcome`, who answered, `wait_ms`                                                                                                 |
| `review`               | `review/stats.ts` `record`                                | round, findings, verdict                                                                                                                             |
| `merge`                | `agent/runner/merge.ts`, `review/merged.ts`               | queued, merged, conflict, failed, with `wait_ms`                                                                                                     |
| `board_tool`           | the `mcp_calls` insert                                    | `tool`, `duration_ms`, ok or error                                                                                                                   |
| `automation_run`       | the `automation_runs` insert                              | outcome, cost                                                                                                                                        |
| `link_up`, `link_down` | `hosts/hub.ts`, `hosts/hub/dial_out.ts`                   | the other host's id and name, how (direct, SSH, broker)                                                                                              |
| `error`                | `crash.ts`                                                | the message and the top of the stack, deduped as `crash.ts` already does                                                                             |

**Common fields:**

- `ts`
- `host_id` and `host_name` (`state.ts:104`) and `version`
- `profile`, the profile's name, so the same profile on two hosts matches
- `project_id` and `project_key`
- `task_id` and `task_key` (`<project key>-<number>`)
- `run_id`, where there is one

**Cost:** costs come from `token_usage`, not from adding up `result` lines. Resumed sessions are cumulative (see above),
and `tokens.ts` already works out each run's share. With a Claude subscription, `cost_usd` is an estimate of API
prices, not money spent. The `estimated` column says which rows are which.

**Metrics:** every 60 seconds, each host also sends samples to `metrics`:

- the event-loop delay's p50, p99 and maximum since the last sample, from `lag.ts`
- the slowest routes' time on the thread
- `rss` and `heapUsed`
- runs running, queued and waiting for the user
- the outbox's depth

## 5. The servers' logs

`stamp_console` (`serve.ts:70`) already wraps `console.*` for `serve`. It also adds lines at or above `telemetry_logs`
to the outbox:

- The level comes from the method (`warn` or `error`) and from the `INFO`/`WARN` in the modules' `log` helpers' lines.
  The module comes from the `huntaway: <module>:` prefix where a line has one.
- Run and task ids found in a line are copied into their own columns.
- No call sites change.

Two guards:

- At most 100 lines a second go to the outbox. The rest are counted, so a log storm can't fill the outbox.
- The exporter's own messages skip the tee, so a failing send doesn't log about itself in a loop.

## 6. The agents' own telemetry

**The receiver:** `POST /api/otlp/<run id>/v1/logs` on the host's internal URL. Its bearer token is the run's
`run_secret`, as with `/api/mcp/<run id>/…`. The run, task, project and profile come from the run the URL names. A run
can only send as itself, and nothing in the payload can claim another run.

- It accepts OTLP/JSON, gzipped or not, up to 4 MB. It answers as the
  [OTLP spec](https://opentelemetry.io/docs/specs/otlp/) says, with `partialSuccess` when it rejects records.
- It's off when `telemetry_agents` is off or the profile doesn't send. Then the variables below aren't set at all.

**Claude Code** ([monitoring](https://code.claude.com/docs/en/monitoring-usage)). These go in the env at
`launch.ts:379`:

```sh
CLAUDE_CODE_ENABLE_TELEMETRY=1
OTEL_LOGS_EXPORTER=otlp
OTEL_METRICS_EXPORTER=none                  # its metrics repeat the events; see Later
OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json
OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=<internal url>/api/otlp/<run id>/v1/logs
OTEL_EXPORTER_OTLP_LOGS_HEADERS=Authorization=Bearer%20<run secret>
CLAUDE_CODE_OTEL_SHUTDOWN_TIMEOUT_MS=5000   # default 2000; the docs say to raise it if data is dropped at exit
```

- `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_TOOL_DETAILS` and the other content switches stay off.
- Variables in the process environment beat a repository's `.claude/settings.json`. Claude Code doesn't pass `OTEL_*`
  on to the Bash tool, hooks or MCP servers
  ([settings](https://code.claude.com/docs/en/settings-reference#variables-claude-code-ignores-in-env)).
- The events that matter, with their attributes:
  - `api_request`: model, `cost_usd`, `duration_ms`, input, output and cache tokens, `request_id`
  - `api_error`: error and `status_code`, sent only once retries are used up
  - `tool_result`: `tool_name`, `success`, `duration_ms`, `error_type`, input and result sizes
  - `tool_decision`: decision and `source`
  - `user_prompt`: its length only
  - `compaction`: tokens before and after
  - `subagent_completed`
- Every event carries `session.id` and `prompt.id`. `prompt.id` ties together everything one prompt caused.

**Codex** ([advanced config](https://developers.openai.com/codex/config-advanced)). These `-c` overrides go on the
`app-server` command line at `rpc.ts:59`:

```sh
codex -c 'otel.exporter={otlp-http={endpoint="<internal url>/api/otlp/<run id>/v1/logs",protocol="json",headers={Authorization="Bearer <run secret>"}}}' \
      -c 'otel.environment="huntaway"' -c 'otel.tool_result.max_bytes=0' app-server
```

- `codex app-server` builds its OTel provider from its loaded config, which includes `-c`. A project's
  `.codex/config.toml` can't set `otel`. This comes from reading the source; it hasn't been run.
- `metrics_exporter` is left alone. Its default sends Codex's own metrics to OpenAI, and turning that off for runs
  isn't this feature's business.
- Its events:
  - `api_request`: duration and status
  - `sse_event`: on `response.completed`, the input, output, cached and reasoning tokens and `ttft_ms`
  - `tool_decision` and `tool_result`
  - `turn_cost`: arrives late, from a poll of OpenAI every 150 seconds
- Every event carries `conversation.id`.

**Mapping and stripping:** a table maps each known event's attributes onto `agent_events`' columns. Other attributes
go into `attrs` only if they're on an allowlist. These are always dropped:

- `user.email`, `user.account_uuid`, `user.account_id`, `user.id` and `organization.id`. Claude Code always sends them,
  and Codex always sends the email and account id.
- Codex `tool_result`'s `arguments` and `output`. Codex sends the full shell command or patch, and up to 2 KB of output,
  by default.
- Prompt and response text, if a user's own config turned them on.
- `host.name`. The server sends its own host.

**Don't take over someone else's telemetry.** A login may already export its own telemetry. A work login's managed
settings might send to an employer's collector, for example. In that case the run's variables would redirect it. So
before setting anything, the launch checks the profile's config dir:

- `settings.json` `env`, and managed settings, for `CLAUDE_CODE_ENABLE_TELEMETRY` and `OTEL_*`
- `config.toml` `[otel]` for Codex

If any of those is set, the launch leaves that runtime alone and the UI says so.

**Robustness:**

- Lost agent events don't affect cost. Cost comes from `run_end` and `run_usage`, which the server works out from the
  run's own output.
- Claude Code's export from `-p` has broken before:
  - [#46338](https://github.com/anthropics/claude-code/issues/46338): v2.1.100 exported nothing in `-p`.
  - [#91165](https://github.com/anthropics/claude-code/issues/91165): v2.1.252's metrics exporter, closed without a
    fix.
- So the phase has an end-to-end check against the current version. A dashboard panel compares `agent_events` per run
  with `run_end`, so a silent break shows up.
- Runs have to exit normally after their `result` line, without being killed, so the exporter gets its 5 seconds.

Title and window-restart calls (`agent/title.ts`, `agent/window.ts`) start `claude` on their own. They don't get these
variables. Their cost already goes out as `side_call`.

## 7. Privacy and profiles

- **Off by default, everywhere.** Nothing is sent until a host is given a ClickHouse and a profile opts in.
- **Per-profile opt-in.** A profile column, `telemetry`, defaults to off. The destination is per host, but whether a
  profile's tasks are sent is the profile's choice.
  - This matters here: the `work` and `personal` profiles share a host, and work tasks shouldn't land in a personal
    store without anyone deciding that.
  - Host-level rows (`server_start`, `metrics`, logs) aren't any profile's. Log lines can name tasks, so `telemetry_logs`
    is a choice of its own.
- **What text is sent:**
  - Ids, keys, names, models, tools, decisions, counts and durations.
  - Task titles only if the profile says so: a second toggle, **Include task titles**, on by default once the profile
    sends.
  - Never prompts, messages, tool input or output, diffs or file contents.
  - Error messages are sent, cut to 1 KB.
- **The guide:** `docs/guide/server.md` gets a _Telemetry_ section that says all of this: what is sent and what never
  is, how to set it up, and that nothing goes anywhere the owner didn't configure.

## 8. Dashboards

The Grafana dashboards are JSON files in this repository (`docs/telemetry/grafana/`), so they change along with the
schema. They're provisioned on VM 208. A first set:

- **Cost:** per day by project, model and runtime; the most expensive tasks; cost per merged task; cache hit rate.
- **Runs:** runs per day by kind and outcome; how long they take; turns; failed results and exit codes; compactions.
- **Agents:** API latency and errors by model; tool calls by tool, with failure rate and duration; permission
  decisions and how long prompts wait. A panel compares `agent_events` per run with `run_end`, to see whether the
  agents' export is working.
- **Hosts:** event-loop delay p99 and stalls, memory, slow routes, errors, restarts and updates, link changes, and the
  outbox's depth and drops.
- **Logs:** Grafana's logs panel on `logs`, filtered by host, level and module.

## Phases

Each phase is a task of its own, in order. Phases 1 and 2 are where most of the work is.

1. **ClickHouse and Grafana on VM 208** (PRO).
   - The VM, the Compose file, `config.d`, users and quotas, backups, and the inventory entry.
   - Done when Grafana can query a test table, and a writer can insert but can't select or drop.
2. **The schema and `huntaway telemetry init`** (HA).
   - `schema.sql` and the command. It's small, but it comes first because the exporter's columns follow it.
3. **The exporter and the server's events** (HA).
   - The migration for the outbox, `telemetry.ts` (outbox, flush, tokens, backoff, cap), the settings, the API and the
     UI.
   - The events in §4, the 60-second samples, and the logs tee (§5).
   - The profile toggle, and the guide's section.
4. **The agents' telemetry** (HA).
   - The OTLP receiver and its mapping, and the variables for Claude and Codex runs.
   - The check for a login's own telemetry config.
   - Tested with both runtimes.
5. **Dashboards and history** (HA).
   - The Grafana dashboards.
   - `huntaway telemetry backfill`, which sends past `runs`, `token_usage`, `approval_log`, `review_stats`,
     `call_usage` and `automation_runs`, from before telemetry was turned on. It sends nothing after the time recorded
     when it was turned on, so history isn't counted twice.

Later, if wanted:

- **Traces:** set `TRACEPARENT` per run, so Claude Code's spans (beta) join a trace for the run. A run's log records then
  carry its trace id even without a traces exporter.
- **Agent metrics:** `claude_code.lines_of_code.count`, `commit.count`, `pull_request.count` and `active_time.total`.
  Both CLIs default to delta temporality, which suits `sum()`.
- **The board's Analytics page reads ClickHouse**, for views across hosts.
- **HyperDX** against the same ClickHouse.
- **Alerts:** a host's outbox growing, error spikes, a day's cost over a limit.
- **Errors from the web UI and the desktop app** (`window.onerror`, an ErrorBoundary), sent to the server's own
  endpoint, which adds them to the outbox.

## Testing

- **Unit tests, with a fake ClickHouse.** A `node:http` server that records each insert, can fail on purpose and can
  hang.
  - It checks batching, gzip, the headers, and that a retried batch is the same range with the same token, including
    after a restart.
  - It checks the backoff, that a 4xx stops the exporter, the cap with its `telemetry_dropped` event, the logs tee's
    rate limit, and that the exporter doesn't log about itself in a loop.
  - It checks that a profile that doesn't send produces no rows.
- **An integration test against a real ClickHouse**, which runs when `IA_TEST_CLICKHOUSE_URL` is set. CI doesn't need
  it.
  - It applies `schema.sql`, inserts each table's rows, and checks that a retried token is deduplicated.
  - It checks that an older host's rows and a newer host's extra fields both go in.
- **State from before the change:**
  - Runs that were already going when telemetry is turned on: there's a `run_end` without a `run_start`, and the
    dashboards have to allow for that.
  - A host on an older version doesn't send.
  - The schema migration runs on a database that already has rows.
- **The receiver:** recorded OTLP/JSON from real Claude Code and Codex runs is kept as fixtures. The tests check the
  mapping, the allowlist and the stripping, and that another run's secret is refused, as is a run on another profile.
- **End to end on a test server, for both runtimes.** A haiku run of each, with the receiver on and a local ClickHouse
  in Docker.
  - `agent_events` has its `api_request` and `tool_result` rows, and `events` has `run_start`, `run_end` and
    `run_usage`.
  - Then the server is restarted mid-flush, ClickHouse is stopped for a while and started again, and nothing is lost or
    doubled.
- **Event-loop cost:** `scripts/ui-profile.mjs` and `lag.ts`'s numbers, with telemetry off and on, under a few busy
  runs.

## Risks and things not verified

- **Codex's options weren't run.** The `-c otel.exporter=…` form for `app-server` and its `OTEL_RESOURCE_ATTRIBUTES`
  support come from the source, so phase 4 starts by checking them.
- **Claude Code's `-p` export has regressed before.** A recent version needs the end-to-end check, and the dashboard
  panel above catches later breaks.
- **ClickHouse Cloud's price is inferred.** It's taken from the docs' examples, and it isn't verified that trickled
  inserts keep a Basic service awake. That only matters if Cloud is chosen.
- **Two dedup cases weren't tested.** ClickHouse 26.2 and later dedup async inserts too, but a token combined with an
  async insert wasn't tested. Neither was a table with materialized views, which async inserts under dedup refuse
  (`NOT_IMPLEMENTED`). There are none planned, and the integration test covers the first case.
- **Writes to SQLite.** The outbox adds a write for each event to SQLite. An OTLP request's events go in one transaction,
  but a busy agent sends a request every 5 seconds. Phase 3 measures it with `lag.ts`.
- **Clock skew between hosts.** `ts` is the host's clock, and `inserted_at` is ClickHouse's, so skew can be seen.

## Decisions for the user

The plan assumes the recommended answer to each.

1. **Where ClickHouse runs:** a new 4 GiB VM 208 (recommended), ClickHouse Cloud (about $160–190 a month), or alongside
   the apps on VM 203.
2. **Which profiles send:** each profile opts in, off by default (recommended), or everything on a host that's set up.
3. **What text is sent:** ids, keys and task titles, but no prompts or tool content (recommended); no titles either; or
   content too, through the agents' `OTEL_LOG_*` switches.
4. **Laptops away from home:** they keep rows in their outbox until they're back on the LAN (recommended), or ClickHouse
   is exposed over TLS through the Cloudflare tunnel.
5. **A collector:** none, with the server receiving the agents' OTLP itself (recommended), or an OpenTelemetry Collector
   on each machine.

## Sources

- **ClickHouse:**
  - [HTTP interface](https://clickhouse.com/docs/interfaces/http)
  - [Async inserts](https://clickhouse.com/docs/concepts/features/operations/insert/asyncinserts)
  - [Insert strategy](https://clickhouse.com/docs/best-practices/selecting-an-insert-strategy)
  - [Deduplicating inserts on retries](https://clickhouse.com/docs/guides/developer/deduplicating-inserts-on-retries)
  - [Partitioning key](https://clickhouse.com/docs/best-practices/choosing-a-partitioning-key)
  - [JSON type](https://clickhouse.com/docs/sql-reference/data-types/newjson)
  - [Map vs JSON in ClickStack](https://clickhouse.com/docs/clickstack/ingesting-data/schema/map-vs-json)
  - [Usage recommendations](https://clickhouse.com/docs/operations/tips)
  - [Backup](https://clickhouse.com/docs/operations/backup)
  - [Billing](https://clickhouse.com/docs/cloud/manage/billing/overview)
  - [Grafana plugin](https://clickhouse.com/docs/integrations/grafana)
  - [JS client](https://clickhouse.com/docs/integrations/javascript)
  - [Releases](https://github.com/ClickHouse/ClickHouse/releases)
- **Claude Code:**
  - [Monitoring](https://code.claude.com/docs/en/monitoring-usage)
  - [Environment variables](https://code.claude.com/docs/en/env-vars)
  - [Settings reference](https://code.claude.com/docs/en/settings-reference)
  - [Result message](https://code.claude.com/docs/en/agent-sdk/typescript#sdkresultmessage)
  - [Cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking)
- **Codex:**
  - [Advanced config](https://developers.openai.com/codex/config-advanced)
  - [Config reference](https://developers.openai.com/codex/config-reference)
  - [`codex-rs/otel`](https://github.com/openai/codex/tree/main/codex-rs/otel)
  - [app-server protocol](https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol)
- **OpenTelemetry:**
  - [OTLP spec](https://opentelemetry.io/docs/specs/otlp/)
  - [opentelemetry-proto examples](https://github.com/open-telemetry/opentelemetry-proto/tree/main/examples)
  - [clickhouseexporter](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/exporter/clickhouseexporter/README.md)
  - [JS ESM support](https://github.com/open-telemetry/opentelemetry-js/blob/main/doc/esm-support.md)
  - [ClickStack deployment](https://clickhouse.com/docs/use-cases/observability/clickstack/deployment)
  - [Observability schema design](https://clickhouse.com/docs/use-cases/observability/schema-design)
