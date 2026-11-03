# Can existing Huntaway tasks be imported into agent-threads?

**Yes: we can convert their stored conversation history into the new item/event schema.** Existing tasks do not
need to be abandoned or started again. This needs a Huntaway-specific importer, rather than a SQL table rename or
replaying messages through a live agent. Resuming the agent's memory and adopting an already running process are
separate problems; a history import alone does neither.

This is HA-118's follow-up to [the adoption feasibility study](agent-threads-feasibility.md), specifically its
existing-threads blocker. Source review on 2026-11-03: Huntaway `3c09bfe`, agent-threads `327a862` from the local
`~/personal/agent-threads` checkout. No importer was implemented, no live data was changed, and no conversion or
session-resumption test was run. The earlier study's 205k-message / 490 MB figures are historical sizing, not a new
measurement or a prediction of migration time.

## Status: the importer's first steps (HA-128)

Huntaway now depends on agent-threads (a git dependency pinned to `b009454`, since moved to `c67cdbb` for the engine; it adds no second copy of any crate)
and has the first steps of the safe importer below, in `server/src/threads/`. Nothing in the server reads the new
tables yet: running agents, the API and the UI are unchanged. (Since then, see *Engine core* below.)

- **Store** (`threads/store.rs`): agent-threads' `Store` on huntaway.db, in `at_threads`, `at_events`,
  `at_snapshots` and `at_runs` (migration 85). It passes the crate's store conformance cases
  (`spec/conformance/store.json`, copied next to it at the pinned revision). A thread whose `metadata.task_id`
  names a task is deleted with it.
- **Converter** (`threads/import.rs`): a pure function from a task's stored messages to a `Thread`, saved
  events from seq 1, the snapshot the crate's reducer folds them into, a disposition for every source row
  (converted, redundant or retained) and warnings. It follows the table below; turns aren't reconstructed (no
  `turn_id`, no turn events), and calls with no result are cancelled with a warning. A thread can have several
