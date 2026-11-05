# Threads as items

A task's thread is kept as Claude Code's stream-json today: each saved line is a row in `messages`, and the app folds
the rows into what it draws (`app/src/threadModel.ts`). The agent-threads migration (HA-191's plan) keeps each thread
as normalized **items** as well, built from the same messages, and served as numbered **events**. This file describes
the model and how it's stored, and its status section says how far the migration has got. Each step updates it.

The ideas come from [agent-threads](https://github.com/dire-kiwi/agent-threads) (`~/personal/agent-threads`), whose
`spec/PROTOCOL.md` is the longer reference. Huntaway doesn't depend on it: it takes the names and shapes, trimmed to
what Huntaway uses, into its own code, noting the commit they came from (`main` at `5ad670a`). Ours is Huntaway's now.

## The model

`server-ts/src/threads/protocol.ts` is one plain TypeScript file that the server and the app share. The app imports it
by relative path (`app/src/threads.ts` re-exports it), so it has no imports and nothing that's only Node's, and it
passes both packages' typechecks. There's no code generation and no JSON Schema.

- **Thread**: a task has one thread, and its id is the task's. Its own state (`status`, `model`, `session_id`,
  `usage`...) is the task's, so it isn't stored with the items.
- **Items**, in the order they happened, each with an `id` and a `type`, and `parent_id` (the subagent call it belongs
  to), `turn_id`, `created_at` and `metadata` (the board's own facts about it, see "The thread view on items") where
  they apply:
  - `user_message`, `assistant_message`, `reasoning`;
  - `tool_call`, with a `kind` (`shell`, `read`, `edit`, `search`, `web`, `mcp`, `app`, `subagent`, `todo`, `other`),
    a `status`, its `result` once it has one, and normalized fields (`command`, `path`, `changes`, `todos`...). A
    subagent is a `tool_call` of kind `subagent`, and what it does has its id as `parent_id`;
  - `compaction`, `notice` (`level`, `text`, `code`) and `turn_result` (how a turn ended, the last item of each turn).
- **Requests**: what the agent waits on the user for, open until resolved, and kept with their `resolution` after:
  `permission`, `question`, and `plan` (ExitPlanMode, which Huntaway asks about as a permission prompt). Each has the
  board's record of it as its `metadata`: the prompt or question as the board stores it, and its message's id.
- **Events**, each with the thread's id and a `seq`: `thread.updated`, `turn.started`, `turn.completed`, `item.added`
  (or replaced in place, for an id the thread has), `item.updated` (a patch), `items.removed` (a rewind),
  `request.opened`, `request.resolved`, and `delta` (streamed text). Every event but `delta` is saved, and a thread's
  saved events are numbered 1, 2, 3... with no gaps (but for one a rebuild leaves, so clients from before it take a
  fresh window). A delta has the seq of the last saved event, and an `offset`.
- **Commands** from the UI: `send`, `interrupt`, `respond`, `set_options`, `rewind`, `new_session`, `compact`.
- **Snapshots**, `{thread, items, requests, seq}`: what applying the thread's saved events in order to the empty state
  gives. `apply_event` is that fold, a pure reducer: an event changes only what it's about, keeping the identity of the
  rest, and replayed or other threads' events change nothing.
- **Windows**: a snapshot of the last `limit` items (`snapshot_window`), from index `start`, with the items from before
  it that they need (the subagent calls they belong to, open requests' calls, every subagent's call) as `context`.
  `item_page` reads the items before a window a page at a time, and `with_page` puts a page in.

What it leaves out of agent-threads' protocol: the thread's run, standing answers, rate limits, `resume_at` and
`turn_at` (Huntaway has its own runs, approvals, usage limits and rewinds), questions kept open after their turn, and
`raw` payloads (messages stay the source, and origins say which an item came from). It adds `auto` to the permission
modes. Names are the server's snake_case: `apply_event`, `snapshot_window`, `item_page`.

## The storage

`server-ts/src/threads/store.ts`, on tables of the board's own database (migration 89), on the same connection, so a
message and its items can be written in one transaction:

| Table | What |
| --- | --- |
| `thread_items` | Each item as it is now (JSON), updated in place. `pos` orders them; an item's index is the number of items before it, so removing items leaves gaps that windows don't see. `live` marks a subagent call whose subagent is still running. `meta` is what the board knows that the item doesn't say (who sent a message). |
| `thread_requests` | Requests, open or resolved (JSON), in order. |
| `thread_events` | The saved events (JSON), kept for a day. |
| `thread_item_origins` | Which message(s) each item came from: `(task_id, item_id, message_id)`. |
| `threads` | Each thread's own row (migration 95): its last `seq` (kept when its events have been pruned), the `converter` version that wrote it, a `writes` count, and the `error` that stopped its live writes, if one did. |

Every table is keyed by `task_id`, and its rows are deleted with the task (`ON DELETE CASCADE`). `tasks.thread_items`
says which tasks have a thread kept as items.

- `append(c, task, events, {message_id})` numbers events after the thread's last, logs them, applies each to the items
  and requests in place, records the message as the origin of the items they touch, and prunes the thread's log. It's
  all or nothing, within the caller's transaction too. With `log: false` (a rebuild) it applies them without logging.
- The log is kept by age only (a day, `KEEP_MS`), and `threads.seq` keeps the numbering going when it's empty. A
  client further behind than the log takes a fresh window. Step 2's dry run found that a count kept for good (the
  last 1,000 of each thread) kept nearly every thread's whole log: 761 MB of events beside 755 MB of items. Each
  `append` prunes its own thread, and the runs pruner (hourly) prunes the quiet ones.
- `clear` empties a thread for a rebuild, and moves its seq on by one, so a client from before the rebuild, even one
  that had every event, sees a gap and takes a fresh window.
- A snapshot is a read of the items and requests, with the seq of the last event. No snapshot is stored.
- `window` and `page` read a window or a page from the tables, without reading the whole thread, and give the same as
  `snapshot_window` and `item_page` of the whole snapshot.
- `events_after(c, task, seq)` gives the events after a seq, or null when the log no longer goes back that far: the
  client takes a fresh snapshot.
- Deltas aren't saved, and the store doesn't apply them. `thread.updated` goes in the log only.

## The translator

`server-ts/src/threads/translate.ts` makes items from the messages the board stores: the slimmed lines
`agent/runner/output.ts` writes, the board's own `user`, `event`, `permission` and `question` rows, and Codex's runs as
`agent/codex/output.ts` shapes them like Claude's. It's the port of HA-128's `import.rs` (converter version 6 there),
made a fold, so the live path (step 3) and batch rebuilds (step 7) can share it:

- A `Translator` takes a task's messages one at a time, in id order, and gives for each a `Step`: the events to append
  (with the message as their origin), its **disposition** (`converted`; `redundant`, when other items say what it does,
  like a Bash command's `task_*` messages or a subagent's prompt; or `retained`, kept only in the source, with a
  warning saying why), the ids it touched, its warnings, and the **metas** of the items it made or changed (what the board
  knows that the item doesn't say: that it sent a message itself, a turn's result text, a subagent's task id, the
  session a call was made in...), which go in `thread_items.meta`.
- It's pure: it reads and writes nothing. `Translator.from(items, requests, meta)` rebuilds its state (the calls and
  subagents, open requests, the latest compaction, what the turn has said) from what the store holds, so a restarted
  server goes on from there.
