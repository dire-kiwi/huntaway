// Huntaway's telemetry tables in ClickHouse (the old telemetry/schema.ts, unchanged, so hosts on the old server and on
// this one write the same tables). A string rather than a .sql file, because release packages only carry the code.
//
// `huntaway telemetry init` runs each statement in the database it's given, so names aren't qualified. It runs again
// after an update, so every statement can run any number of times. A column added later goes at the end of its table
// here and as `ALTER TABLE … ADD COLUMN IF NOT EXISTS` after the tables, which is a metadata-only change. Hosts on
// another version don't break each other: an older host leaves new columns at their defaults, and a newer host's
// fields that aren't columns yet are dropped (the exporter sends `input_format_skip_unknown_fields=1`).
//
// Retries aren't counted twice: each insert has an `insert_deduplication_token`, and a non-replicated MergeTree only
// deduplicates with `non_replicated_deduplication_window` set, which is 0 by default.

export const SCHEMA = `
-- The servers' own events (telemetry.ts's emit): runs, their cost, tasks, prompts, reviews, merges.
CREATE TABLE IF NOT EXISTS events (
  ts DateTime64(3, 'UTC') CODEC(Delta, ZSTD(1)),
  inserted_at DateTime DEFAULT now(),
  host_id LowCardinality(String),
  host_name LowCardinality(String),
  version LowCardinality(String),
  profile LowCardinality(String),
  project_id LowCardinality(String),
  project_key LowCardinality(String),
  task_id String,
  task_key String,
  -- Empty unless the profile sends its tasks' titles.
  task_title String,
  run_id String,
  session_id String,
  -- run_start, run_end, run_usage, side_call, task_status, permission, review, merge, board_tool, automation_run, ...
  event LowCardinality(String),
  -- A run's kind (prompt, compact, review, ...), a side call's (title, window), ...
  kind LowCardinality(String),
  runtime LowCardinality(String),
  model LowCardinality(String),
  effort LowCardinality(String),
  tool LowCardinality(String),
  status LowCardinality(String),
  outcome LowCardinality(String),
  duration_ms UInt64 DEFAULT 0,
  wait_ms UInt64 DEFAULT 0,
  num_turns UInt32 DEFAULT 0,
  input_tokens UInt64 DEFAULT 0,
  output_tokens UInt64 DEFAULT 0,
  cache_read_tokens UInt64 DEFAULT 0,
  cache_write_tokens UInt64 DEFAULT 0,
  reasoning_tokens UInt64 DEFAULT 0,
  -- What the API would have charged; estimated when it's worked out from tokens rather than reported.
  cost_usd Float64 DEFAULT 0,
  estimated Bool DEFAULT false,
  exit_code Int32 DEFAULT 0,
  error String CODEC(ZSTD(3)),
  attrs Map(LowCardinality(String), String),
  INDEX run_bf run_id TYPE bloom_filter GRANULARITY 4
) ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (project_id, task_id, ts)
TTL toDateTime(ts) + INTERVAL 2 YEAR
SETTINGS non_replicated_deduplication_window = 1000, ttl_only_drop_parts = 1;

-- The agents' own OpenTelemetry log events (Claude Code's and Codex's), received by the server for its runs and mapped
-- onto columns (telemetry/otlp.ts). Joins events on run_id, and on session_id.
CREATE TABLE IF NOT EXISTS agent_events (
  ts DateTime64(3, 'UTC') CODEC(Delta, ZSTD(1)),
  inserted_at DateTime DEFAULT now(),
  host_id LowCardinality(String),
  host_name LowCardinality(String),
  version LowCardinality(String),
  profile LowCardinality(String),
  project_id LowCardinality(String),
  project_key LowCardinality(String),
  task_id String,
  task_key String,
  task_title String,
  run_id String,
  runtime LowCardinality(String),
  agent_version LowCardinality(String),
  -- api_request, api_error, tool_result, tool_decision, user_prompt, compaction, sse_event, ...
  event LowCardinality(String),
  session_id String,
  prompt_id String,
  model LowCardinality(String),
  tool LowCardinality(String),
  decision LowCardinality(String),
  decision_source LowCardinality(String),
  -- 1 or 0 where the event says, -1 where it doesn't.
  success Int8 DEFAULT -1,
  duration_ms UInt64 DEFAULT 0,
  status_code UInt16 DEFAULT 0,
  input_tokens UInt64 DEFAULT 0,
  output_tokens UInt64 DEFAULT 0,
  cache_read_tokens UInt64 DEFAULT 0,
  cache_write_tokens UInt64 DEFAULT 0,
  reasoning_tokens UInt64 DEFAULT 0,
  cost_usd Float64 DEFAULT 0,
  error String CODEC(ZSTD(3)),
  attrs Map(LowCardinality(String), String),
  INDEX run_bf run_id TYPE bloom_filter GRANULARITY 4
) ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (project_id, task_id, ts)
TTL toDateTime(ts) + INTERVAL 1 YEAR
SETTINGS non_replicated_deduplication_window = 1000, ttl_only_drop_parts = 1;

-- The servers' log lines at or above the host's telemetry_logs level.
CREATE TABLE IF NOT EXISTS logs (
  ts DateTime64(3, 'UTC') CODEC(Delta, ZSTD(1)),
  inserted_at DateTime DEFAULT now(),
  host_id LowCardinality(String),
  host_name LowCardinality(String),
  version LowCardinality(String),
  level LowCardinality(String),
  module LowCardinality(String),
  message String CODEC(ZSTD(3)),
  task_id String,
  run_id String,
  attrs Map(LowCardinality(String), String)
) ENGINE = MergeTree
PARTITION BY toYYYYMMDD(ts)
ORDER BY (host_id, level, ts)
TTL toDateTime(ts) + INTERVAL 30 DAY
SETTINGS non_replicated_deduplication_window = 1000, ttl_only_drop_parts = 1;

-- Each server's samples, every minute: event-loop delay, memory, runs, the outbox.
CREATE TABLE IF NOT EXISTS metrics (
  ts DateTime64(3, 'UTC') CODEC(Delta, ZSTD(1)),
  host_id LowCardinality(String),
  host_name LowCardinality(String),
  version LowCardinality(String),
  name LowCardinality(String),
  value Float64,
  labels Map(LowCardinality(String), String)
) ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (name, host_id, ts)
TTL toDateTime(ts) + INTERVAL 90 DAY
SETTINGS non_replicated_deduplication_window = 1000, ttl_only_drop_parts = 1;
`

/** The tables, which are what the exporter's rows go to. */
export const TABLES = ["events", "agent_events", "logs", "metrics"] as const
export type Table = (typeof TABLES)[number]

export const isTable = (name: string): name is Table => (TABLES as ReadonlyArray<string>).includes(name)
