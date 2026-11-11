# 11. Moving an existing board over

The new server does not read the old database. A one-off importer converts it, and the switch is made per machine,
with the old server's files left as they were so that going back is one command. The importer is written last
(M9), when the schema has stopped moving.

## What stays on disk, untouched

The new server runs on the **same data folder**. Only the database is new.

| On disk                                                         | At the switch                                                                                   |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `huntaway-2.db` (and `-wal`, `-shm`)                            | Read once by the importer, never written. It is the backup and the way back                     |
| `board.db`                                                      | Written by the importer                                                                         |
| `projects/<id>/worktrees/…`, repositories, branches `ia/…`, refs under `refs/huntaway/` | Unchanged. Tasks keep their stored `worktree_path` and `branch`                  |
| `runs/<id>/`                                                    | Unchanged. Old runs have all exited; their folders are only read for token counts and pruned after 14 days |
| `attachments/`, `documents/`, `profiles/`, `skill-sources/`, `ssh/`, `cua-driver/`, `gh-shim/` | Unchanged                                                              |
| `host_id`, `auth_token`, `hub_token`                            | Unchanged, so links between hosts, bookmarked board URLs and paired devices stay valid          |
| `app/`                                                          | Left for the old server. The new release line keeps its staged versions in `app-2/`             |
| Agent sessions (`~/.claude/projects/…`, `~/.codex/…`)           | Unchanged. A task resumes its session: same session id, same config folder, same working folder |
| tmux sessions                                                   | Keep running: the socket name and session names are the same                                    |
| The browser's storage                                           | The same origin and the same `ia.*` keys: the token, drafts and preferences are still there     |

## The importer

`huntaway import-legacy --from <old db> [--data-dir <dir>] [--check] [--force]`

1. **Refuses** unless: the old server is not running on that data folder; the old database is at schema version 130
   with a set of named migrations the importer knows (it lists any it does not); no run is live (`runs.status` is
   not `exited`) unless `--force`, which records them as interrupted; and `board.db` does not exist.
2. Opens the old file read-only and writes `board.db.partial` through the new server's own repositories and
   schemas, so that **every imported row has passed the schema the server will read it with**. A row that fails is
   written to `import-report.json` with its table, key and the decoding error, and the import continues; `--check`
   exits non-zero if the report is not empty.
3. Renames `board.db.partial` to `board.db` and writes the report.

It is a program of the same code base (`apps/server/src/cli/importLegacy/`), one module per table family, each a
pure function from old rows to new rows with a test of its own. It reads the old tables with hand-written row
schemas that describe what is actually there, legacy forms included.

### Table by table