calls with one tool_use id: each is its own item. Results go to the call with the id in the same subagent and
session that's still waiting (or, stored before its call, the next one), prompts to the call with their input
among those that could still ask (waiting in the current session, or not come to yet; with no call that has
their input, none), and a subagent's messages to its call in their session. Where more than one call fits, they
go to none, with a warning. The task_* messages the board
writes for Codex's children (no `task_type`, by `tool_use_id`) are read as subagents, as are their compactions. Answered
question prompts keep their answers as the board stored them (a list for each question; a secret's hidden).
- **Dry run and staging** (`threads/report.rs`): `huntaway threads-import --db <copy> [--json] [--stage]
  [task ids or keys]` opens the database read-only and reports each task's conversion, its warnings and what
  stops it being switched over now (a run that's running or alive between turns, queued input, a merge, an open
  prompt). `--stage` also writes the conversions through the store, checking that the saved events fold into the
  snapshot before saving it; staging the same source again changes nothing, and an older import is replaced. The
  database must be at this build's version: run it on a copy a test server has opened, such as
  `scripts/copy-live-board.sh`'s.

On a scrubbed copy of the live board (2026-11-03, a debug build), all 1,373 tasks converted: 243,246 messages
(602 MB) gave 226,094 events (536 MB) in about a minute. 224,551 rows converted, 18,689 were redundant (mostly
Bash commands' `task_*` messages and subagents' prompts) and 6 were retained with a warning (4 `task_*` messages
for background tasks that never started, 2 `local_workflow` tasks). Other warnings: 32 calls with no result in 9
tasks, one background subagent that never said it ended, and 14 unanswered questions. 15 tasks couldn't have been
switched over then (14 open prompts, 1 queued message). Staging them all (on an earlier copy) took the 744 MB database to 1.99 GB:
saved events and their snapshot each hold a full copy of a thread, so a real cutover should expect about 2.5
times the space, or keep fewer snapshots (the crate needs only the latest, and only to avoid folding every event
on load).

**Engine core (HA-143)** (`threads/engine.rs`): a task's agent can run on agent-threads, chosen per task.
`tasks.run_engine` (migration 86) is fixed when a task's first run starts: `agent_threads` when the host's
*Run new tasks' agents on agent-threads* setting (host settings, Agent defaults; `agent_threads_new_tasks`) is on,
for a task (not a review) with no conversation yet, and `legacy` otherwise. Every task from before is legacy.
One backend in `AppState::agent_threads` runs them, on the store, with Claude Code and Codex under `ia-shim` in
`<data>/at-runs` (agent-threads' shim spawner writes no `prompt` file, which ia-shim now allows).
`recover()` at start re-attaches to their runs, and shutting down leaves them going.

- The board's gates are unchanged: `runner::start_run` registers the run as it does for a legacy task (queued
  messages, dependencies, usage limits, merges, archived projects), and `runner/launch.rs` prepares it the same way.
  Only the last step goes to the engine. The task's thread (id = task id, `metadata.task_id`) gets the run's launch
  options: the profile's config dir, `--add-dir`s (Codex: writable roots), `--settings` with the gh hook,
  `--allowedTools`/`--disallowedTools` and `TMPDIR`. It also gets the model, effort and permission mode (Claude's
  `auto` as an extra `--permission-mode auto`), the system prompt as its capability, and the board's `huntaway mcp`
  and `gh-mcp` helpers and the project's servers as MCP servers. Then it's sent the message, or compacts. The helpers
  call the board as the thread (`IA_RUN_ID=thread:<task id>`, which the board takes as the task's run at the time
  of each call, as their process outlives a run), and read the board's token from a 0600 file (`IA_TOKEN_FILE`),
  as their environment is the agent's. For Codex, the board's servers have the timeouts and approvals its adapter
  gives them (a `wait` lasts up to an hour), and threads get the sandbox's network, as legacy Codex runs do. Claude
  Code's MCP config is a 0600 file (agent-threads `c67cdbb`, AT-32), not on its command line.
- It runs with `user_settings: true` (Codex: `user_config: true`). Skills behave as on a legacy run (checked
  with Claude on a test server): the project's skills load through `--add-dir`, a disabled skill's
  `Skill(name)` in `--disallowedTools` is refused, and the crate's own skills plugin isn't used. Codex gets the
  project's skills as the crate's skills.
- A board run covers one stretch of the thread's work, until the thread stops running. A message sent meanwhile
  goes to the crate, which steers the turn or carries the message into its next one, and goes in the board's thread
  as steered at once. A stop interrupts (a message after it starts a new turn in the same run, which is then no longer
  stopped), and deleting the task deletes its thread. The thread's state is mirrored onto the task: its session,
  questions and plans (needs attention while one is open). The follower reads the thread's events in order, and a
  run ends with its last turn's `turn.completed`, with the outcome the thread has for that turn, through
  `runner::finish`, as a legacy run's exit does. A turn the thread starts by itself (an answer to a question kept
  open after its turn) gets a board run of its own.
- Tool permissions go to the board's own prompts (`mcp::permissions::prompt`: auto-allow, the mode as it is now,
  the permission card, `/api/permissions`). The crate's questions and plans stay its own requests, which the
  thread API (HA-145) answers.
- From the agent's own output (`on_harness_message`): the tools and skills it saw, rate limits, usage limits and
  Claude's cost.