- Ids are stable: tool calls keep Claude's (or Codex's) ids, other items are `legacy:<message id>` or
  `legacy:<message id>:<block>` (a second call with an id an earlier one had too is `legacy:<message>:<block>`, its id in
  its meta), and requests keep the board's request ids. Turns aren't made up: items have no `turn_id`.
- It doesn't look ahead, as HA-128's did. A result stored before its call waits for it, a prompt names its call by the
  id the call's item will have (or, for an id the thread has already, is linked when a call with its id and input comes),
  and an item names its parent by its tool_use id, which is the parent call's item's. What waits is held in memory only:
  rebuilt in between, it's as if its call never came. On the live board's copy that changed nothing (below).
- A permission or question message fed again after its status changed (the board updates them in place) resolves the
  request it opened with what its status says now, even if it was resolved before: a question or plan whose run ended is
  expired (cancelled) and can still be answered late. A pending one stays open, and one that's pending again (answerable
  again after its answer couldn't be sent) is opened again, with no resolution.
- `finish()` ends a history nothing will add to (an import): calls with no result are cancelled, subagents that never
  ended are stopped, open requests are cancelled, and what waited for a call that never came is warned about.
- `CONVERTER_VERSION` (4) changes when what it makes of the same messages does: a fix means rebuilding the tasks
  (`huntaway threads-rebuild`, below), and `threads.converter` says which version wrote each.

Where agent-threads' recorded sessions showed it, it follows agent-threads rather than HA-128: `mcp__app__*` calls are
`app` calls; AskUserQuestion's questions are told apart by their text, with `allow_other`; a `/compact` turn ends with a
`turn_result`; a call a stop cut short is `cancelled`, and its turn has no made-up error; a plan sent back denies its
call; a forked Skill's call takes its title from `task_started`; and an approved plan's resolution has its mode.

