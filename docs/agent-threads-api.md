# The API for agent-threads threads

How clients read a task's [agent-threads](https://github.com/dire-kiwi/agent-threads) thread, follow it live
and answer its requests: on a host, and through a hub at `/api/h/<host_id>/...` as every host route is. The
shapes (`Snapshot`, `ItemPage`, `ThreadEvent`, `Command`, `Resolution`) are agent-threads' protocol, unchanged:
see its `spec/PROTOCOL.md` ("Windows", "Applying events", "Reconnecting") and `spec/schema/`. The code is in
`server/src/threads/live.rs` (and the handlers in `server/src/api/thread.rs`).

## Which hosts and tasks have one

- A host serves these routes from **API 104** (`api_version` in `/api/info` and the hub's `/api/hosts`). For an
  older host, keep using the legacy message API (`/tasks/{id}/messages`, the `message`, `message_updated`,
  `delta` and `delta_reset` events), which every host keeps serving.
- A task has a thread once it runs on agent-threads (`tasks.run_engine` is `agent_threads`, set when its first
  run starts), or an import of its history was staged (`huntaway threads-import --stage`). Otherwise the routes
  answer **404** `{"error": "task <id> has no agent-threads thread"}`, and the task's messages are the legacy ones.
- A task's thread is the one whose id is the task's id (the engine makes them so), or else its latest. It's
  reached only through its task: a route or command can't name another thread. As for the message routes,
  the board's token gives access to every profile's tasks on the host.
- The thread is read from the running backend when it's the engine's own thread, or an import the task was
  switched over to. A staged import of a task that's still on the legacy runner is read from the database as
  it was saved, and takes no commands (409).

## Reading

| Route | Returns |
| --- | --- |
| `GET /api/tasks/{id}/thread` | The whole thread as a `Snapshot` `{thread, items, requests, seq}`, including text streamed so far. |
| `GET /api/tasks/{id}/thread?limit=N` | A window: the last `N` items, with `start` and `context` (the whole thread if it has no more than `N`). |
| `GET /api/tasks/{id}/thread/items?before=I[&limit=N]` | An `ItemPage` of the items before index `I` (a window's `start`), 100 unless `limit` says. `start` 0: nothing before it. |
| `GET /api/tasks/{id}/thread/events?after=SEQ[&limit=N]` | `{events, more}`: the saved events after `SEQ` (no deltas), at most `N` and 1000. With `more`, ask again after the last one's `seq`. |

Put a page into a window with the protocol's `withPage`. Events of types this host's build doesn't know are
left out of `events`. A client that applies events keeps its `seq` from the last event it applied, and a
window's `seq` covers them.

## Live events

Every agent-threads thread's events, deltas included, are on `/api/ws` (and the hub's, with `host_id`):

```json
{"type": "thread_event", "task_id": "…", "event": {"type": "item.added", "thread_id": "…", "seq": 12, "item": {…}}}
```

- To show a thread, connect to `/api/ws` first, then load the window, and apply the events with the protocol's
  `applyEvent` (events at or below the window's `seq` are already in it, and deltas the window's text is past
  are skipped).
- **Catching up:** a saved event whose `seq` is more than one past the client's means it missed some. Fetch
  `/thread/events?after=<its seq>` (or a fresh window) rather than applying it, as under "Reconnecting".
- `{"type": "thread_resync"}`: the host's forwarding fell behind and dropped some thread events, for any thread.
  `{"type": "resync"}` (the socket's own lag, or a linked host reconnecting) can also mean missed events. On
  either, catch up each thread you show from its `seq`.
- Older clients ignore both event types. Agent-threads tasks still send the board's `task` events (status,
  `running`, `needs_attention`) as legacy tasks do, so cards, columns and the inbox don't need thread events.

## Commands

`POST /api/tasks/{id}/thread/commands` with a protocol `Command`. Its `thread_id` can be left out (it's the
task's thread; another one is a 400). Answers `{"ok": true}`, or an error:

- `respond` answers an open request: `{"type": "respond", "request_id": "q1", "resolution": {…}}`.
  - A **question**: `{"outcome": "answer", "answers": {"<question id>": ["<label or free text>", …]}}`, or
    `{"outcome": "cancel"}`.
  - A **plan**: `{"outcome": "allow", "permission_mode": "accept_edits"}` starts on it in that mode (the
    thread's own mode if left out, or `default` if that's `plan`). `{"outcome": "deny", "message": "…"}`
    keeps planning, with the user's feedback.
  - A **permission**: `{"outcome": "allow" | "deny", "always": true, "message": "…"}`. `always` keeps the answer
    as a standing answer for matching calls for the rest of the thread. For now, tool permissions are handled by
    the board's own permission flow (`/api/permissions`, as for legacy tasks), so threads don't open
    `permission` requests yet.
  - Answering a request that isn't open does nothing.
- `compact`: compact the agent's context now, in a turn of its own (refused, 409, while a turn is running or
  before the thread has a session).
- `new_session`: the next turn starts a new conversation with the agent, keeping the items.

The others go through the board's routes, which keep its gates (queued messages, dependencies, the merge
queue, checkpoints) and the task in step, and answer 400 here:

| Command | Route |
| --- | --- |
| `send` | `POST /api/tasks/{id}/messages` `{"text"}` |
| `interrupt` | `POST /api/tasks/{id}/stop` |
| `set_options` | `PATCH /api/tasks/{id}` (`model`, `effort`, `permission_mode`) |
| `rewind` | `POST /api/tasks/{id}/rewind` |

Other errors: 404 for an unknown task or one without a thread, 409 for a staged import (or a command the
thread refuses now), 503 when the host isn't running its agent-threads backend.

## From a script

`scripts/ia-api thread <task> [--limit N | --before I [--limit N] | --events [--after SEQ]] [--brief]` reads
these routes on a test server. `--brief` prints a line per item (with its index), request or event.
