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
  to), `turn_id` and `created_at` where they apply:
  - `user_message`, `assistant_message`, `reasoning`;
  - `tool_call`, with a `kind` (`shell`, `read`, `edit`, `search`, `web`, `mcp`, `app`, `subagent`, `todo`, `other`),
    a `status`, its `result` once it has one, and normalized fields (`command`, `path`, `changes`, `todos`...). A
    subagent is a `tool_call` of kind `subagent`, and what it does has its id as `parent_id`;
  - `compaction`, `notice` (`level`, `text`, `code`) and `turn_result` (how a turn ended, the last item of each turn).
- **Requests**: what the agent waits on the user for, open until resolved, and kept with their `resolution` after:
  `permission`, `question`, and `plan` (ExitPlanMode, which Huntaway asks about as a permission prompt).
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
  it that they need (the subagent calls they belong to, open requests' calls, subagents still running) as `context`.
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
| `threads` | Each thread's own row (migration 93): its last `seq` (kept when its events have been pruned), the `converter` version that wrote it, a `writes` count, and the `error` that stopped its live writes, if one did. |

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
- `CONVERTER_VERSION` (2) changes when what it makes of the same messages does: a fix means rebuilding the tasks
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

## Writing items live

`server-ts/src/threads/write.ts`, step 3 (plan decisions D3 and D4).

- **The switch:** the host setting *Keep threads as items* (`thread_items` in `/api/settings`, API 113; Settings, a
  host's Agent defaults), off by default. A task whose first message is written while it's on is flagged
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
  `emit_message` and `emit_message_updated` send them as `{type: "thread_event", task_id, event}` after the
  message's own event, once committed (start_run sends its messages after its commit, as before). A write rolled
  back sends nothing.
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

`huntaway threads-rebuild [--db <file or data dir>] (<task id or key>... | --all) [--check] [--json]` derives threads
from their messages again, one transaction a task, so a translator fix only needs a rebuild. `--all` is every flagged
task; a task named is flagged too, and gets its whole history. A rebuild logs no events: the thread's seq moves on
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

## Status

| Step | Task | State |
| --- | --- | --- |
| 1. The model and its store, dormant | HA-212 | Done: `protocol.ts`, `store.ts`, migration 89. Nothing calls them, and nothing writes the tables. |
| 2. The translator, and a dry run on a copy of the board | HA-214 | This change: `translate.ts`, `huntaway threads-import` (`report.ts`), and the dry run above. Nothing calls the translator at serve time. |
| 3. Items written live, behind a setting | HA-239 (was HA-216) | This change: `threads/write.ts`, the hook in `db/messages.ts`, the setting, migration 93, `huntaway threads-rebuild`, API 113. |
| 4. Thread API and live events | HA-215 | Not started |
| 5. The UI on items | HA-218 | Not started |
| 6. Readers on items | HA-217 | Not started |
| 7. Every task gets items, the setting on by default | HA-220 | Not started |
| 8. Permission prompts and questions over stdio | HA-219 | Not started |
| 9. The board's tools in process | HA-221 | Not started |
| B. A new database file, dormant | HA-213 | Done: `huntaway-2.db` behind `IA_NEW_DB_FILE` (`server-ts/src/db/file.ts`) |
| 10. Items are the source | HA-222 | Not started |
| 11. Codex writes items directly | HA-223 | Not started |
| 12–14. Soak, remove the legacy code, delete old message rows | HA-224 to HA-226 | Not started |

Left for later steps:

- Live snapshots that include streamed text: the store doesn't apply deltas, so a client that connects mid-message gets
  the text so far only from the server's memory (step 4). Step 3's deltas name a preview item (above), which step 4's
  windows would have to carry.
- Sending the thread events through step 4's `live.send_events` (and `send_resync` after a rebuild by this server)
  once it lands: until then AppState sends them itself, in the same shape.
- Routines' `report` messages are kept only in messages (the translator retains them as `unknown_kind`): the UI on
  items needs an item for them (step 5).
- Saving `thread.updated` when the task's state changes: until then, a thread's state is read from its task (step 5).
- Rebuilding every task, and a rebuild from Settings (step 7).