What the board keeps and agent-threads doesn't: Claude Code's "[Request interrupted…]" messages and its API errors are
notices (with a `code`), which the readers take as the agent's. What `messages` doesn't keep, so items don't have: a
turn's usage and session, an edit's diff, hooks' and API retries' notices, and a user message's `client_id` and `queued`.

The tests (`threads/translate.test.ts`, `fixtures.test.ts`, `codex.test.ts`, `report.test.ts`): HA-128's, each also
checked against protocol.ts's reducer and against rebuilding the translator after every message; agent-threads' 22
Claude fixtures (`threads/fixtures/claude`, from `main` at `5ad670a`), whose raw lines go through `output.ts`'s
`handle_line` with the board's own rows written as it writes them, and must give the expected items but for the
differences above; and the Codex tests' cases, through `codex/output.ts`.

### `huntaway threads-import`

`huntaway threads-import --db <file or data dir> [--json] [--task <id or key>]... [--write <new file>]` translates every
task of a board's database (read-only, at this build's version: run it on a test server's copy from
`scripts/copy-live-board.sh`) and reports each task and the totals: messages by disposition, items by type, requests,
events, their sizes, the warnings, the time, and what keeps a task from switching over now (running, an active run,
queued input, merging, an open prompt). `--write` also writes every thread into a new database file of its own, one
message at a time through `store.ts` as the live path will, to measure the tables on disk.

On a scrubbed copy of the live board (2026-11-05, schema 89):

- **All 1,743 tasks translate, none fail** (HA-128's Rust run: 1,373 tasks, 0 failures, on 2026-11-03). 296,804
  messages (735 MB of JSON): 274,016 converted, 22,782 redundant, 6 retained, the same 6 as the Rust run's (4
  `task_*` messages for background tasks that never started, 2 `local_workflow` tasks). Warnings: 42 calls with no
  result in 13 tasks (32 in 9 then), one subagent that never said it ended, 18 open prompts (14). 19 tasks couldn't be
  switched over now (18 open prompts, 1 queued message).
- Items: 105,688 tool calls, 26,770 assistant messages, 10,771 reasoning, 7,774 notices, 4,746 turn results, 4,611
  user messages and 269 compactions; 144 requests; 274,249 events.
- Rebuilding the translator from its stored state at 139,777 points along the way (after every message of threads of up
  to 300, at 25 points in longer ones) gives the same items, requests and metas for every task, and what `--write` put
  in the store is what translating at once gives, for every task. Two runs give the same report.
- **Time**: translating takes 0.5 s for the whole board (1.7 µs a message; the longest thread, 4,586 messages, 17 ms),
  and reading and parsing the messages 3.5 s more. Writing it all through `store.ts` took 16.5 s more, one transaction a
  task.
- **Size**: `messages` takes 880 MB on disk (with its indexes). The thread tables took 1,566 MB: `thread_items` 755 MB,
  `thread_events` 761 MB, `thread_item_origins` 49 MB, `thread_requests` 0.2 MB. The items alone are 0.85 times the
  messages' JSON (tool results are most of both), and the events 0.89 times again, since each item.added carries its
  item whole.

What that means for the plan's disk risk: items beside messages roughly double the thread's space until step 14, as
the plan expected, but the event log as step 1 keeps it (a day, and at least the last 1,000 of each thread) doubles it
again: only 15 threads have more than 1,000 events, so the count rule keeps nearly all of them, for good (618 of the 651
MB). Before step 3 writes items live and step 7 rebuilds every task, the log should keep less: a rebuild needn't log
its events at all (a client catching up from before it takes a snapshot), and the live log could keep a count closer
to what a reconnecting client misses (a few hundred) or go by age only. With no log, items beside messages come to
about 1.9 times today's `messages` (1.7 GB on this board).

## The API

[threads-api.md](threads-api.md) has the routes (a snapshot or window, pages of earlier items, the events after a
seq, and commands), and the live events. What writes a thread's items sends its events to clients with
`threads/live.ts`'s `send_events` once they're committed, streamed text with `send_delta` (which keeps the text so far
in memory, so a window taken mid-message has it), and `send_resync` when it changes a thread in a way its log doesn't
say (a rebuild).

## Writing items live

`server-ts/src/threads/write.ts`, step 3 (plan decisions D3 and D4).