| Old                                                   | New                                         | Conversion                                                                                              |
| ----------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `profiles`                                            | `profiles`                                  | Drop `claude_config_dir`, `summarizer`. `summarizers` from the list, or the single as a one-element list. `approval_rules` from the `approval_rules:<id>` setting |
| `claude_configs`                                      | `agent_configs`                             | As is                                                                                                   |
| `projects`                                            | `projects`                                  | Drop `summarizer`, `subproject_pull_requests`. Fill `is_git`, `has_commits` from the folder             |
| `tasks`                                               | `tasks`, `task_queue`                       | Below                                                                                                   |
| `threads`                                             | `threads`                                   | `task_id`, `seq`, `created_at`                                                                          |
| `thread_items`, `thread_item_origins`                 | `thread_items`                              | `write_no` is the lowest origin message id; `data` decoded with the item schema, unknown fields kept; drop `turn_id`, `live` |
| `thread_requests`                                     | `thread_requests`                           | `write_no` from `metadata.message_id`; status carried into the request                                   |
| `thread_events`, `messages`, `mcp_calls`              | —                                           | Not imported. `threads.seq` is kept, so a client's next watch gets a snapshot                            |
| `sqlite_sequence` row for `messages`                  | `counters('thread_write')`                  | The high-water mark, so new write numbers continue after the old ids                                    |
| `runs`                                                | `runs`                                      | In `rowid` order, so `seq` keeps the order. `stop_requested` 0/1/2 to `none`/`requested`/`interrupted`. All `exited` |
| `token_usage`, `call_usage`, `context_stats`, `review_stats`, `checkpoints`, `pr_watches`, `pr_states`, `documents`, `approval_log` | the same | As is; `message_id` columns renamed `write_no`                       |
| `permission_requests`                                 | `permission_requests`                       | `pending` becomes `expired` (no run is live to answer to)                                               |
| `review_thread_skills`, `thread_mcp_servers`          | `thread_tools`                              | Merged by `task_id`                                                                                     |
| Agent tools tables, `pens`, docs tables, hosted-docs tables | the same                              | As is; `pens.hidden` dropped                                                                            |
| `automations`, `automation_runs`                      | the same                                    | Tokens and secrets kept, so webhook URLs registered elsewhere still work. A stored `task_type` of `plan`/`artifact`/`diagram` becomes a label |
| `workflows`, `workflow_runs`                          | the same                                    | Legacy node kinds (`set_status`, `trigger` on `status`/`finished`) converted to `column` nodes as the old reader does. A run still `running` is ended as "interrupted by the move" |
| `links`, `device_tokens`, `push_subscriptions`        | the same                                    | As is. `push_answer_tokens` not imported                                                                |
| `settings`                                            | `settings`, `profiles.approval_rules`       | Host settings by name; the VAPID key (so browsers' push subscriptions stay valid); telemetry settings. Migration flags and `telegram*` dropped |
| `setting_versions`                                    | the same                                    | As is                                                                                                   |
| `telemetry_outbox`                                    | the same                                    | As is: the old server is stopped, so nothing is in flight                                               |
| `desktop_ops`                                         | the same                                    | A `running` row becomes `interrupted`                                                                   |
| `named_migrations`, `db_origin`                       | —                                           |                                                                                                         |

### Tasks

- **Columns**: by name. Dropped: `subproject`, `thread_items`, `thread_source`, `now_at`, the `queued_*` columns and
  `steering`. `summary` (one object or a list) becomes `summaries`. `rewind` null stays null.
- **Queue**: a `queued_message` becomes one `task_queue` row. Its source is `agent` if `queued_from_agent`,
  `routine` if `queued_routine`, otherwise `user`; when `queued_user_text` differs from the whole text, the user's
  part and the rest become two rows in that order. `queued_routine_runs` become parked rows.
- **Run state**: `running` false, `agent_wait` null, `steerable` false, `steering` empty, `background_work` and
  `servers` null. A task that was `in_progress` with nothing queued becomes `needs_attention` with the reason
  "Interrupted by the move to the new server", as a restart does today.
- **Legacy forms** (inventory 09, section 9, lists all eighteen): `kind='scratch'` rows are already tasks;
  `work_dir` keeps both of its forms (absolute, and relative to the data folder); a `claude_config_id` that names no
  config stays, and reads as the default; JSON columns with fields added over time are read with their defaults.
- **Subprojects are dropped as a feature, and their work is kept**: a subproject task becomes an ordinary task
  (`subproject` gone); a task inside it keeps its row, thread, branch and stored `base_branch`, and loses
  `parent_id`. Nothing is deleted. Their merge lanes become the project's. If an unmerged task still targets a
  subproject's branch at the switch, the report names it so it can be given `merges_into` by hand.
- **Review, summary and workflow-step threads** keep `kind='review'` and `parent_id`.
- **Thread kinds are checked**: after the import, `threadKindOf` must classify every row; a row it cannot classify
  is in the report.

### `--check`

After writing, and on its own against an existing pair of files, the importer compares:

- Row counts per table, old against new, with the expected differences (dropped tables, queue rows).
- Per task: its key resolves to it; its item and request counts match; the ids of its first and last items match;
  its cost equals the sum of its runs' costs as before.
- Every stored JSON value decodes with the new schema (the report lists any that do not).
- Every `worktree_path` that the old database says is `ready` exists on disk.
- A sample of 200 threads: `threads.watch`'s snapshot of the new server equals the old `GET /thread?limit=300`
  answer for the same task, item for item, when both servers are run on copies.

## The switch, on one machine

1. Update the phone app and the desktop app to builds that speak the new protocol. Both keep their pairing: device
   tokens are imported.
2. Wait until no agent is running. Stop the old server.
3. `huntaway import-legacy --from huntaway-2.db --check`. On a board the size of the one measured (2,848 tasks,
   244,000 thread items, 7,000 runs, 1.3 GB) this is minutes; M9 measures it.
4. Start the new server on the same data folder and port. The browser reloads into the new UI with its token.
5. Open a task, send a message (the session resumes), open its terminal (the tmux session is still there), look at
   the Changes tab, check a webhook automation fires.

**Going back**: stop the new server, start the old one. Its database is as it was at step 2. What was done on the
new server since then is not in it: tasks created, messages sent, runs' costs. Worktrees and branches made in the
meantime are still on disk and would need removing by hand. So the switch is rehearsed first.

**Rehearsal**: `scripts/copy-live-board.sh` makes a scrubbed copy of a live data folder's database. The importer
and `--check` run on the copy in CI's nightly job from M9 on, and by hand against every host's database before its
switch. A test server started on an imported copy with agents off is browsed through the whole-app checks.

## Several hosts<a id="several-hosts"></a>

The old and new servers cannot link to each other. A fleet is moved together: stop every host, import each, start
each. Links are imported with the tokens they hold, and the identity files are unchanged, so the hosts find each
other again without re-linking. A host that cannot be moved at the same time shows as "needs an update" on the hub
until it is.

## After the switch

- The old repository takes fixes only until the last host has moved, then is archived.
- `import-legacy`, its old-row schemas and its tests stay in the code base for two releases, then are removed.
