# The thread API

How clients read a task's thread kept as items (see [threads.md](threads.md) for the model), follow it live, and
send it commands: on a host, and through a hub at `/api/h/<host_id>/...`, as every host route is. The shapes
(`Snapshot`, `ItemPage`, `ThreadEvent`, `Command`, `Resolution`) are those of `server-ts/src/threads/protocol.ts`.
The code is in `server-ts/src/threads/live.ts`, with the handlers in `server-ts/src/api/thread.ts`. It's the port of
HA-145's `docs/agent-threads-api.md`, changed for Huntaway's own model: there's no agent-threads backend, the
thread is read from the board's own tables, and commands go onto the board's own routes.

## Which hosts and tasks have one

- A host serves these routes from **API 114** (`api_version` in `/api/info`, and in the hub's `/api/hosts`). For an
  older host, keep using the message API (`/tasks/{id}/messages`, and the `message`, `message_updated`, `delta` and
  `delta_reset` events), which every host keeps serving.
- A task has a thread kept as items once one of its events has been saved (step 3 writes them for tasks flagged
  `thread_items`). Otherwise the routes answer **404** `{"error": "task <id> has no thread kept as items"}`, and its
  thread is its messages.
- A task's thread has the task's id, and it's reached only through its task: a command can't name another thread,
  and a request or item id is looked up in the task's own thread only. As for the message routes, the board's token
  reaches every profile's tasks on the host; another task's requests (another profile's included) aren't reached
  through this one.
- The thread's own state (`thread`: status, model, mode, session...) is its task's as it is now. Tasks still send the
  board's `task` events (status, `running`, `needs_attention`), so cards, columns and the inbox don't need thread events.

## Reading

| Route | Returns |
| --- | --- |
| `GET /api/tasks/{id}/thread` | The whole thread as a `Snapshot` `{thread, items, requests, seq}`, with the text streamed so far. |
| `GET /api/tasks/{id}/thread?limit=N` | A window: the last `N` items, with `start` and `context` (the whole thread if it has no more than `N`). |
| `GET /api/tasks/{id}/thread/items?before=I[&limit=N]` | An `ItemPage` of the items before index `I` (a window's `start`), 100 unless `limit` says. `start` 0: nothing before it. |
| `GET /api/tasks/{id}/thread/events?after=SEQ[&limit=N]` | `{events, more, seq}`: the saved events after `SEQ` (0 unless given; no deltas), at most `N` and 1,000. With `more`, ask again after `seq`. |

Put a page into a window with `with_page`. Events of types this host's build doesn't know (a newer build's, read
after a rollback) are left out of `events`, but not skipped silently: `seq` is how far the answer goes, those events
included (the last event's `seq` when there are `more`, and otherwise the last one read, which may be past every event
given). Set your state's `seq` to it once you've applied `events`, and start the next page after it. A window's `seq`
covers them too.

The log is short: a thread's events are kept for a day, and at least its last 1,000 whatever their age. When it no
longer goes back to `SEQ`, or `SEQ` is past the thread's last event (the client's state is from something else), the
answer is `{events: [], more: false, seq: <the thread's last>, resync: true}`: take a fresh window instead.

## Live events

Every thread's events, deltas included, are on `/api/ws` (and the hub's, with `host_id`):

```json
{"type": "thread_event", "task_id": "…", "event": {"type": "item.added", "thread_id": "…", "seq": 12, "item": {…}}}
```

- To show a thread, connect to `/api/ws` first, then load the window, and apply the events with `apply_event`
  (saved events at or below the window's `seq` are already in it, and so is the text of deltas it's past).
- A **delta** has the seq of the thread's last saved event and the `offset` its text goes at. A window taken while
  text streams has the text so far, which later deltas follow on from.
- **Catching up:** a saved event whose `seq` is more than one past the client's (`is_gap`) means it missed some. Fetch
  `/thread/events?after=<its seq>` rather than apply it, and apply what comes back, then carry on; with `resync`, take
  a fresh window.
- `{"type": "thread_resync", "task_id": "…"}`: the task's thread changed in a way its log doesn't say (its items were
  rebuilt from its messages, say). Take a fresh window of it.
- `{"type": "resync"}` (the socket couldn't keep up, or the hub's link to a host came back) can also mean missed
  events, of every thread: catch up each thread you show from its `seq`.
- Older clients ignore both new event types.

## Commands

`POST /api/tasks/{id}/thread/commands` with a `Command`. Its `thread_id` can be left out (it's the task's thread;
another one is a 400). Each goes through the board's own route for it, unchanged, which keeps its gates (queued
messages, dependencies, the merge queue, checkpoints) and the task in step. The answer is `{"ok": true, "result":
<what the route answered>}`, or the route's error as it is.

| Command | Route | Notes |
| --- | --- | --- |
| `send` `{text}` | `POST /tasks/{id}/messages` | Starts a turn, or steers the running one (or queues, as the composer's message does). `attachments` aren't taken: upload them with `POST /attachments` and link them in the text, as the composer does. `client_id` is ignored. |
| `interrupt` | `POST /tasks/{id}/stop` | Stops the agent, and a review, summary or workflow run of the task. |
| `respond` `{request_id, resolution}` | `POST /permissions/{id}`, or `POST /tasks/{id}/questions/{message_id}` | See below. |
| `set_options` `{model, effort, permission_mode}` | `PATCH /tasks/{id}` | Any of them. Modes in the model's names (`accept_edits`, `dont_ask`, `bypass`...). |
| `rewind` `{item_id \| turn_id, conversation, branch}` | `POST /tasks/{id}/rewind` | Back to before a `user_message` item (Huntaway's `item_id`), or the first of a turn's. The route takes the message the item came from. |
| `compact` | `POST /tasks/{id}/messages` `{"text": "/compact"}` | As the composer's `/compact`: a turn that's running finishes first. |
| `new_session` | (its own) | The next message starts a new conversation with the agent, keeping the items: the task's session is cleared, as a rewind of the conversation to its start does. 409 while the agent runs. |

`respond` answers one of the thread's requests:

- A **permission**: `{"outcome": "allow" | "deny", "always": true, "message": "…"}`. `always` allows matching calls
  from now on, as *Always allow* does; a denial's `message` is what the agent is told.
- A **plan**: `{"outcome": "allow", "permission_mode": "accept_edits"}` starts on it in that mode (the route's
  default if left out). `{"outcome": "deny", "message": "…"}` keeps planning, with the message as the user's feedback.
- A **question** asked with Claude's AskUserQuestion: `{"outcome": "answer", "answers": {"<question id>": ["<label or
  free text>", …]}}`, or `{"outcome": "cancel"}` (dismissed, as a denial).
- A **question** asked with the board's `request_user_input` (`legacy:<message id>`): `{"outcome": "answer",
  "answers": {"q": ["<label>", …, "<free text>"]}}`, sent to the agent as the user's message. Labels that aren't
  the question's options are its free-text answer (one at most). It's not cancelled: reply with a `send` instead.
- A request the board isn't waiting on (it has no pending prompt or question for it) is a 409, and one that has been
  answered already is the route's own 409.

Other errors: 404 for an unknown task, one without a thread, or a request or item it doesn't have; 400 for a
malformed command.

## From a script

`scripts/ia-api thread <task> [--limit N | --before I [--limit N] | --events [--after SEQ]] [--brief]` reads these
routes on a test server. `--brief` prints a line per item (with its index), request or event. Commands are
`ia-api post /tasks/<task>/thread/commands '<json>'`.