- Not on the engine yet: rewinding (a rewind asked for is dropped with a notice), Codex's reviewer filesystem
  profile, MCP approvals and `auto` mode, Codex rate limits and cost, and context usage. The board's readers of
  raw messages (reviews' `changes_code`, summaries, titles, `last_message`) don't see the agent's items until
  HA-144. A thread's harness process stays alive between turns (one idle process per task), until AT-31 lets
  the board close it.

Not done yet, from the steps below: an import record with the source-to-item mapping and the report kept per
task, the cutover gate and `run_engine` marker, loading an imported thread in a backend and continuing it, and
the UI. Attachments are kept as the text that names them, and costs stay in Huntaway's runs.

## Three different migrations

| Goal | Feasibility | Requirement |
|---|---|---|
| Display existing tasks and conversations through the new schema | Yes, with the qualifications below | Convert stored rows into saved protocol events; keep board state and source rows |
| Continue an idle task with the same agent memory | Conditional | Preserve its native session id, runtime, profile config directory and working directory; the native session files must still exist |
| Adopt a process already running under Huntaway's shim | Not a history import | Keep the legacy follower until that process exits; do not invent an agent-threads run record for it |

The normalized history is the application's record of the conversation. Claude's session files and Codex's thread
store are the agent's memory. Writing `user_message` and `assistant_message` items does not feed them to the model.
Both upstream drivers support resuming a stored `Thread.session_id`; Rust `CreateOptions` still has no session-id
field, but an importer can set it through `Store` before the backend loads the thread. A missing session must be
reported as a fresh-session fallback, never presented as a successful continuation. Test both runtimes explicitly.

## Keep tasks; migrate their thread layer

agent-threads is a conversation schema, not a replacement for Huntaway's task schema. Keep the existing task id,
key, profile/project ownership, board column, dependencies, reviews, worktree/branch, PR links, queue and checkpoints
in Huntaway. Review threads are tasks in their own right: give each its own imported thread and retain the parent
relationship. Scratch and group tasks also need their actual working directory, not an assumed project worktree.

Use one thread per task initially, with the same id or an explicit task-to-thread mapping. Store only the app
identity needed by tools in `Thread.metadata`; continue enforcing profile access through Huntaway. A board status
such as `in_review`, `done` or dependency-waiting does not map to thread status `waiting`: the latter means a live
turn waiting for a request. A quiescent imported thread has no `run` and normally starts `idle`.

Implement upstream's `Store` on namespaced Huntaway tables (`at_threads`, `at_events`, `at_snapshots`, `at_runs`).
The supplied `SqliteStore` creates a `runs` table incompatible with Huntaway's existing `runs`; do not open it on
`huntaway.db`. A separate file works for a prototype, but complicates atomic cutover with task state.

## What survives conversion

Read full `messages` rows in ascending `id`, not API pages or `subagent_messages` summaries, which are clipped.
Message ids are globally allocated; new saved events need their own contiguous sequence starting at 1 per thread.
One row can produce several items/events. Preserve `created_at` and a mapping from source row/block to item ids.

| Stored Huntaway data | New representation | Qualifications |
|---|---|---|
| `kind=user`, `data.text` | `user_message` | Preserve `steered`; retain `auto`, `from_agent` and other app provenance in a Huntaway mapping/source record |
| `kind=claude`, assistant text/thinking blocks | `assistant_message` / `reasoning` | One item per block, in order; final saved text is enough without streaming deltas |
| Assistant `tool_use` | `tool_call` | Preserve the call id where unique; classify by tool name/input, with `other` for unknown tools |
| User `tool_result` blocks | `item.updated` on the matching call | Text/blocks become result content; `is_error` determines failure. These are not new user messages |
| `parent_tool_use_id` | `parent_id` pointing at a subagent call | Pre-index calls and parents; preserve nested relationships, including calls whose results arrive later |
| `system/compact_boundary` and a synthetic compaction summary | `compaction` and optional update | Preserve available trigger/token metadata and summary; do not turn the summary into a user's instruction |
| Stored `result` | `turn_result` | Preserve known outcome/duration. Retain cost and original result text separately where the target fields cannot express them |
| `kind=event` | `notice` | Normalize levels to info/warning/error; keep detail and source data |
| Permission/question cards and their stored answers | Request events where equivalent, otherwise Huntaway history cards | Historical cards must not become actionable live approvals; see below |
| `task_started/progress/updated/notification` | Subagent state where supported, otherwise notices plus retained source | Background completion and Skill-forked agents need explicit handling beyond `parent_tool_use_id` |

The existing UI already proves the basic data is present: `app/src/threadModel.ts` extracts text/thinking/calls,
joins results by `tool_use_id`, groups child messages, and renders compactions and outcomes from those rows. We can
perform that normalization once on the server and save it, rather than keeping it as renderer-only logic.

The upstream Claude driver also accepts final assistant blocks without preceding `stream_event`s: it adds the item
when it was not streamed. So missing deltas are **not** a barrier to historical items. However, its translator is
part of a live session, expects active-turn bookkeeping, and doesn't cover Huntaway's user/event/question rows.
Use a pure stored-row converter; share/extract tool classification helpers upstream if useful (`claude_tool` is
currently crate-private). Do not launch a harness or call `send` to import history.

### Fidelity limits and special cases

- Huntaway's `runner/output.rs::slim` truncates long tool results, replaces tool-result images with `[image]`,
  removes signatures, message usage and most `tool_use_result` metadata. Init and streaming events are not saved.
  Missing structured edit patches, full outputs and per-turn token counts cannot be recovered from these rows.
  Inputs may still describe an edit, but do not claim they prove the exact resulting diff. Never invent zero token
  counts to fit `Usage`'s required fields; omit usage and retain known historical cost in Huntaway.
- Keep attachment files and their host ownership. Preserve message text/path references first; add normalized
  attachment entries only where the existing attachment convention can be parsed reliably. Moving paths without
  moving files breaks both display and later access. Tool-result image bytes already removed cannot be restored.
- Permission rows can precede the assistant's call, and answers mutate existing message data. Pre-index the whole
  source thread. Preserve resolved cards as history; unresolved cards from ended runs need an explicit historical
  treatment, not a fabricated approval or a new live request. Huntaway questions can remain answerable after a run
  ends and resume it with a message; upstream requests are tied to a turn. Keep Huntaway's question workflow until
  that semantic difference is implemented, including merge-approval and plan-mode cards.
- A task can have multiple sessions/runtimes over its life. Convert its already stored Claude-shaped Codex rows
  directly; do not try to feed them to the native Codex notification translator. Determine the next run's harness
  from the effective config and session provenance. If these disagree or are unknown, flag continuation for review;
  never hand a Claude session id to Codex or vice versa.
- A process can cover several turns, and steering is not necessarily a new turn. Use `runs.turn_message_id`,
  checkpoints and result boundaries where available, but they do not guarantee a complete historical turn map.
  `turn_id` is optional on items: leave uncertain associations absent. Emit turn lifecycle events only for
  confidently reconstructed turns. Do not infer exact run/turn identity from timestamps alone.
- Checkpoints and rewind refer to old message ids and native session positions (`agent_at`/resume UUIDs or Codex
  turn ids). Keep them and their git refs, plus a source-to-item mapping for UI actions. Replacing them with new
  event sequence numbers would break rewind. A valid imported history does not prove rewind compatibility.
- Preserve unmatched results, missing parent calls, unsupported blocks and malformed rows in an import report and
  source archive. Show an explanatory notice or retain the legacy view for that task. An exited task must not show
  a forever-running tool because its result is absent; any inferred cancellation must be identified as such.
  Unknown data must never be silently discarded.

## A safe importer and cutover

These are proposed implementation steps, not APIs that exist in Huntaway today.

1. **Dry run on a consistent copy.** Inventory kinds, block types, orphan calls/parents, runtime/session provenance,
   active runs and open prompts. Include old rows, reviews, scratch/group tasks and large threads. Produce counts
   and warnings per task, without modifying the source. Take a restorable DB/attachment backup before real cutover.
2. **Convert into staging.** Record a converter version and source fingerprint (ids and data, not just a max id),
   deterministic non-tool item ids such as `legacy:<task>:<message>:<block>`, and the source-to-item mapping. Preserve
   tool ids unless collisions require consistent remapping of calls, results, parents and requests. Build final
   item events and result updates, then reduce those exact events into the cached snapshot. Saved events are the
   source of truth; a snapshot alone is not a complete import.
3. **Validate before publishing.** Deserialize events/items with the pinned upstream protocol, enforce contiguous
   seqs and unique ids, check parents/updates resolve, and compare replayed state with the snapshot. Account for
   every source row as converted, deliberately redundant, or retained with a warning. Compare visible text, calls,
   outcomes and subagent nesting against the existing renderer. Fail a task's import rather than publish a partial
   thread. Retrying the same source/version must not append duplicates.
4. **Switch one quiescent task atomically.** Serialize against send/start, steering, permission/question answers,
   rewind and other message writers; recheck source fingerprint and eligibility under that gate. Initially defer
   tasks with a non-exited run, queued/steering input, open prompts, review/merge activity or pending rewind. The
   final transaction publishes staged records and flips a proposed `run_engine`/history-version marker together.
   `running=false` alone is insufficient: a shim process can be alive between turns. Answered cards can have changed
   below the saved max message id, so a high-water mark alone cannot detect concurrent edits.
5. **Load and continue only after validation.** Import while the backend has no actor cached for that thread; load
   it after publication. Configure the same runtime, profile directory, cwd, tools and policy, with session id set
   before loading. Test a normal follow-up on each runtime without replaying history as new instructions. Keep
   existing processes on the legacy follower until they exit naturally. Use a separate agent-threads run directory:
   its format is 1 versus Huntaway's 2, and its pruning must never see legacy runs.
6. **Retain rollback.** Before any new-engine turn, reverting the marker can restore the legacy path because source
   rows remain intact. Once new events exist, merely flipping back loses those new turns: rollback then needs a
   reverse converter/legacy projection, or must keep the new history accessible and explicitly handle subsequent
   continuation. Do not promise unrestricted rollback without implementing that path.

Start with an explicit batch of inactive completed tasks, then opt-in idle continuable tasks. Lazy import on open
is possible, but should run as bounded background work with progress/fallback, not block the first snapshot request
on a huge transaction. Do not bulk-convert the whole board in a startup schema migration. Linked hosts import their
own authoritative data; older hosts still require protocol/version negotiation and the legacy reader.

## What is still needed

There is enough schema and store surface to build a history importer **without a new upstream import API**:
`Store.create_thread`, `append_events`, `save_snapshot`, and the public reducer suffice. Huntaway still needs the
converter, namespaced store, provenance/report tables, cutover locking, UI integration and behavioral tests above.
Import must have no launch, tool execution, permission resolution, checkpoint restore or historical billing side
effects. Keep historical cost totals authoritative in Huntaway instead of charging imported results again.

Since the original study, the inspected upstream revision has added per-thread stored `CreateOptions.launch`,
retained resolved requests in the reducer, and `snapshot_window`/`items_before` paging. These address parts of that
study's blockers; they do not supply a Huntaway importer. This assessment does not re-audit all adoption blockers.

The next useful implementation unit is a pure converter with fixtures and a read-only dry-run report against a
scrubbed board copy. Its acceptance tests should cover Claude and Codex-shaped history, multi-block messages,
interleaved/nested/background subagents, results before/after calls, answered and stale prompts, compaction,
attachments, runtime changes, empty/large/malformed threads, retries and a source edit during staging. Follow with
crash-before/after-cutover tests and native-session continuation/rewind checks on an isolated test server.

**Recommendation:** plan to import existing histories as part of staged adoption. Their size and missing live
stream events do not force us to discard them or keep the legacy renderer forever. Preserve source rows and defer
running or ambiguous tasks, then remove legacy support only after conversion coverage and continuation behavior
are demonstrated. Timing, disk growth and full-board coverage remain unmeasured.

## Source pointers

- Huntaway: [message storage](../server/src/db/messages.rs), [task fields](../server/src/db/tasks.rs),
  [run records](../server/src/db/runs.rs), [stored output filtering](../server/src/agent/runner/output.rs),
  [current normalization](../app/src/threadModel.ts), [subagents](../app/src/subagents.ts),
  [questions](../server/src/mcp/questions.rs), [permissions](../server/src/mcp/permissions.rs),
  [checkpoints](../server/src/git/checkpoints.rs), [attachments](../server/src/attachments.rs).
- agent-threads at `327a862`: `spec/schema/{thread,item,event,request,snapshot}.schema.json`,
  `rust/agent-threads/src/{store,reducer,agent_threads,shim}.rs`, `stores/sqlite.rs`,
  `claude/{mod,translate}.rs` and `codex/mod.rs` (paths under `rust/agent-threads/src` for the last three).
