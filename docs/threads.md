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
  saved events are numbered 1, 2, 3... with no gaps. A delta has the seq of the last saved event, and an `offset`.
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
| `thread_events` | The saved events (JSON), kept for a day, and at least the last 1,000 of each thread whatever their age. |
| `thread_item_origins` | Which message(s) each item came from: `(task_id, item_id, message_id)`. |

Every table is keyed by `task_id`, and its rows are deleted with the task (`ON DELETE CASCADE`).

- `append(c, task, events, {message_id})` numbers events after the thread's last, logs them, applies each to the items
  and requests in place, records the message as the origin of the items they touch, and prunes the thread's log. It's
  all or nothing, within the caller's transaction too.
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
  expired (cancelled) and can still be answered late. A pending one stays open.
- `finish()` ends a history nothing will add to (an import): calls with no result are cancelled, subagents that never
  ended are stopped, open requests are cancelled, and what waited for a call that never came is warned about.
- `CONVERTER_VERSION` (1) changes when what it makes of the same messages does: a fix means rebuilding the tasks.

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

## Status

| Step | Task | State |
| --- | --- | --- |
| 1. The model and its store, dormant | HA-212 | Done: `protocol.ts`, `store.ts`, migration 89. Nothing calls them, and nothing writes the tables. |
| 2. The translator, and a dry run on a copy of the board | HA-214 | Done: `translate.ts`, `huntaway threads-import` (`report.ts`), and the dry run above. Nothing calls the translator at serve time. |
| 3. Items written live, behind a setting | HA-216 | Not started |
| 4. Thread API and live events | HA-215 | This change: the routes, `thread_event` and `thread_resync` on `/api/ws` (`server-ts/src/threads/live.ts`), API 112, `ia-api thread`. See [threads-api.md](threads-api.md). Live events start once step 3 writes items. |
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

- Rebuilding a thread's items from its messages, keeping its seq going up, and sending `thread_resync` (step 3).
- Sending the thread's events from the write points, once committed, and its deltas, and forgetting streamed text
  (`live.forget_streamed`) when a run ends without saving it (step 3).
- Saving `thread.updated` when the task's state changes: until then, a thread's state is read from its task (step 3 or 5).
- A periodic `prune` of every thread's log: `append` prunes each thread as it writes (step 3).
- How much of the event log to keep, and a rebuild that doesn't log (steps 3 and 7: see the dry run's sizes above).
- Calling the translator from `add_message` and `update_message_data` (a permission or question's status), in the same
  transaction (step 3).
