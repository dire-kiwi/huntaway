# 11. Moving an existing board over

The new server does not read the old database. A one-off importer converts it, and the switch is made per machine,
with the old server's folder left exactly as it was so that going back is one command. The importer is written last
(M9), when the schema has stopped moving.

## A data folder of its own

The new server has **its own data folder**, `~/.local/share/huntaway-effect` (`$XDG_DATA_HOME/huntaway-effect`,
`--data-dir`, `HUNTAWAY_DATA_DIR`), and its own default port, 7879. Until the switch the two boards are separate
things on one machine: different folders, databases, identities, ports, tmux servers and temp folders. Nothing the
new server does while it is being built can touch the board that is in daily use.

At the switch, the importer fills the new folder from the old one. It **copies and never moves**, and it writes
nothing under the old folder.

**An import ends that separation.** An imported board has the old board's host id, tokens, links and stored paths,
so a server started on it is the old host: same tmux server, same links, same repositories and worktrees. That is
what the switch wants and what nothing else may have. So there are two kinds of import and no third: the switch,
made once with the old server stopped for good, and a [rehearsal](#rehearsal), which makes a board that cannot act.

| In the old folder                                               | What the importer does                                                                           |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `huntaway-2.db` (and `-wal`, `-shm`)                            | Reads it once, read-only, into the new folder's `board.db`                                       |
| `host_id`, `auth_token`, `hub_token`, `ssh/`                    | Copies them, so links between hosts and bookmarked board URLs stay valid. Not in a rehearsal. (The tmux server is not the same: the new server's is `tmux -S <data dir>/tmux.sock`, not the old `-L ia-<host>`; see below) |
| `attachments/`, `skill-sources/`                                | Copies them: the server finds these by id under its own folder                                   |
| Worktrees (`projects/<id>/worktrees/…`), scratch folders, document folders (`documents/<id>`), assistant workspaces | **Leaves them where they are.** Every path the database holds is written as an absolute path: `worktree_path` already is; a `work_dir` relative to the old folder, a project's `worktrees_root` and `scratch_path`, and the profile scratch folder a project-less thread worked in are made absolute |
| `runs/<id>/`                                                    | Copies the folders of runs that ended in the last 14 days (token counts and failure tails are read from them); older ones are due for pruning anyway |
| `backups/`, `app/`, `gh-shim/`, `cua-driver/`, `outgoing.bundle` | Not carried. The new server makes its own                                                        |

Why paths are kept rather than files moved:

- **An agent's session is found by its working folder.** Claude Code and Codex look a session up under the folder it
  ran in. A thread that keeps its folder resumes; one whose folder moved gets "No conversation found".
- **A git worktree is registered in its repository by absolute path**, and attachment paths are written into message
  text as they were.
- So **the old folder stays on disk after the switch**. Its database and server files are dead weight; its worktrees
  and work folders are in use. New worktrees of an imported project go to that project's stored `worktrees_root`,
  which is still in the old folder; a project made on the new server uses the new one. Moving a project's worktrees
  across later is `git worktree move` behind a command of its own, not part of the switch.

Outside both folders, nothing changes: repositories, branches `ia/…`, refs under `refs/huntaway/`, agent config
folders and their sessions. Running tmux sessions keep running, but on the old server's tmux server (`-L ia-<host>`):
the new one keeps its terminals on a socket in its own folder (6.1, `terminal/tmux.ts`), so after the switch a task's
terminal is a new shell and the old session is left to the user (corrected in 9.3: the plan had the tmux server
carried with the host id).

## The importer

`huntaway import-legacy --from <old data folder> [--data-dir <new folder>] [--check] [--force] [--rehearsal]`

1. **Refuses** unless all of these hold, and says which does not:
   - No process has the old database open (found as `copy-live-board.sh` finds it today: `/proc/*/fd` on Linux,
     `lsof` on macOS). `--rehearsal` is the one exception: it reads a snapshot ([below](#rehearsal)).
   - The old database is at schema version 130 with a set of named migrations the importer knows (it lists any it
     does not).
   - No run is live (`runs.status` is not `exited`), unless `--force` or `--rehearsal`, which record them as
     interrupted.
   - **Every thread is kept as items** ([below](#threads-not-yet-items)): no task has `thread_source <> 'items'`
     and no thread has `error` set. It lists the tasks by key. `--force` does not override this.
   - The new folder has no `board.db` (a board tried out there during development is moved aside by hand first, not
     merged).
2. Opens the old file read-only and writes `board.db.partial` through the new server's own repositories and
   schemas, so that **every imported row has passed the schema the server will read it with**. A row that fails is
   written to `import-report.json` with its table, key and the decoding error, and the import continues; `--check`
   exits non-zero if the report has a failure in it.
3. Copies the identity files, `ssh/`, `attachments/`, `skill-sources/` and recent run folders, renames
   `board.db.partial` to `board.db`, and writes the report and `import.json` (`{ from, at, old_host_id,
   rehearsal }`), which the server reads at every start ([the guard](#the-guard)).

It is a program of the same code base (`apps/server/src/cli/importLegacy/`), one module per table family, each a
pure function from old rows to new rows with a test of its own. It reads the old tables with hand-written row
schemas that describe what is actually there, legacy forms included.

### Threads not yet items<a id="threads-not-yet-items"></a>

The new server reads threads only as items, and the importer does not carry the old translator that made items
from `messages` rows. The board that was measured has every task on items and an empty `messages` table. That is
one board: another host may differ, so the importer checks and never assumes. The old code leaves three states
behind ([inventory 08](inventory/08-threads.md), sections 2 and 12; [09](inventory/09-data-model.md), section 9):

| State in the old database                                                    | How it comes about                                                                                   | What the importer does |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------- |
| A task with `thread_source <> 'items'`                                       | It has not been moved: its run or a prompt was open at every start since, or rebuilding its items failed. Its thread is its `messages` rows; its items, if any, may be stale | **Refuses**, listing the tasks |
| A thread with `error` set                                                    | Writing its items beside its messages stopped on a fault. Only tasks still on messages have it        | **Refuses**, listing them |
| A `messages` row of a task that is on items                                  | One message whose items could not be written; the old server kept the row "so it isn't lost". No old command converts it | **Carries it**, below |

What the operator does about a refusal, on the old build, before trying again:

1. Start the old server once and let it settle. At every start it moves each quiet task onto items
   (`flip_all`), rebuilding items from messages where they are stale, and deletes the moved task's `messages` rows.
   Its log ends with how many are still on messages.
2. For a task it could not rebuild (the log names it), `huntaway threads-rebuild <key>` on the stopped old server
   rebuilds that one thread and prints why it fails. Once it passes, start the old server again so the task moves.
3. A task that is still listed after that has history the old translator cannot read. It is a bug to fix in the old
   repository, not something to import around: the importer has no flag that drops a thread.

A kept `messages` row of an items task is imported, since nothing on the old side can convert it:

- The importer runs it through the new translator for its kind, which is the old one ported and may have had the
  fault fixed. If that gives items, they are written with the row's id as their `write_no`, which puts them where
  the message was.
- If it does not, the row becomes one `notice` item (level `warning`, code `legacy_message`, text "A message the
  old board could not show"), with the row's `kind` and `data` kept whole as JSON in `detail`, at the same
  `write_no`.
- Either way the report counts it, by task. It is a note and not a failure: the content is in the new database.

So after an import, `messages` is accounted for row by row. `--check` fails if any old `messages` row is neither
converted nor carried, which cannot happen unless the importer has a bug.

A thread whose `converter` is an older translator version is imported as it is when its task is on items: the old
server reads such a thread without rebuilding it, and there are no messages left to rebuild it from.

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
| `thread_events`, `mcp_calls`                          | —                                           | Not imported. `threads.seq` is kept, so a client's next watch gets a snapshot                            |
| `messages`                                            | `thread_items`                              | Expected empty. Rows of a task not on items stop the import; a row of a task on items is carried ([above](#threads-not-yet-items)) |
| `sqlite_sequence` row for `messages`                  | `counters('thread_write')`                  | The high-water mark, so new write numbers continue after the old ids                                    |
| `runs`                                                | `runs`                                      | In `rowid` order, so `seq` keeps the order. `stop_requested` 0/1/2 to `none`/`requested`/`interrupted`. All `exited` |
| `token_usage`, `call_usage`, `context_stats`, `review_stats`, `checkpoints`, `pr_watches`, `pr_states`, `documents`, `approval_log` | the same | As is; `message_id` columns renamed `write_no`                       |
| `permission_requests`                                 | `permission_requests`                       | `pending` becomes `expired` (no run is live to answer to)                                               |
| `review_thread_skills`, `thread_mcp_servers`          | `thread_tools`                              | Merged by `task_id`                                                                                     |
| Agent tools tables, `pens`, docs tables, hosted-docs tables | the same                              | As is; `pens.hidden` dropped                                                                            |
| `automations`, `automation_runs`                      | the same                                    | Tokens and secrets kept, so webhook URLs registered elsewhere still work. A stored `task_type` of `plan`/`artifact`/`diagram` becomes a label |
| `workflows`, `workflow_runs`                          | the same                                    | Legacy node kinds (`set_status`, `trigger` on `status`/`finished`) converted to `column` nodes as the old reader does. A run still `running` is ended as "interrupted by the move" |
| `links`, `push_subscriptions` (web)                   | the same                                    | As is. `device_tokens`, Expo subscriptions and `push_answer_tokens` wait for the phone app                                                                |
| `settings`                                            | `settings`, `profiles.approval_rules`       | Host settings by name; the VAPID key (so browsers' push subscriptions stay valid: the old `vapid_private_key` is the bare P-256 scalar, which WebCrypto can't import, so the importer writes `vapid_key` as the JWK `{d, x, y}` with the public point worked out by `node:crypto`, 6.8); telemetry settings. Migration flags and `telegram*` dropped |
| `setting_versions`                                    | the same                                    | As is                                                                                                   |
| `telemetry_outbox`                                    | the same                                    | As is: the old server is stopped, so nothing is in flight                                               |
| `desktop_ops`                                         | the same                                    | A `running` row becomes `interrupted`                                                                   |
| `named_migrations`, `db_origin`                       | —                                           |                                                                                                         |

### Tasks

- **Columns**: by name. Dropped: `subproject`, `thread_items`, `thread_source` (every task is on items by then:
  the importer refused otherwise), `now_at`, the `queued_*` columns and `steering`. `summary` (one object or a list) becomes `summaries`. `rewind` null stays null.
- **Queue**: a `queued_message` becomes one `task_queue` row. Its source is `agent` if `queued_from_agent`,
  `routine` if `queued_routine`, otherwise `user`; when `queued_user_text` differs from the whole text, the user's
  part and the rest become two rows in that order. `queued_routine_runs` become parked rows.
- **Run state**: `running` false, `agent_wait` null, `steerable` false, `steering` empty, `background_work` and
  `servers` null. A task that was `in_progress` with nothing queued becomes `needs_attention` with the reason
  "Interrupted by the move to the new server", as a restart does today.
- **Legacy forms** (inventory 09, section 9, lists all eighteen): `kind='scratch'` rows are already tasks;
  `work_dir` in either of its forms (absolute, or relative to the old data folder) becomes absolute; a `claude_config_id` that names no
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

- Row counts per table, old against new, with the expected differences (dropped tables, queue rows). `messages`
  is not one of them: each of its rows must be in the report as converted or carried.
- Per task: its key resolves to it; its item and request counts match; the ids of its first and last items match;
  its cost equals the sum of its runs' costs as before.
- Every stored JSON value decodes with the new schema (the report lists any that do not).
- No stored path is relative. A `worktree_path` the old database says is `ready`, or a `work_dir`, that is not on
  disk is listed as a note: the old board has the same gap, and the importer cannot fill it.
- A sample of 200 threads: `threads.watch`'s snapshot of the new server equals the old `GET /thread?limit=300`
  answer for the same task, item for item, when both servers are run on copies.

## The switch, on one machine

1. Update the desktop app to a build that speaks the new protocol.
2. Wait until no agent is running. Stop the old server.
3. `huntaway import-legacy --from ~/.local/share/issue-agent --check` (or wherever the old folder is). On a board
   the size of the one measured (2,848 tasks, 244,000 thread items, 7,000 runs, 1.3 GB) this is minutes; M9 measures
   it.
4. Start the new server **on the old server's port** (`--port 7878`). A browser's storage belongs to an address, so
   on the same address the token, drafts and preferences under the `ia.*` keys are still there; on another port the
   board asks for its token again and starts with empty drafts.
5. Open a task, send a message (the session resumes), open its terminal (a new tmux session: the old one stays on the old tmux server), look at
   the Changes tab, check a webhook automation fires.

**Going back**: stop the new server, start the old one on its folder. Nothing there was written, so it is as it was
at step 2. What was done on the new server since then is not in it: tasks created, messages sent, runs' costs.
Worktrees the new server made for imported projects are in the old folder's worktree roots and would need removing
by hand. So the switch is rehearsed first.

### The guard<a id="the-guard"></a>

Two servers must never act as one host. The importer's first refusal covers the moment of the import; `import.json`
covers every start after it. A server starting on a folder that has one:

- with `rehearsal: true`, starts [read-only](#rehearsal) and in no other way. No flag turns that off: a rehearsal
  folder is thrown away, never promoted.
- otherwise, refuses to start while any process has the old folder's database open, and says to stop the old
  server or to go back properly. This is what catches "went back to the old server, then started the new one too".

## Rehearsal<a id="rehearsal"></a>

A rehearsal answers two questions before the switch: does this board's data convert, and does the result look
right. It has to answer them while the live board is running, and without being able to touch it.

`huntaway import-legacy --from <old folder> --data-dir <spare folder> --rehearsal --check`

**What the importer does differently:**

| Normal import                                              | With `--rehearsal`                                                                                         |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Refuses while the old server runs                          | Runs beside it. It takes a snapshot with SQLite's online backup through a read-only connection into the spare folder, converts the snapshot and deletes it. This is how `copy-live-board.sh` reads a live database today; `node:sqlite`'s `backup` was run for this plan against a database another connection was writing |
| Copies `host_id`, `auth_token`, `hub_token`, `ssh/`        | Copies none. The spare folder gets an identity of its own on first start, so its tmux server, its tokens and its name on the network are not the live board's |
| Writes every converted row                                 | Converts and checks every row, so the report is the real one, and then **does not write** the rows that are credentials for something outside the folder: `links`, `push_subscriptions` and the VAPID key, the telemetry destination and `telemetry_outbox`, automation tokens and webhook secrets, Asana and docs-site sign-ins |
| Live runs stop the import                                  | Recorded as interrupted in the copy                                                                         |
| `import.json` with `rehearsal: false`                      | `rehearsal: true`                                                                                           |

Stored paths are still the real ones, into the old folder and the real repositories. That is what makes the
rehearsal worth browsing, and it is why the server on it must be unable to act.

**A read-only server.** On a rehearsal folder `Main.ts` builds a different, smaller program
([06-server.md](06-server.md#a-read-only-server)). The rule is one sentence: _it reads; it starts nothing, changes
nothing outside its own folder, and calls nothing on the network._ It is held at four places, so that one mistake in
one of them is not enough:

1. **Sessions.** Every session gets the scope `read` and no other, whatever token it presents. The `Auth`
   middleware then refuses every RPC that changes anything with `Forbidden`, as for any missing scope.
   `host.info` says `read_only: true` and the UI shows a banner with the board's name and when it was imported.
2. **Nothing is started.** No loop from the start-up list, no reactor, no `Recovery` reconcilers
   (`Merges`, `Dependencies`, `Reviews`, `WorkflowEngine.resume`, `Restack.resume`), no scheduler, automations, PR
   or merged watcher, pruners, sweepers, terminal reaper, usage, update checks, push, telemetry or settings sync.
   No links are dialled or accepted, discovery does not answer, and the webhook, MCP and hook paths are not mounted.
3. **`Proc`.** Its read-only layer runs one program, `git`, with a fixed list of reading subcommands (`status`,
   `diff`, `log`, `show`, `rev-parse`, `merge-base`, `for-each-ref`, `ls-files`, `cat-file`) under
   `GIT_OPTIONAL_LOCKS=0`, so the Changes tab and history draw. Anything else fails with `Unavailable`: an agent,
   the shim, tmux, `gh`, `ssh`, a script, a writing git command. Code reached by mistake cannot act.
4. **The network.** The `HttpClient` layer fails every request, and no outgoing socket is opened.

A service test holds it: a board imported with `--rehearsal` from a fixture whose paths point at a real repository
in a temp folder; every reading RPC is called and every changing RPC is attempted; then the repository and the old
folder must be byte for byte what they were, the recording `Proc` must have seen only the allowed git commands, and
the recording `HttpClient` nothing.

**What a rehearsal cannot show**, because showing it would be acting: a session resuming, a terminal, a worktree
being made, a merge. Those are tried on a board made to be thrown away: the old repository's
`scripts/test-server.sh --seed` with one real task run on a cheap model, stopped, and imported for real into a
scratch folder. It has an identity and a repository of its own, so the import is a true switch in miniature. This is
part of 9.1's acceptance and is the first thing done on each host's own machine before its switch.

**In CI and for measurements**, `scripts/copy-live-board.sh` stays the tool. In this repository it snapshots an old
database, applies the old script's scrub to it (runs exited, every path moved under `/nonexistent`, scripts, agent
configs, links, automations, PR watches, sign-ins and telemetry removed), writes throwaway identity files beside it,
and imports that into a test server started with `--no-agents` or the fake agent. With nothing real left to act on,
that server runs normally, which the measurements need. A nightly job on a self-hosted runner that has a board runs
it with `--check` from M9 on; hosted runners import the fixture database.

So, before a host's switch: `--rehearsal --check` on its real folder until the report has no failure, a look
through the read-only board, and the throwaway switch once.

## Several hosts<a id="several-hosts"></a>

The old and new servers cannot link to each other. A fleet is moved together: stop every host, import each, start
each. Links are imported with the tokens they hold, and the identity files are copied, so the hosts find each
other again without re-linking. A host that cannot be moved at the same time shows as offline on the hub until it
is: "needs an update" is for a host whose `link.hello` names another protocol, and an old server answers no
`link.hello` at all, so its link never connects (`LinkConnections`; corrected in 9.3).

## After the switch

- The old repository takes fixes only until the last host has moved, then is archived.
- `import-legacy`, its old-row schemas and its tests stay in the code base for two releases, then are removed.