- **The switch:** the host setting *Keep threads as items* (`thread_items` in `/api/settings`, API 116; Settings, a
  host's Agent defaults), off by default until step 7 turned it on (stored as `"false"` when it's off, so unset is
  on, and an older build's `"true"` stays on). A task whose first message is written while it's on is flagged
  (`tasks.thread_items`), in the same transaction, and keeps its items written from then on, so a flagged task's
  items have no gaps. Turning it off flags no more tasks, and those already flagged carry on. With it off, and for
  unflagged tasks, nothing new is written (the only extra work is reading the flag, from the `UPDATE tasks` that
  insert_message already made).
- **The write points:** every message write goes through db/messages.ts's `insert_message`, `update_message_data`
  and `update_pending_message` (the `status='pending'`-guarded update that mcp/questions.ts and review/merge_gate.ts
  used raw SQL for). Each calls `write.written` inside its own transaction (a savepoint within the caller's), which
  for a flagged task translates the message and appends its events, so the message and its items are committed
  together or not at all: `AppState.add_message` and `add_event`, start_run's prompt, start message and compact
  event (in start_run's own transaction), steered messages, and the permission, question and merge-gate updates.
  Messages stay the source.
- **Events:** the events are kept with the returned message object (`write.events_of`), and AppState's
  `emit_message` and `emit_message_updated` send them with step 4's `live.send_events` (`thread_event`, see
  [threads-api.md](threads-api.md)) after the message's own event, once committed (start_run sends its messages after
  its commit, as before). A write rolled back sends nothing. They go out in the order they were written: a question's
  answer sends its events before the reply it starts is written (mcp/questions.ts).
- **Deltas:** streamed text (the board's `delta` events, which still go out) is also sent as a `delta` thread event,
  for flagged tasks. Huntaway streams into a message before it's saved, so the delta names a preview item the thread
  doesn't have, `stream:<server>:<n>`: a new one for each text block (Claude's `content_block_start`, or a `delta_reset`),
  ended when the agent's message is saved. See protocol.ts's `DeltaEvent`.
- **The translator in memory:** each server keeps the Translator of the threads it last wrote (64 of them), with the
  `threads.writes` count it's in step with. A count that doesn't match (a write rolled back, a rebuild by another
  process, a server that restarted) gets one rebuilt from the store (`Translator.from`), which loses only what was
  waiting for its call (see the translator above).
- **Failures:** if translating or storing a message throws, the message is still written (the items' part is rolled
  back to its savepoint), the error is logged and kept in `threads.error`, and the thread gets no more live writes
  (and `store.has_thread` is false, so the thread API leaves it alone) until it's rebuilt.
- **A request reopening:** a question whose answer couldn't be sent goes back to `pending` (mcp/questions.ts's
  "answerable again"), and the translator opens its request again with no resolution (`request.opened`), as a
  rebuild from the message has it. Merge-gate cards settled as `replaced` are a cancel with a message (converter 2).

### `huntaway threads-rebuild`

`huntaway threads-rebuild [--db <file or data dir>] (<task id or key>... | --all | --batch) [--check] [--json]` derives
threads from their messages again, one transaction a task, so a translator fix only needs a rebuild. `--all` is every
flagged task; a task named is flagged too, and gets its whole history; `--batch` is step 7's batch (below). A rebuild logs no events: the thread's seq moves on
by one, so clients take a fresh window. `--check` writes nothing and prints how each thread differs from a rebuild
(it rebuilds in a savepoint and rolls it back). It runs on the board's database while the server runs (the data
dir's by default, at this build's version), and the server's translators notice through `threads.writes`.

What was checked (HA-239): every Claude fixture and Codex case of step 2, written live through the real write points
with the setting on, gives a rebuild's items, requests, metas and origins; so do unit tests of every message kind and
update, a question reopened, start_run's writes, a rollback, a throw and a process exit between a message and its
items (neither is left), a translator failure and a rebuild from another connection. On a test server with
`--fake-claude`: a task started with `ia-api start` (its auto start message is its first message and flagged it),
sent a message while idle, steered mid-turn, run with a subagent and streamed text, compacted by hand and by the idle
auto-compact: `threads-rebuild --all --check` finds no differences, and a task started before the setting was turned on
has nothing written. Six flagged tasks streaming at once kept the event loop's p99 at 10.3–10.6 ms and its max under
24 ms (the same as with the setting off), with no stalls, and each task's saved events came gapless over `/api/ws`.
With haiku on Claude (a `request_user_input` question, a prompt allowed and one denied) and on a Codex config (an
approval), the threads were a rebuild's too.

## The thread view on items

