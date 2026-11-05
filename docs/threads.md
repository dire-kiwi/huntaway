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

## The API

[threads-api.md](threads-api.md) has the routes (a snapshot or window, pages of earlier items, the events after a
seq, and commands), and the live events. What writes a thread's items sends its events to clients with
`threads/live.ts`'s `send_events` once they're committed, streamed text with `send_delta` (which keeps the text so far
in memory, so a window taken mid-message has it), and `send_resync` when it changes a thread in a way its log doesn't
say (a rebuild).

## Status

| Step | Task | State |
| --- | --- | --- |
| 1. The model and its store, dormant | HA-212 | This change: `protocol.ts`, `store.ts`, migration 89. Nothing calls them, and nothing writes the tables. |
| 2. The translator, and a dry run on a copy of the board | HA-214 | Not started |
| 3. Items written live, behind a setting | HA-216 | Not started |
| 4. Thread API and live events | HA-215 | This change: the routes, `thread_event` and `thread_resync` on `/api/ws` (`server-ts/src/threads/live.ts`), API 110, `ia-api thread`. See [threads-api.md](threads-api.md). Live events start once step 3 writes items. |
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