Step 5 (HA-218): the app draws a task's thread from its items when the task's thread is kept as items (the task's
`thread_items`, API 119), its host serves the view (API 119) and the host's setting is on. Every other task, and
every task on an older host, is drawn from its messages as before (`app/src/threadModel.ts`), and so is a flagged task
once the setting is turned off (its messages are still written). A host that answers 404 for a flagged task's thread
(its live writes stopped on an error) has it drawn from its messages too, until a `thread_resync` says it was rebuilt.
`app/src/threadView.ts` decides which. It's one view either way (`components/task/Thread.tsx`), so a thread that
switches (its first message flags it, the setting changes) keeps its rows' state and the composer its text and focus,
and shows the messages it has until its window has loaded.

- **Following it** (`app/src/itemThreads.ts`): a window of the thread's last 300 items, then its `thread_event`s,
  folded with protocol.ts's `apply_event`. Events that come while the window or a catch-up loads are held and applied
  after it. A gap (`is_gap`) fetches `/thread/events` after the thread's seq; a `resync` answer there, or a
  `thread_resync`, takes a fresh window; a reconnect (or the hub's `resync`) catches every shown thread up from its seq.
  Scrolled up, the 200 items before the window's start come in with `with_page`, keeping what events have changed in
  the window since. Streamed text comes from the thread's `delta` events (the board's own `delta` and `delta_reset`
  events aren't drawn for it), into the same preview as before, until an item is added to the main conversation.
- **Drawing it** (`app/src/itemModel.ts`): an adapter maps the items and requests onto the `ThreadModel` that
  threadModel.ts builds from messages, which `components/task/Thread.tsx` and `thread/*` draw unchanged: rows (a run of
  tool calls is one group), each subagent's own rows, the subagents, the calls' results. Requests go in among the items
  in the order their messages were stored. Keys are the message path's (`legacy:12:3` is `12.3`), so rewinding to a
  message and a prompt's "moved on" work as they did. A window's context has every subagent's call from before it, so
  the Agents list has them all, as the messages path's first page does with what lists the earlier subagents; its
  context items aren't drawn until their page loads, as a subagent from before the loaded messages isn't. What a new
  snapshot leaves as it was stays the same objects, so rows that didn't change don't redraw.
- **What it sends**: the composer's messages, its stop and its mode go as thread commands (`send`, `interrupt`,
  `set_options`), and the prompt cards answer with `respond` (a permission, a plan with the mode to carry on in, Claude's
  questions by their ids, the board's own questions). Going back to the inherited mode, unqueuing and rewinding use the
  board's routes, as do the board's lists of prompts outside the thread.
- **What the items needed** (converter 4): what the board draws that the protocol doesn't say is the items' and
  requests' `metadata`: a user message the board sent itself (`auto`), a turn's `subtype`, `num_turns` and
  `total_cost_usd`, a compaction's `post_tokens`, a result's text no message said (`from_result`, which isn't drawn),
  a subagent's description and prompt as its `task_started` says them, and a request's stored prompt or question (its
  status, note, rule, expiry, kind, a plan's mode and feedback, answers...) with its `message_id`. A request whose
  stored message changes is replaced in place (`request.opened`, keeping its resolution) before any `request.resolved`.
  Subagents have their `ended_at`, and a routine's report is a notice (`code: "routine_report"`, the report as its
  metadata), no longer kept only in messages. Threads written by an older converter draw without these (no auto style, no
  cost on a turn's end): `huntaway threads-rebuild` brings them up to date.

What it doesn't do the same: a foreground subagent's notification summary isn't kept (its report is its call's
result, which the message path shows too once it has come); a thread whose live writes failed is drawn from its
messages. What was checked: `app/tests/itemModel.test.mjs` translates a thread with a bit of everything (and every
prefix of it) through the server's translator and compares what's drawn with the message path's; `app/tests/
itemThreads.test.mjs` covers holding, gaps, resyncs, pages, streamed text and a 404; `app/tests/ui/itemThread.test.mjs`
shoots the same task drawn both ways (the setting off, then on) and compares the pictures, rows opened too, and pages a
long thread back. On a test server with haiku: a question, a prompt allowed and one denied, a plan approved into a mode,
the board's own question, a subagent, steering, stopping and the mode, all from the browser, each thread pixel for
pixel the same drawn from messages; followed live through a run it's the same as loaded fresh; the narrow layout.
`scripts/ui-profile.mjs` (which sends a flagged task's thread events too) on a copy of the live board's 1,639-message
thread (655 items), messages then items, two runs each, script ms: opening the task 31–32 → 42 (a 300-item window
against a 100-message page), 300 streamed tokens 55–74 → 32–40, a 1,000-token reply 101–133 → 69–84, 50 new messages
56–58 → 49–56, the rest the same.

## The readers

`server-ts/src/threads/history.ts`, step 6 (plan decision D5). Everything the board reads of a thread (review, summaries,
titles, the wait tool, pr_watch, `last_message`, prompts and approvals, checkpoints, analytics) goes through one
reader each, which reads the task's items when its readers should (`history.source`), and the SQL it always ran on the
messages otherwise. They read items when the task is flagged, its live writes haven't stopped on an error, and this
build's translator wrote them (`threads.converter` is `CONVERTER_VERSION`): converter 3 added the user messages' metas
the readers need (`start`, `routine`, `review_round`), and converter 4 the board's `metadata` (step 5), so a thread
written by an older build reads messages until
`huntaway threads-rebuild` brings it up to date. Step 10 drops that fallback, once messages aren't written.

| Reader | Callers | On items |
| --- | --- | --- |
| `last_assistant_text` | the API's and MCP tools' `last_message`, review and workflows (work done elsewhere), summaries | The latest of: an assistant message's text blocks (joined), a turn_result's `result_text`, an error notice with a `code` (Claude's API errors) |
| `said_since_asked` | summaries, workflow steps, routines' reports | The same, after the latest user_message |
| `user_replies` | review, workflows' verdicts, titles | user_messages that aren't `auto` or `from_agent` (`user_text` if it has one), with the agent's text before each |
| `tool_calls_since` | review (`changes_code`) | tool_call items, as Claude's blocks: the name as the harness gave it (`mcp__<server>__<tool>`), the result an error unless the call completed |
| `user_wrote_since`, `user_messaged_since` | pr_watch, the context meter's compactions | user_messages by `created_at` and meta |
| `subagent_call`, `has_call` | the wait tool's `subagent_finished`, Codex's subagent calls | tool_calls by call id, `subagent_task` and name |
| `tool_use` | approval rules' blocked-call log | the latest tool_call with the id |
| `moved_on`, `open_questions` | answering a question or a late prompt; settling questions on a reply, and the merge gate's cards | user_messages from later messages (`thread_item_origins`); open question requests from `question` messages |
| `first_user_message`, `user_message` | checkpoints and rewinds; `routine_call` | user_message items and their metas |
| `approval` | `pending_approvals` | the thread's permission request, and its `permission_requests` row |
| `user_messages_between` | prompt analytics | user_message items |
| `submissions` | review stats' backfill (migration 79's, which reads messages: the thread tables come later) | submit_review tool calls, but those the board refused |

And `attachments.of_task` and `referenced` (the pruner's) scan `thread_items` and `thread_requests` as well as
`messages`, so a file only an items thread links isn't pruned once step 10 stops writing messages.

Where the two differ: the messages readers of what the agent said read the latest 50 of its messages, and `tool_use` the
latest 5 that mention the call, and come back empty past those; the items readers read back as far as it takes. And a
whitespace-only text block isn't an item. `has_call` from messages only looks at each message's first block (where the
board writes a Codex subagent's call).

What still reads `messages` on purpose (`grep -rn -E "FROM messages|JOIN messages|UPDATE messages" server-ts/src`,
without the tests):

- The writer: db/messages.ts's inserts and updates, and threads/write.ts and report.ts, which translate messages.
  The migrations in db/schema.ts.
- The legacy readers themselves (db/messages.ts, db/tasks.ts's `user_wrote_since`, the messages side of history.ts).
- The message routes the UI on messages reads (api/thread.ts: `list_messages`, `message_page`, `subagent_messages`),
  for threads that aren't kept as items, until step 13.
- Read-modify-write of the message they update, the source the items are made from, which the D3 hook carries into
  the items: mcp/questions.ts's `ask` (has the call asked already: a question request doesn't keep the MCP call's
  id), `answer` and `emit`, mcp/permissions.ts's `update_message` (and `set_message_status`), routines' `mark_read`,
  and threads/live.ts's question check (it answers through mcp/questions.ts). `open_questions` finds the questions
  from items and reads the messages it updates. Step 10, which makes ids point at requests, moves these.
- Routines' `report` messages (`unread_reports`). Since converter 4 they're notices too (`routine_report`), for the
  view, which the readers of what the agent said leave out, as the messages readers do.
- Telegram's (integrations/telegram.ts, HA-207, which landed with this step): the agent's latest result and messages
  before an id, and the count of pending questions. They're to move onto history.ts before step 10.

### `huntaway threads-readers`

`huntaway threads-readers --db <file or data dir> [--json] [--task <id or key>]... [--examples <n>]` runs each reader
both ways on every task of a board's database: a task whose readers read items as it is, and any other on its
translation (a rebuild, in a transaction that's rolled back, so nothing is written). It asks each what the board asks
(per task: `last_message`, what was said since it was asked, the user's replies with several limits, the open questions,
the tool calls and `changes_code` since the start and the middle, who wrote since each user message, `moved_on` for
each question and prompt, the first user message and each checkpoint's and run's message, `subagent_call` for each
`task_*` message, `tool_use` for the latest 50 calls and `has_call` for subagents'; then the board's pending
approvals, each profile's prompt analytics, review stats' submissions and `attachments.referenced`), with the messages
readers' windows lifted, and lists each difference (and counts the answers those windows change). It exits 1 on a
difference.

On a scrubbed copy of the live board (2026-11-06, schema 95, 1,858 tasks, none flagged yet): **no differences** in 145,000 checks: every task was translated for it, and each reader agrees (`user_replies` 7,432 checks, `tool_use` 55,566, `subagent_call` 22,369, `user_wrote_since` 11,358, `tool_calls_since` 3,716, `last_message`, `said_since_asked` and `open_questions` 1,858 each...), and `attachments.referenced` is the same set from messages as from items. The messages readers' windows changed 12 answers (the items readers found what the windows cut off: `tool_use`'s 5 messages, mostly). It took 194 s, most of it translating. The copy has no pending prompts (copy-live-board.sh scrubs them), so pending approvals were compared on unit tests only.

## Every task gets items

`server-ts/src/threads/batch.ts`, step 7 (the plan's `backfill` question, answered with its recommendation): the
tasks from before the setting get their items from a rebuild of their messages (`write.ts`'s `rebuild`), and the
setting is on by default (API 121). It's still additive: messages are the source, and dropping the `thread_*` rows
(and `tasks.thread_items`) undoes it.

- **The batch** covers every task that isn't done whose readers don't read items yet (`batch.pending`: not flagged,
  written by an older converter, or stopped on an error), oldest first. Not one with no messages yet: its first
  message flags it, as for a new task, so neither the batch nor opening it builds it an empty thread. It's started from Settings → Server ("N tasks
  that aren't done don't keep their thread as items yet", *Rebuild them*, with its progress and a *Stop*), which is
  `POST /admin/threads/batch` (`{"stop": true}` stops it) and `GET /admin/threads` (`{pending, batch}`), or from the
  command line: `huntaway threads-rebuild --batch`, which prints `[n/N] <task>: …` as it goes.
- **One task per transaction, under the task's write lock:** in the server, a rebuild is one synchronous transaction
  on the board's connection, so none of the task's messages can be written in the middle of it, and the task's next
  message is written onto the rebuilt thread (the rebuild leaves its translator in memory, with its `writes`). A task
  that's running, streaming even, carries on; its clients get the task (now with `thread_items`) and a `thread_resync`,
  and take a fresh window. The server yields to the event loop between tasks. From the command line, each
  transaction takes the database's write lock as it starts (`BEGIN IMMEDIATE`), and the server's translators notice
  through `threads.writes`; its clients switch over at the task's next event rather than at once.
- **Resumable:** each task's rebuild is committed, and a rebuilt task isn't pending any more, so a batch stopped (or a
  command line interrupted) goes on with the rest when it's started again. A server that stops mid-batch goes on with
  it when it starts (the `thread_batch` setting is set while it runs); a stopped one waits to be started again. Running
  it again with nothing pending changes nothing.
- **Done tasks** aren't in the batch, which keeps the database from growing by the size of the whole board: a done
  task gets its items when it's first opened (`batch.opened`, from `GET /tasks/{id}`, the messages' latest page and
  `GET /tasks/{id}/thread`, which tell clients as the batch does) or when a reader reads it (`history.source`, through
  `write.ensure`). That's with the setting on; with it off, they're read and drawn from their messages as before.
  `ensure` also brings a thread written by an older converter up to date, but leaves one whose live writes stopped on
  an error to the batch and `threads-rebuild`. A rebuild that fails is logged, changes nothing, and isn't tried again on
  every read (until the server restarts).

What was checked: unit tests (`threads/batch.test.ts`) of what the batch covers, running it twice, stopping and going
on (and after a restart), a task writing its messages, streamed text included, while the batch runs (before its own
rebuild and after), a done task opened each way and read, the setting off, an older converter's thread, a failed
rebuild, and the command line's batch beside a server's connection. On a scrubbed copy of the live board (2026-11-06,
schema 96, 1,902 tasks, 1,282 of them not done, none flagged), from Settings → Server's API:

- **Time:** the batch rebuilt the 1,282 tasks (131,789 messages) in 4.9 s, none failed. The longest transaction, and
  so the longest the event loop waits, is the biggest thread's: 82 ms for the batch's (2,082 messages); a done task's
  rebuild on open took 212 ms for the board's biggest (4,586 messages), 61–123 ms for the next five.
- **Size:** the database file went from 972 MB to 1,428 MB (+456 MB: `thread_items` 425 MB with its index, origins 23
  MB, requests 0.1 MB, no events, since a rebuild logs none), for `messages`' 900 MB. The done tasks left out have
  the other 58% of the messages (183,369).
- **Drawn the same:** eight tasks (from 1 to 1,639 messages, with prompts, questions and subagents) shot drawn from
  messages before the batch and from items after it: the three whose whole thread fits were the same pixel for pixel;
  the five longer ones differed only in text anti-aliasing a fraction of a pixel apart (the view on messages loads the
  last 100 messages, the view on items 300 items, so what's above differs in height), and every row both views have
  was the same in the DOM.
- **Twice:** run again, nothing was pending and nothing changed (every thread's `writes` and `seq` as they were),
  `threads-rebuild --batch` found none, and `--all --check` found all 1,282 the same as a rebuild (8 s).
- **Stopped and gone on with:** stopped after 202 tasks from Settings → Server, *Go on* rebuilt the other 1,080.
- **A done task opened** in the browser (376 messages, unflagged) got its items (158) and was drawn from them.
- **While a task streams:** on a test server with `--fake-claude`, 300 tasks with the copy's threads (89,662 messages)
  and one streaming a reply between them: it was rebuilt mid-stream (opened by `ia-api wait-idle`, then skipped by the
  batch), its clients got the task flagged and a `thread_resync`, the rest of its text as thread deltas, and its saved
  items as events 2, 3 and 4 after the rebuild's seq. Its thread had every message's item, was the same as a rebuild,
  and was drawn the same from items as from messages; so were the other 300.

What doesn't carry over: a task rebuilt while it's streaming starts a new preview, so the view on items shows only
the text streamed after the rebuild until the message is saved (then it has all of it).

## Status

| Step | Task | State |
| --- | --- | --- |
| 1. The model and its store, dormant | HA-212 | Done: `protocol.ts`, `store.ts`, migration 89. Nothing calls them, and nothing writes the tables. |
| 2. The translator, and a dry run on a copy of the board | HA-214 | Done: `translate.ts`, `huntaway threads-import` (`report.ts`), and the dry run above. Nothing calls the translator at serve time. |
| 3. Items written live, behind a setting | HA-239 (was HA-216) | Done: `threads/write.ts`, the hook in `db/messages.ts`, the setting, migration 95, `huntaway threads-rebuild`, API 116. |
| 4. Thread API and live events | HA-215 | Done: the routes, `thread_event` and `thread_resync` on `/api/ws` (`server-ts/src/threads/live.ts`), API 114, `ia-api thread`. See [threads-api.md](threads-api.md). |
| 5. The UI on items | HA-218 | Done: `app/src/itemThreads.ts`, `itemModel.ts`, `threadView.ts`, converter 4, tasks' `thread_items` and API 119. |
| 6. Readers on items | HA-217 | Done: `threads/history.ts`, `huntaway threads-readers` (`threads/readers.ts`), the attachment scan on items, converter 3. |
| 7. Every task gets items, the setting on by default | HA-220 | This change: `threads/batch.ts`, `huntaway threads-rebuild --batch`, Settings → Server's rebuild, a done task's items on open, the setting on by default, API 121. Messages are still the source. |
| 8. Permission prompts and questions over stdio | HA-219 | Not started |
| 9. The board's tools in process | HA-221 | Not started |
| B. A new database file, dormant | HA-213 | Done: `huntaway-2.db` behind `IA_NEW_DB_FILE` (`server-ts/src/db/file.ts`) |
| 10. Items are the source | HA-222 | Not started |
| 11. Codex writes items directly | HA-223 | Not started |
| 12–14. Soak, remove the legacy code, delete old message rows | HA-224 to HA-226 | Not started |

Left for later steps:

- Live snapshots that include streamed text: step 3's deltas name a preview item the thread doesn't have yet (see
  "Writing items live"), and `live.send_delta` only takes items the thread has, so a window taken mid-message doesn't
  have the preview's text so far. The view shows the rest as it streams, as it did from messages.
- Saving `thread.updated` when the task's state changes: the view reads a thread's state from its task, whose `task`
  events it has anyway, so nothing needs it yet.
- Done tasks that are never opened have no items: step 10, which stops writing messages, needs every task that can
  still be read to have them first (a batch with done tasks in it, or the readers' fallback to messages kept for them).
