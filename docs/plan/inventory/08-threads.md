# 08 Threads: how an agent's conversation is stored, translated and served live

Sources read: `apps/server/src/threads/*` (protocol, store, write, messages, live, translate + translate/, history, source,
native, rebuild, batch, report header), `db/messages.ts`, `api/thread.ts`, `wire/messages.ts`, `wire/events.ts`,
`agent/runner/output.ts`, `agent/codex/driver.ts` + `output.ts`, `state.ts` (emitters), `attachments.ts`, migrations 89/95/98/101/102,
`packages/client/src/{thread,protocol,events}.ts`, `apps/web/src/{itemThreads,itemModel,threadModel,deltas,subagents,threads}.ts`,
`docs/threads.md`, `docs/threads-api.md`.

## 1. Purpose

Every task (and every review / summary / workflow-step / routine / assistant thread, which are tasks too) has exactly one
**thread**, whose id is the task's id. A thread is a list of normalized **items** (user messages, assistant text, reasoning,
tool calls with their results, compactions, notices, turn results) plus **requests** (permission prompts, questions, plans)
that stay with their resolution. Every change is a numbered **event**; clients load a window of the last N items and fold
live events with a shared pure reducer. The area also owns the board's "readers" of a thread (what review, summaries,
Telegram, the wait tool etc. read out of it), and a large amount of migration machinery from the older model where a thread
was rows of raw-ish Claude stream-json in a `messages` table.

Current state on the live board: **every task is on items** (`tasks.thread_source='items'`), no `messages` rows are written,
old rows are deleted. But all board-side writes are still phrased as a legacy "message" (`kind` + `data`) that a `Translator`
turns into item events; only Codex output is mapped to items directly.

## 2. Capabilities

### Model and reducer (`threads/protocol.ts`, shared verbatim with web and mobile through `packages/client/src/protocol.ts`)
- Declares Thread, Item kinds, Requests, Events, Commands, Snapshot, ItemPage (section 3).
- `initial_state(thread)`, `apply_event(state, event)`, `apply_events`: pure fold; ignores other threads' events and saved events with `seq <= state.seq`; unknown event types only advance `seq`; unchanged objects keep identity (rows don't redraw).
- `is_gap(state, event)`: saved event with `seq > state.seq + 1`.
- `patched(item, patch)`: shallow field replace, `null` deletes a field, `id`/`type` never change; returns same object if nothing changes.
- `apply_delta`: appends text at `offset` to an `assistant_message`/`reasoning` item the state has; skips overlap; ignores offsets past the end; ignores deltas whose `seq < state.seq`. (Huntaway's deltas name items the state doesn't have, so this is a no-op in practice.)
- `snapshot_window(state, limit)`, `item_page(state, before, limit)`, `with_page(state, page)`, `request_anchor`, `is_subagent`, `is_running_subagent`, `open_requests`.
- File must stay import-free, erasable-syntax-only TypeScript (three packages typecheck it).

### Store (`threads/store.ts`)
- `append(c, task_id, events, {message_id, at, log})`: in one transaction (savepoint in the caller's): number events after the thread's last seq, insert into `thread_events`, apply each to `thread_items` / `thread_requests` in place, record `message_id` as origin of touched items, bump `threads.seq`, prune that thread's events older than 24 h. `log:false` applies without logging (rebuild). Rejects `delta`.
- `last_seq` = max(`threads.seq`, max logged seq); `set_seq` never goes down.
- `has_thread`: a `threads` row with `error IS NULL`.
- `events_after(task, after, limit)`: `[]` if `after >= last`; `null` if the log no longer reaches back to `after+1` (client must resync).
- `prune(c)` all threads' events older than `KEEP_MS` (24 h); `clear(task)` empties items/requests/origins/events and bumps seq by 1.
- Reads: `get_item`, `get_request`, `items`, `requests`, `open_requests`, `snapshot`, `window(thread, limit)`, `page(task, before, limit)` (SQL versions of `snapshot_window`/`item_page`, must give identical results), `item_origins`, `items_from(message_id)`, `set_item_meta`, `item_meta`, `metas`.

### Writing (`threads/messages.ts`, `write.ts`, `source.ts`, `native.ts`)
- The only three write entry points: `insert_message(c, task, kind, data)`, `update_message_data(c, id, data, task?)`, `update_pending_message(c, id, data, task?)` (only if stored status is still `pending`; one statement, so of two concurrent answers one wins). Plus `get_message(c, id, task?)`.
- For an items task: allocate a message id (`source.next_id`), translate, append events, set metas, bump `threads.writes`; no `messages` row. If translating/storing throws: savepoint rolled back, logged, the message is kept as a `messages` row with that id so it isn't lost; thread keeps being written.
- In-place updates for items tasks: `source.kept` rebuilds the "message" from the request's `metadata` (or a `routine_report` notice's metadata), `source.update` feeds it to the translator again with new data.
- `write.events_of(message)`: the saved events produced by a write, attached to the returned message object (WeakMap) so the caller emits them after commit.
- `write.translator(c, task, writes)`: per-thread Translator cache (64, LRU), validated against `threads.writes`, rebuilt from the store on mismatch.
- `write.stream_text(s, task, text)` / `stream_reset`: unsaved streamed text as `delta` thread events for a preview id.
- `native.append(c, task, events, meta)`: write events made without a message (Codex driver); allocates a message id as origin, tells the task's Translator via `observe`.
- `source.flip`, `flip_all`, `settled`, `announce`, `busy`: move a task from messages to items when quiet (migration, see section 12).
- `write.rebuild` / `rebuild_rows` / `ensure` / `compare`: derive items from `messages` rows again (only for tasks still on messages).

### Translation (`threads/translate.ts`, `translate/{step,values,convert,tools,subagents}.ts`)
- `Translator.message(m) -> Step {events, disposition, ids, warnings, meta}`; `Translator.from(items, requests, meta)`; `observe(item, meta)`; `finish()`; `convert(messages)`; `fold(events)`; `tool_fields(name, input)`; `kind_of`; `title`; `result_text`; `question`; `answers_of`; `subagent_started/_task/_result/_end`; `permission_mode`. Details in section 3.

### Codex direct mapping (`agent/codex/driver.ts`, helpers in `agent/codex/output.ts`)
- `map(view, ctx, notification) -> {events, meta, subagents}` pure, idempotent on re-read; `handle` writes via `native.append`, emits, then side effects.

### Serving (`threads/live.ts`, `api/thread.ts`)
- Snapshot / window / page / events-after routes, command route, `thread_of(task)` (thread state computed from the task), `send_events` (emit + `note_todos`), `send_resync`.
- `note_todos`: after emitting, if a completed top-level `todo` tool call was added/updated, copies its list onto `tasks.todos` (empty list when every todo is completed).

### Readers (`threads/history.ts`): see table in section 3.

### Migration/ops (`batch.ts`, `rebuild.ts`, `report.ts`): batch rebuild with progress, `huntaway threads-rebuild`, `huntaway threads-import` dry run.

### Clients
- `packages/client/src/thread.ts`: `thread(h,id,limit?)`, `threadItems(h,id,before,limit?)`, `threadEvents(h,id,after)`, `threadCommand(h,id,cmd)`, `answerQuestion`, `resolvePermission`, `pendingPermissions`, `send`, `stop`, legacy `messages`/`messagePage`; `THREAD_VIEW_API = 119`; `QUESTION_TOOLS = ["AskUserQuestion","request_user_input"]`.
- `apps/web/src/itemThreads.ts`: retain/release a thread (ref-counted, dropped 10 s after last view), load window of 300, hold events while loading, gap -> catch up, resync, older pages of 200, preview text into `deltas.ts`.
- `apps/web/src/itemModel.ts`: adapter items+requests -> view model (`ThreadModel` in `threadModel.ts`): rows, tool-call groups, per-subagent rows, subagent list, `lastSent`.
- `apps/web/src/deltas.ts`: streamed text per task, batched once per animation frame, only for threads something is showing.
- `apps/web/src/subagents.ts`: `Subagent` view type, focus/reveal and "show subagent in full" stores.

## 3. Data

### 3.1 The protocol (copy of `threads/protocol.ts` declarations, comments abridged)

```ts
type ThreadStatus = "idle" | "running" | "waiting" | "error";
type PermissionMode = "default" | "accept_edits" | "auto" | "plan" | "bypass" | "dont_ask";
//  board names:      default     acceptEdits      auto     plan     bypassPermissions  dontAsk
interface Usage { input_tokens: number; output_tokens: number; cache_read_tokens?: number; cache_write_tokens?: number; cost_usd?: number }
interface Thread {            // computed from the task on every read; never stored
  id: string;                 // = task id
  harness: string;            // "claude" | "codex"
  status: ThreadStatus;       // idle if no run; waiting if running with an open request; else running ("error" never produced)
  title?: string; model?: string; effort?: string; permission_mode?: PermissionMode;
  cwd?: string;               // task.worktree_path
  session_id?: string; usage?: Usage; error?: string; metadata?: {[k: string]: unknown};
  created_at: string; updated_at?: string;
}
interface Attachment { kind: "image" | "file"; name?: string; media_type?: string; data?: string; path?: string }  // never used
interface ItemBase { id: string; parent_id?: string /* subagent tool_call this belongs to */; turn_id?: string /* never set */;
                     created_at?: string; metadata?: {[k: string]: unknown} /* the board's own facts, see 3.3 */ }
interface UserMessage extends ItemBase { type: "user_message"; text: string; attachments?: Attachment[]; steered?: boolean;
                                         queued?: boolean; client_id?: string }   // attachments/queued/client_id never set
interface AssistantMessage extends ItemBase { type: "assistant_message"; text: string }   // Markdown
interface Reasoning extends ItemBase { type: "reasoning"; text: string }
type ToolKind = "shell" | "read" | "edit" | "search" | "web" | "mcp" | "app" | "subagent" | "todo" | "other";
type ToolStatus = "pending" | "running" | "completed" | "failed" | "denied" | "cancelled";
interface ToolResult { content: string /* text; images are "[image]" */; structured?: unknown; truncated?: boolean; exit_code?: number }
interface FileChange { path: string; op: "add" | "update" | "delete"; diff?: string; move_to?: string }
interface Todo { text: string; status: "pending" | "in_progress" | "completed" }
type SubagentStatus = "running" | "completed" | "failed" | "stopped";
interface SubagentState { status: SubagentStatus; background?: boolean; agent_type?: string; model?: string;
                          activity?: string; tool_uses?: number; summary?: string /* background one's final report */;
                          ended_at?: string /* first time it ended */ }
interface ToolCall extends ItemBase {
  type: "tool_call";
  name: string;               // MCP tool: the tool's own name, server in `server`
  kind: ToolKind; input: unknown; status: ToolStatus; result?: ToolResult;
  title?: string;             // subagent: description
  command?: string;           // shell
  path?: string;              // read, search
  changes?: FileChange[];     // edit
  query?: string;             // search pattern / web query
  url?: string;               // web
  server?: string;            // mcp
  todos?: Todo[];             // todo: whole list after the call
  subagent?: SubagentState;
}
interface Compaction extends ItemBase { type: "compaction"; trigger?: "auto" | "manual"; summary?: string; tokens_before?: number }
interface Notice extends ItemBase { type: "notice"; level: "info" | "warning" | "error"; text: string; code?: string; detail?: string }
interface TurnSession { id: string; at?: string; started?: boolean; lost?: boolean }      // never set
interface TurnResult extends ItemBase { type: "turn_result"; ok: boolean; interrupted?: boolean; error?: string;
                                        usage?: Usage; duration_ms?: number; session?: TurnSession }  // usage/session never set
type Item = UserMessage | AssistantMessage | Reasoning | ToolCall | Compaction | Notice | TurnResult;

interface Resolution { outcome: "allow" | "deny" | "answer" | "cancel"; always?: boolean; message?: string;
                       permission_mode?: PermissionMode; answers?: {[questionId: string]: string[]} }
interface RequestBase { id: string; tool_call_id?: string; parent_id?: string; resolution?: Resolution /* absent while open */;
                        turn_id?: string; created_at?: string; metadata?: {[k: string]: unknown} /* the stored prompt/question, 3.3 */ }
interface PermissionRequest extends RequestBase { type: "permission"; name: string; kind: ToolKind; server?: string; input: unknown; title?: string; reason?: string }
interface QuestionOption { label: string; description?: string }
interface Question { id: string; question: string; header?: string; options?: QuestionOption[]; multi_select?: boolean; allow_other?: boolean; secret?: boolean }
interface QuestionRequest extends RequestBase { type: "question"; questions: [Question, ...Question[]] }
interface PlanRequest extends RequestBase { type: "plan"; plan: string /* Markdown */ }
type ThreadRequest = PermissionRequest | QuestionRequest | PlanRequest;

interface EventBase { thread_id: string; seq: number }
type ThreadEvent =
  | { type: "thread.updated"; thread: Thread }                         // never emitted today
  | { type: "turn.started"; turn_id: string }                          // never emitted today
  | { type: "turn.completed"; turn_id: string }                        // never emitted today
  | { type: "item.added"; item: Item }                                 // append, or replace in place if the id exists
  | { type: "item.updated"; item_id: string; patch: {[k: string]: unknown} }   // null removes a field
  | { type: "items.removed"; item_ids: string[]; indices: number[] }   // never emitted today (rewinds don't remove items)
  | { type: "delta"; item_id: string; kind: "text" | "reasoning"; offset: number /* UTF-16 units */; text: string }  // not saved
  | { type: "request.opened"; request: ThreadRequest }                 // add, or replace in place
  | { type: "request.resolved"; request_id: string; resolution: Resolution };   // (each & EventBase)
type SavedEvent = Exclude<ThreadEvent, delta>;  type NewEvent = SavedEvent without seq/thread_id;

type Command =
  | { type: "send"; thread_id; text: string; attachments?: Attachment[]; client_id?: string }
  | { type: "interrupt"; thread_id } | { type: "respond"; thread_id; request_id: string; resolution: Resolution }
  | { type: "set_options"; thread_id; model?; effort?; permission_mode? }
  | { type: "rewind"; thread_id; turn_id: string }     // server also takes item_id, conversation, branch
  | { type: "new_session"; thread_id } | { type: "compact"; thread_id };

interface Snapshot { thread: Thread; items: Item[]; requests: ThreadRequest[]; seq: number /* 0 for none */;
                     start?: number /* window: index of first body item */; context?: number[] /* indices of the first context.length items */ }
interface ItemPage { thread_id: string; items: Item[] /* context items then body */; requests: ThreadRequest[];
                     start: number /* 0: nothing before */; context: number[]; seq: number }
```

Window rule: body = last `limit` items; context = (ascending index, before `start`) the transitive `parent_id` chain of every
body item, of every open request's `parent_id` and `tool_call_id`, and **every subagent call before the window** (so the
Agents list is complete and a quiet subagent's later items have a parent). Requests in a window: all open ones, plus resolved
ones whose anchor (its tool call's index, else none) is `>= start` or unknown. Page requests: those anchored inside the page.
`with_page` requires `page.start + body.length === state.start`; merges context sets, page's version wins for shared ones.
Indices are counts of items before, not `pos` (positions may have gaps).

### 3.2 Item and request ids (stable; used across the whole board)
- `legacy:<message id>`: user_message, notice from an `event`, `routine_report` notice, compaction, turn_result, API-error notice, "interrupted" notice, the board's own question request, a permission message with no `request_id`.
- `legacy:<message id>:<block index>`: assistant_message / reasoning made from one content block of a Claude assistant message; also a second tool call that reuses an id (its real id goes in meta `call_id`, warning `duplicate_call`).
- `legacy:<message id>:result`: assistant_message made from a turn result's text nobody said (`metadata.from_result`).
- Tool calls: the harness's id (Claude `toolu_…`, Codex item id). Codex subagent: `codex-agent-<child thread id>`. Codex turn plan: `plan-<thread id>-<turn id>`.
- Codex agentMessage/plan/reasoning/contextCompaction items: Codex's item id (no `legacy:`); the web orders such items against requests by `created_at`.
- Permission / plan / AskUserQuestion / Codex requestUserInput requests: the `permission_requests.id` (a `new_id()`).
- Stream preview: `stream:<Date.now() base36 at process start>:<counter>`; never in the store.
- "Message id": integer from SQLite's `sqlite_sequence` row for `messages` (`UPDATE sqlite_sequence SET seq=seq+1 … RETURNING`), allocated even though no row is written. It is the origin of items (`thread_item_origins`), `metadata.message_id` of requests, and is held by `permission_requests.message_id`, `checkpoints.message_id`, `runs.turn_message_id`. Codex-native writes each consume one too.

### 3.3 Board facts carried beside the protocol
`Item.metadata` (sent to clients): user_message `{auto: true}`; turn_result `{subtype, num_turns, total_cost_usd}`; compaction `{post_tokens}`; assistant_message `{from_result: true}`; subagent tool_call `{description, prompt}` (as `task_started` says them); `routine_report` notice: the whole report object (incl. `read`, `outcome`).

`Request.metadata` = the stored prompt/question message data plus `message_id` (for a plain permission, minus `input`, which is the request's own). It is the **mutable card state** the UI draws and the server reads back (`source.kept`):
- permission message data: `{tool_name, input, tool_use_id, request_id, status: "pending"|"allowed"|"denied"|"expired", kind?: "project"|"delete_task"|"automation"|"workflow" (absent/"tool" for a tool prompt), expires_at?, rule?: {tool, decision}, agent?: "codex", note?, answers?: string[][] (a secret's shown as ["(hidden)"]), feedback?, mode?, late?}`
- question message data (request_user_input card or merge-gate card): `{question, options: [{label, description?}], multi_select, allow_other, call_id, status: "pending"|"answered"|"replied"|"replaced"|"expired", answer?: {choices: string[], text: string|null}, merge_approval?: true}`

`ItemMeta` (`thread_items.meta`, server-only, used by readers and to rebuild the Translator):
`auto`, `from_agent` (all of it sent by other agents via `send_to_task`), `user_text` (the user's own part of a mixed message), `start` (the board's task-start prompt), `routine`, `review_round` (number) on user messages; `call_id` (real harness id of a duplicate call), `session` (harness session the call was made in), `subagent_task` (Claude's task id / Codex child thread id), `shown_tasks` (ids of background bash tasks the call started) on tool calls; `result_text` (the result's text or error), `compact` (a compaction run's end) on turn_result; `from_result` on assistant_message.

### 3.4 Legacy message envelope (`wire/messages.ts`) — still the unit of every board write
`Message {id: number; task_id; kind: "user"|"claude"|"event"|"permission"|"question"|"report"; data: any; created_at}`.
`MessagePage {messages, more, subagents}`. Data by kind:
- `user`: `{text, steered?, auto?, start?, from_agent?, user_text?, routine?, review_round?}`
- `event`: `{level: "info"|"warn"|"error", text, detail}`
- `permission`, `question`: as 3.3. `report`: a routine's report `{text, outcome, read?, …}` (assistant's thread only).
- `claude`: a slimmed Claude stream-json line (below); Codex turn ends are also written as a Claude-shaped `result`.

### 3.5 Claude stream-json -> message (`agent/runner/output.ts`), then message -> items (Translator)
Lines come from the run's `out.jsonl` (raw, kept in the run folder ~14 days, owned by the runner area); `runs.out_offset` makes re-read chunks idempotent. A line with `method` is Codex's. Per line type:

| stream-json line | Written to the thread | Items |
| --- | --- | --- |
| `system/init` | nothing (session id -> task/run; turn start) | – |
| `system/compact_boundary` | `claude {type:"system", subtype:"compact_boundary", compact_metadata}` | `compaction` (`trigger`, `tokens_before`=pre_tokens, metadata.post_tokens), `parent_id` if a subagent's |
| `system/task_started|task_progress|task_updated|task_notification` | the line minus `output_file`, `uuid`, `session_id`; `usage` cut to `{total_tokens, tool_uses, duration_ms}` | patch of the subagent call's `subagent` (below); `local_bash` ones redundant; other task types retained with a warning |
| `stream_event` (top-level only) | none. `message_start`: board `delta_reset` + preview reset; `content_block_start`: preview reset only; `content_block_delta/text_delta`: board `delta` + thread `delta` | preview only |
| `user` with `isReplay` | not stored; if its `uuid` is a pending steer -> `user {text, steered:true, from_agent?}` | `user_message` with `steered` |
| `assistant` / `user` | slimmed (below); dropped if content empty | per block (below) |
| `result` | `claude {type:"result", subtype, is_error, result, duration_ms, num_turns, total_cost_usd (this turn's added cost), interrupted?, compact?}`; skipped for a leftover task-notification result with `num_turns` 0 before the first result, and for another turn's result before the prompt was taken in | `turn_result` (+ maybe `assistant_message` `:result`) |
| `control_request` / `control_cancel_request` / `control_response`, `rate_limit_event`, `system/background_tasks_changed` | nothing directly (permission prompts arrive as `permission` messages from mcp/permissions.ts) | – |

`slim`: drop `tool_use_result` except for Agent results, where only `status, isAsync, agentId, agentType, resolvedModel, totalDurationMs, totalTokens, totalToolUseCount` stay; drop `tool_result_meta`; drop thinking blocks with empty text; drop `signature`, `caller` on blocks; tool_result text over 30,000 bytes truncated (`\n… [truncated ` marker), images become text `[image]`; drop `message.usage`, `message.container`, `message.stop_details`. `session_id` and `parent_tool_use_id` stay (the Translator needs them).

Translator rules (`message(m)` by kind):
- `user` -> `user_message legacy:<id>` (`steered`, `metadata.auto`), meta as 3.3; clears "what the turn said".
- `event` -> `notice` (level `warn`->`warning`; unknown level -> info + warning), `detail`.
- `report` -> `notice` code `routine_report`, level `error` if `outcome==="failed"`, metadata = report; fed again -> `item.updated`.
- `permission` -> request id = `request_id`; tool `ExitPlanMode` -> `plan` (`plan` = input.plan; allow resolution gets `permission_mode` from stored `mode`); `AskUserQuestion` / `request_user_input` -> `question` (Claude's question ids are the question texts when all distinct, else index; always `allow_other`; Codex's use `q.id`, `isOther`, `isSecret`; allowed -> `{outcome:"answer", answers}` read from stored `answers` (list per question, or map by text/id); denied -> `cancel`); otherwise `permission` (`kind` = `app` when data.kind is set and not `tool`, else from the tool name; `name`, `server`, `title` = command | path | changed paths | name). Status -> resolution: allowed -> allow(+note), denied -> deny(+note), expired -> cancel "Expired: its run ended before it was answered", replaced -> cancel, pending -> none, other -> cancel + warning.
- `question` -> question request `legacy:<id>` with one Question id `"q"`; answered -> `{answer, answers: {q: [...choices, text]}}`; replied -> cancel "Answered with a message instead"; else as above.
- A request message fed again: if metadata changed -> `request.opened` replacing in place (keeping the old resolution), then `request.resolved` if the resolution changed; pending again with a resolution before -> `request.opened` with no resolution (reopened). No change -> disposition `redundant`.
- Linking a prompt to its call (`tool_use_id`): no call with that id yet -> `tool_call_id` = the id (the call's item will have it); one unresulted call in the current session with equal input -> it; else wait in `waiting_prompts` and link when a call with that id and input arrives (re-emits `request.opened`). `parent_id` of the request = the call's parent subagent.
- `claude assistant`: `is_api_error_message` -> error `notice` with `code` = `api_error` | `error` | `"api_error"`. Otherwise per block: `text` (non-blank) -> assistant_message; `thinking` (non-blank) -> reasoning; `redacted_thinking` dropped; `tool_use` -> tool_call `running` with `tool_fields`, meta `{session, call_id?}`; then delivers any early result / waiting prompt. Main-conversation texts joined by `\n` become "what the turn said".
- `claude user`: string content with `isSynthetic` -> `summary` patch on the latest compaction of that conversation; `tool_result` blocks -> patch `{status, result}` on the call with that id, same parent and session, not yet resulted (status: not error -> completed; error and its prompt was denied -> denied; text starts with `[Request interrupted` or "The user doesn't want to proceed with this tool use." -> cancelled; else failed; `truncated` if > 30,000 chars and has the marker). Result before its call -> held in `early`. Text starting `[Request interrupted` -> info notice code `interrupted`; a subagent's prompt text and synthetic text -> redundant.
- `tool_fields(name, input)`: kind by name (Bash/BashOutput shell; Read/NotebookRead read; Edit/MultiEdit/Write/NotebookEdit/ApplyPatch edit; Glob/Grep search; WebFetch/WebSearch web; Task/Agent subagent; TodoWrite todo; `mcp__<server>__<tool>` mcp with `server`, except server `app` -> kind `app`; else other). Normalized: shell `command`; read `path`=file_path; search `query`=pattern, `path`; web `url`, `query`; subagent `title`=description; edit `changes` (ApplyPatch: per change `{path, op from kind add|delete|else update, diff, move_to=move_path}`; others one `{path: file_path|notebook_path, op:"update"}`); todo `todos` (`content` -> `text`).
- Subagents: `task_started` with `task_type` null/`local_agent` for exactly one call with that `tool_use_id` in the session -> `subagent {status:"running", background (is_backgrounded), agent_type, model}`, metadata description/prompt, meta `subagent_task`; a non-subagent call (forked Skill) becomes `kind:"subagent"` with title; a background subagent's call becomes `completed` immediately. `task_progress` -> `activity`, `tool_uses`. `task_updated` patch.status running -> running again (drop `summary`, `ended_at`); end statuses map completed/success -> completed, failed/error -> failed, killed/stopped/cancelled/interrupted -> stopped; `ended_at` set once. `task_notification` -> end + `tool_uses` + `summary` (background only). The Agent call's own tool_result: `resolvedModel`, `agentType`, `totalToolUseCount`; `isAsync` / `status:"async_launched"` / text "Async agent launched…" -> background; else ends it (error+interrupted -> stopped, error -> failed, else completed).
- `claude result` -> `turn_result legacy:<id>` `ok = subtype==="success" && !is_error`, `interrupted`, `error` (result text | subtype | "error", omitted for a bare interruption), `duration_ms`, metadata, meta `{result_text, compact}`. If ok and the result text differs (trimmed) from what the turn's last main assistant message said -> extra `assistant_message legacy:<id>:result` with `metadata.from_result` (not drawn; readers use `result_text`).
- Dispositions: `converted`, `redundant`, `retained` (+ warning codes: unknown_kind, unknown_level, unknown_status, unknown_claude, unknown_block, unknown_task_type, unknown_task, unplaced_text, empty_question, missing_answers, duplicate_call, ambiguous_call, ambiguous_parent, parent_not_subagent, missing_parent, unmatched_result, second_result, orphan_result, no_result, subagent_running, open_prompt).
- `finish()` (imports only): running calls -> cancelled, running subagents -> stopped, open requests -> cancel.
- `CONVERTER_VERSION = 5`.

### 3.6 Codex notifications -> items (`agent/codex/driver.ts` `map`)
Notifications of a thread other than the task's session are a subagent's: `parent_id = codex-agent-<threadId>`.
- `item/started` for commandExecution, fileChange, mcpToolCall, dynamicToolCall, collabAgentToolCall (not spawnAgent): add `running` tool_call. Names: `Bash {command (unwrapped from its shell), cwd}`, `ApplyPatch {changes}`, `mcp__<server>__<tool>`, dynamic tool `mcp__<namespace>__<tool>` (the board's tools: `mcp__huntaway__…`), `WebFetch {url}` / `WebSearch {query}`, `Read {file_path}` (imageView), collab tool name `{prompt, receiver_thread_ids}`.
- `item/completed`: agentMessage / plan -> assistant_message; reasoning (summary parts, else content, joined `\n\n`) -> reasoning; contextCompaction -> compaction (`manual` for a compact run else `auto`); tool items -> result (truncated to 30,000 bytes, `exit_code` for commands, "Applied." for file changes; status `declined` -> denied, error -> failed).
- `turn/plan/updated` -> one TodoWrite call per turn+thread, `completed`, updated in place.
- `turn/completed` (own thread) -> every still-running main-conversation non-subagent call -> `cancelled`; then a Claude-shaped `result` message through the Translator (`subtype` `success` | `error_during_execution`, `num_turns` 1, 0 for compact).
- Subagent lifecycle from `thread/started` (with a parent), `collabAgentToolCall` (spawnAgent/resumeAgent/sendInput/followupTask/closeAgent/interruptAgent, `agentsStates`), `subAgentActivity`, child `turn/started|completed`, `thread/status/changed` systemError, `thread/closed`: one `Agent` tool_call per child, always `background: true`, call `completed` once started, input `{description (prompt cut to 200), prompt, model, subagent_type, run_in_background:true}`, meta `subagent_task = child thread id`.
- `item/agentMessage/delta` -> board `delta` + thread `delta`; `turn/started`, agentMessage start/completion -> `delta_reset`.
- `error` (willRetry), `warning`, failed `mcpServer/startupStatus/updated` -> `event` messages (notices) through the Translator.
- Codex's approvals and `requestUserInput` arrive as the board's `permission` messages (requests.ts), like Claude's.

### 3.7 Tables
| Table | Columns | Notes |
| --- | --- | --- |
| `thread_items` | `task_id` (FK cascade), `id`, `pos` (unique per task, MAX+1), `type`, `parent_id`, `turn_id`, `live` (1 = running subagent call), `data` JSON (the Item), `meta` JSON (ItemMeta), `created_at`, `updated_at` | unique `(task_id,id)`; indexes `(task_id,pos)` unique, `(task_id,pos) WHERE live=1`, `(type, created_at) WHERE type='user_message'` |
| `thread_requests` | `task_id`, `id`, `pos`, `type`, `tool_call_id`, `turn_id`, `open` (0/1), `data` JSON (the ThreadRequest incl. resolution and metadata), `created_at`, `updated_at` | unique `(task_id,id)`, `(task_id,pos)` |
| `thread_events` | `task_id`, `seq`, `type`, `data` JSON (the numbered event; keys `type, thread_id, seq` first), `created_at` | PK `(task_id, seq)`; kept 24 h |
| `thread_item_origins` | `task_id`, `item_id`, `message_id` | PK all three, WITHOUT ROWID; index `(task_id, message_id)` |
| `threads` | `task_id` PK, `seq`, `converter`, `writes`, `error`, `rebuilt_at`, `flipped_at`, `flipped_writes`, `created_at` | one row per thread; made with the first write |
| `tasks` (columns used) | `thread_items` (0/1), `thread_source` (`messages`|`items`), `last_activity_at`, `todos`, `queued_message`, `queued_from_agent`, `queued_user_text`, `queued_routine`, `queued_routine_runs` (JSON string[]), `steering` (JSON Steer[]) | |
| `messages` | `id` AUTOINCREMENT, `task_id`, `kind`, `data` JSON, `created_at` | empty for items tasks except rows kept after a failed items write; its `sqlite_sequence` row is the message-id allocator |
| also read | `permission_requests` (`id, task_id, message_id, status, kind, tool_name, input, rule, expires_at, call_id`), `runs` | |

Values are stored as the JSON given, so unknown fields survive. All `thread_*` rows cascade-delete with the task.

Settings keys: `thread_items` (`"false"` = off; unset = on; migration only), `thread_batch` (start time while the batch rebuild is unfinished).

Files: none of its own. Raw agent output is the runner's `<run dir>/out.jsonl` (+ `input.jsonl`), pruned 14 days after a run ends; the thread tables are the only long-term record, and they are lossy (see `slim`). Attachments live in `<data-dir>/attachments/<32-hex id>/<clean name>`.

### 3.8 Readers (`threads/history.ts`), all on items, newest-first scans of only the needed item types
`last_assistant_text` (latest of: an assistant message's blocks joined by `\n`, a turn_result's `result_text`, an error notice with a `code` other than `routine_report`); `said_since_asked` (same, but null once a user_message is reached); `said_in_turn(message_id)`; `last_turn_end` -> `{id, end: "reply"|"compact"|"failed"}`; `turn_end(result)`; `user_replies(limit)` -> `{replies: [agentTextBefore|null, userText][], since, earlier}` (user's own words: not `auto`/`from_agent`, `user_text` if set); `user_wrote_since(ts)`; `user_messaged_since(ts)`; `moved_on(message_id)` (a user_message with origin message id greater); `first_user_message`; `user_message(message_id)`; `last_user_message`; `tool_calls_since(ts)` (as Claude `tool_use`/`tool_result` blocks, names re-joined as `mcp__<server>__<tool>` / `mcp__app__<tool>`, `is_error` unless completed); `tool_use(id)`; `subagent_call(event)` (only `Agent`/`Task` calls); `approval(permission_requests row)`; `user_messages_between(profile, from, to, ownerSql)`; `open_questions`; `asked(call_id)` (question request with `metadata.call_id`); `unread_reports`.

## 4. In-memory state

| State | Where | Purpose | Restart |
| --- | --- | --- | --- |
| Translator per thread (max 64, LRU), with the `writes` it matches | `write.ts` `live` WeakMap<Conn, Map> | open calls, subagents, requests, latest compaction, last text, held early results / waiting prompts / missing parents | rebuilt from the store by `Translator.from`; **held early results and waiting prompts are lost** |
| Events produced by a write | `write.ts` `written_events` WeakMap<message object> | hand events to the emitter after commit | n/a |
| Stream preview per task `{item_id, offset}` + counter + process-unique prefix | `write.ts` `streams` | delta ids/offsets | lost; new prefix so clients see a new preview |
| `failed` set (ensure rebuild failed), `unbuilt` map (flip rebuild failed, keyed by `rebuilt_at`) | `write.ts`, `source.ts` | don't retry on every read/write | cleared (retried) |
| `flipping` flag per connection | `source.ts` | whether tasks move onto items (serve.ts sets true) | set at start |
| `moved_by` WeakMap<message, Flip> | `source.ts` | announce the move when the message is emitted | n/a |
| `journals` | `source.ts` | tests only | n/a |
| Batch `Progress` | `batch.ts` WeakMap<AppState> | Settings -> Server progress | `thread_batch` setting resumes it |
| Web: `live` map per shown thread `{host, views, held, gen, preview}`, zustand `threads`/`missing`, model cache, delta store | `itemThreads.ts`, `itemModel.ts`, `deltas.ts` | following a thread | page lifetime |

Durable: items, requests, metas, origins, `threads.seq`/`writes`, 24 h of events. Not durable: deltas / preview text (a client connecting mid-message sees only the rest; the saved item has all).

## 5. Outside the process
- No binaries or HTTP services of its own. Thread commands call the host's own HTTP routes in process (`api.local_request`).
- CLI: `huntaway threads-rebuild [--db <file|data dir>] (<task id|key>… | --all | --batch) [--check] [--json]` (opens the DB with `busy_timeout=10000`, refuses a DB not at this build's schema; exit 1 on failure/difference); `huntaway threads-import --db <file> [--json] [--task …] [--examples n] [--write <new file>]` (read-only dry run + size report).
- Env: `IA_DATA_DIR` (default DB location for threads-rebuild); `IA_NEW_DB_FILE=0` (older DB file; no longer changes thread behaviour).
- Websocket: events go out on the host's `/api/host/ws` and the hub's `/api/ws` (hub adds `host_id`).

## 6. Background work
- Event log pruning: on every `append` for that thread; hourly (`PRUNE_EVERY = 3,600,000 ms`, in `agent/runs.ts`'s pruner) for all threads; retention `KEEP_MS = 24 h`.
- Server start: `batch.resume` (if `thread_batch` set) and `source.flip_all` (every task not on items, not-done first then done, oldest first, one transaction each, `setImmediate` yield between tasks).
- Batch rebuild: one synchronous transaction per task, yield between; stoppable after the current task.
- Attachments pruner: at start and every 6 h; removes attachment folders older than 7 days that no task description / queued message / steering / `messages` / `thread_items` / `thread_requests` data references.
- Web: thread dropped 10 s after its last viewer; deltas flushed once per animation frame (16 ms timer fallback).
- Hub socket: if a client's `bufferedAmount` exceeds 64 MB events are dropped and a `{type:"resync"}` is sent once it drains.

## 7. Surface

HTTP (host; through a hub at `/api/h/<host_id>/…`):
| Method, path | Meaning |
| --- | --- |
| `GET /api/tasks/{id}/thread[?limit=N]` | Snapshot, or window of last N items. 404 `task <id> has no thread kept as items` if no `threads` row (a task with no message yet) or `threads.error` set. Calls `batch.opened` first. |
| `GET /api/tasks/{id}/thread/items?before=I[&limit=N]` | ItemPage before index I; default 100; `before` required (400). |
| `GET /api/tasks/{id}/thread/events?after=SEQ[&limit=N]` | `{events, more, seq, resync?}`; `after` default 0; limit clamped 1..1000; unknown event types skipped but counted in `seq`; `resync:true` (with `seq` = last) when the log doesn't reach back or `after > last`. |
| `POST /api/tasks/{id}/thread/commands` | A Command; `thread_id` optional, must be the task's (400). Returns `{ok:true, result}` or the underlying route's error unchanged. |
| `GET /api/tasks/{id}/messages[?before&after&limit]` | Legacy: list or `MessagePage`; empty for items tasks; scheduled for removal (after 2026-11-20). Page: `limit` main-conversation messages or ~1 MB (`PAGE_BYTES`), never ends inside a subagent's run. |
| `POST /api/tasks/{id}/messages {text}` | Send (start a turn, steer, or queue); also marks open questions `replied`. |
| `POST /api/tasks/{id}/questions/{message_id} {choices, text}` | Answer a request_user_input / merge-gate card. |
| `GET /api/permissions[?task_id|profile_id]`, `POST /api/permissions/{id} {decision: allow|allow_always|deny, message?, answers?: string[][], mode?, feedback?, automation?, via?}` | Pending prompts; answer one. |
| `GET /api/admin/threads`, `POST /api/admin/threads/batch [{stop:true}]` | `{pending, batch: Progress|null}`; start/stop the batch rebuild. |
| `GET /api/attachments/{id}/{name}`, `POST /api/attachments` | Download/upload (JSON base64, max 10 MB). |

Command mapping: `send {text}` -> POST messages (attachments in the command are rejected with 400; `client_id` ignored); `compact` -> POST messages `{text:"/compact"}`; `interrupt` -> POST `/tasks/{id}/stop`; `set_options` -> PATCH task (`permission_mode` translated to board names); `rewind {item_id | turn_id, conversation?, branch?}` -> POST `/tasks/{id}/rewind {message_id = first origin of the user_message item}` (404 unknown item, 400 not a user message, 409 unknown origin); `new_session` -> clears `session_id`, `rewind`, `context`, adds info notice "The next message starts a new conversation with the agent" (409 while running); `respond`:
- request id is a `permission_requests` row: question -> `{decision:"allow", answers: lists in question order}` or deny for cancel; plan -> allow `{mode}` / deny `{feedback: message}`; permission -> `allow` / `allow_always` (when `always`) / `deny` + message.
- request id `legacy:<n>` whose message is a `question`: only `outcome:"answer"`; `answers.q` split into option labels (`choices`) and at most one free text.
- otherwise 409 "the board isn't waiting on it".

No MCP tools owned (but `request_user_input` and permission prompts write here).

## 8. Events

Emitted (`wire/events.ts` `HostEvent`, the whole host websocket contract; hub wraps with `host_id`):
- `task {task}`: a task was made or changed, whole task.
- `task_deleted {id, project_id|null}`.
- `message {task_id, message}`: a message was added (legacy; still sent for every board-side write; web only uses it for pending approvals).
- `message_updated {task_id, message}`: a message changed in place (prompt answered, question settled).
- `delta {task_id, text}`: streamed text (legacy; web ignores it).
- `delta_reset {task_id}`: streamed text is over.
- `thread_event {task_id, event: ThreadEvent}`: one event of a thread (saved or delta).
- `thread_resync {task_id}`: thread changed in a way its log doesn't say; take a fresh window.
- `project {project}`, `project_deleted {id}`.
- `profiles_changed`, `settings_changed`: re-read.
- `pens {profile_id}`.
- `usage {usage}`: a config's usage, whole.
- `approval_rules {profile_id}`, `approval_log {profile_id, task_id}`.
- `checkpoints {task_id}`.
- `automations_changed {project_id|null, profile_id, automation_id}`.
- `workflows_changed {project_id, workflow_id}`, `workflow_runs_changed {task_id}`.
- `docs {profile_id, slug, deleted?}`, `doc_comments {profile_id, slug}`, `docs_site {profile_id}`.
- `telegram {profile_id}`.
- `assistant_reply {task_id, profile_id, message_id, telegram}`: for the hub's push only.
- `release_checked`, `release_download {download|null}`, `restart {phase, error}`, `restart_log {line}`.
Hub's own (`HubEvent`): `hello {host_id}` first; `tick` every 25 s; `hosts_changed`; `resync {host_id?}` (with host: that host (re)connected; without: this socket fell behind).

Emission order for one write: (`task` + maybe `thread_resync` if the write moved the task onto items) -> `message` -> its `thread_event`s in seq order. Codex-native writes send only `thread_event`s. A question's answer emits its thread events before the reply it triggers is written.

Consumed: none from a bus; the area is called synchronously by its writers.

## 9. Invariants and hard-won rules
- **One transaction per write**: the message id allocation, translation, events, items, metas, origins and `threads.writes` commit together or not at all; events are sent to clients only after commit, in write order; a rolled-back write sends nothing (`write.ts`, `messages.ts`).
- **Saved events are gapless per thread** (1,2,3…), except that `clear` (a rebuild) bumps seq by one with no event so every older client sees a gap. `threads.seq` survives log pruning; seq never decreases.
- **Deltas** carry the seq of the last saved event and are never saved or applied by the store; the reducer must leave unknown item ids alone. The client ends a preview when an `item.added` with no `parent_id` arrives or a delta with another item id comes. Each Claude text block is its own preview (reset on `content_block_start`), because each block becomes its own item.
- **Client protocol**: connect the socket first, then load the window; hold events while a window or catch-up loads and apply after; on `is_gap` fetch `/thread/events?after=seq` instead of applying; `resync` answer or `thread_resync` -> fresh window; socket reconnect / `resync` -> catch up every shown thread; set state seq to the page's `seq` (unknown event types are counted). A generation counter discards stale loads (`itemThreads.ts`).
- **Server ordering lock is the single-threaded synchronous SQLite transaction**: "a rebuild is one synchronous transaction on the board's connection, so none of the task's messages can be written in the middle of it" (`batch.ts`). A rewrite with async DB access must replace this with a per-thread lock.
- **Translator cache vs `threads.writes`**: any write by anyone bumps `writes`; a cached translator with a different count is discarded and rebuilt from the store; on any thrown write the cache entry is dropped ("its translator may have taken in what was rolled back", `native.ts`).
- **Translator never looks ahead**: results stored before their call wait (`early`), prompts name a call by an id that may arrive later, children name parents by tool_use id. Held state is memory-only.
- **Duplicate tool_use ids happen** (resumed sessions): calls are told apart by harness session and parent; the second gets a `legacy:` id.
- **A request message fed again reflects the stored status as truth**: an expired question/plan can still be answered late; a question whose answer couldn't be sent goes back to pending and its request is reopened (`request.opened` without resolution).
- **`update_pending_message` is compare-and-set on `status === "pending"`** so two simultaneous answers take one.
- **Item ids must be stable and message-id-bearing**: rewinds (`item_origins`), `moved_on`, `said_in_turn`/`last_turn_end` (`legacy:<result message id>`), question answering (`legacy:<n>`), web row keys (`legacy:12:3` -> `12.3`) and request-vs-item ordering in the UI all depend on them.
- **UI ordering of requests among items**: by message id where both have one, else `created_at`; a request stored in the same millisecond as an item goes after it (`itemModel.ts`).
- **Todos on the card** only from a *completed*, top-level todo call: "a Claude call that's still streaming has none of its list yet, which would empty the card meanwhile" (`live.ts`).
- **A background subagent's tool call completes when the subagent starts**; its subagent state keeps running; `ended_at` is the first end. Windows must always include every earlier subagent call.
- **`from_result` assistant messages aren't drawn** and are skipped by `said`; a `/compact` run's turn_result (`num_turns` 0, ok) is folded into the compaction row by the web.
- **Notices with a `code`** (other than `routine_report`, `interrupted`) are Claude API errors and count as the agent speaking; board events have no code.
- **Whitespace-only text/thinking blocks make no item.**
- **SQL planner notes**: queries filtering one task's rows by kind/type write `+kind` / `+type` to keep SQLite off the wrong index (no ANALYZE is ever run) (`db/messages.ts`, `history.ts`).
- **Failure isolation**: a Codex notification whose items can't be written still has its other effects (turn end recorded, wait ended) (`driver.ts`); a Claude turn's `turn_ended` runs even if recording the result throws (`output.ts`).
- **Run output replays**: `on_output` skips bytes before `runs.out_offset`; Codex `map` is idempotent for a notification read twice.
- **Leftover / foreign results** aren't turn ends (HA-404/405): a `result` with `origin.kind==="task-notification"` and `num_turns===0` before the run's first result, or one naming other user messages before the prompt was echoed, is ignored.
- **Attachments are just paths in message text** (`Attached files:` list at the end, `…/attachments/<32 hex>/<name>`); reference scanning is substring search over item/request JSON, so thread storage must keep those paths literally.

## 10. How it is tested
- Hooks: `reached(point)` / `when(point, f)` in `util.ts` with points `threads:write`, `threads:translated`, `threads:rebuild`, `threads:flip`, `threads:flipped`, `threads:native` (simulate throws and process exits mid-write).
- `testing.state()` builds an in-memory DB AppState already on items (`on_items`), with a message journal (`testing.messages`) recording every message a task was "written as".
- `write.cached(c)`, `write.compare(c, task)`, `convert(messages)`, `fold(events)` as assertions; translator tests re-check every case against `apply_event` and against rebuilding the Translator after every message.
- `threads/fixtures/{claude (22),codex (20)}/<scenario>/{fixture.json, session.jsonl, expected.jsonl}`: recorded agent-threads sessions (scenario steps, raw CLI I/O, expected events with `{{placeholders}}`); Claude raw lines go through `handle_line`, Codex through the driver. Scenarios: adopt, app-tool, ask-user-question, background-subagent, compact, compaction, error, interrupt, mcp-tool, new-session, pass-through, permission-allow, permission-deny, plain-reply, plan, resume, rewind, set-options, skill-fork, steer, subagent, tool-calls.
- `threads/examples/{thread.snapshot.json, thread.window.json, thread.page.json, thread.events.jsonl, commands.jsonl}` via `examples.ts`: protocol reducer/window tests.
- Web: `itemModel.test.ts`, `itemThreads.test.ts`, UI screenshot test; `scripts/ia-api thread <task> [--limit|--before|--events --after] [--brief]`; `--fake-claude` test server.

## 11. Dependencies
- Calls: `db` (tx/savepoints, settings, tasks, runs), `agent/runner` (`send`, `stop`, `new_session`, `record_result`), `mcp/permissions` + `mcp/questions` routes, `api.local_request`, `AppState.emit/update_task/is_running`.
- Called by: `AppState.add_message/add_event/emit_message/emit_delta`; `agent/runner/output.ts` (Claude lines), `agent/runner/send.ts` (run prompt, start message, compact event inside start_run's transaction), `agent/runner/queue.ts` (steered messages), `agent/codex/driver.ts`, `mcp/permissions.ts`, `mcp/questions.ts`, `review/merge_gate.ts`, `integrations/automations/routines.ts` (reports); readers by review, summary, workflows, titles, wait tool, pr_watch, Telegram, push, checkpoints/rewind, analytics, MCP `last_message`, approvals; `attachments.ts`; `devices.ts` (paired phones may read the thread routes); web and mobile apps.

## 12. Rewrite notes

Queued, steering, review and summary as they relate to threads (for orientation):
- A **queued message** is not an item: it is `tasks.queued_message` (+ `queued_from_agent`, `queued_user_text`, `queued_routine`, `queued_routine_runs`), merged with `\n\n`, drawn by the UI from the task, and becomes a normal `user` message when the next run takes it.
- **Steering** messages sit in `tasks.steering` (`Steer {id (= stream-json uuid), text, from_agent, run_id, written, routine_runs?, routine?}`) and only enter the thread, as `user_message` with `steered: true`, when Claude echoes the uuid back (`isReplay`); unechoed ones are requeued when the run ends. `UserMessage.queued` / `client_id` are never used.
- **Review, summary and workflow-step threads** are separate tasks (`kind: "review"`, `type` null | `summary` | `workflow`, `parent_id` = the task), each with its own thread stored and served identically; the parent's thread only gets `event` notices and auto user messages (`review_round`). The assistant and routines are tasks too (`report` messages only in the assistant's).
- A **rewind** does not remove items; it adds a notice and changes the session; `items.removed` exists only in the protocol.

Essential:
- The item/request/event model, `apply_event`, windows/pages by index with context, seq + gap + resync + 24 h log, unsaved deltas for a preview.
- Atomic write + emit-after-commit; per-thread ordering.
- Tool normalization (`tool_fields`), subagent state machine, request lifecycle incl. reopen and replace-in-place, result/prompt matching rules.
- The board facts in `metadata`/meta that readers and the UI need (auto, from_agent, user_text, start, routine, review_round, result_text, compact, subagent_task).
- The readers' exact semantics (section 3.8), since review/Telegram/wait behaviour depends on them.

Accidental / migration residue (candidates to drop or redesign):
- The whole "message" intermediate for an items-only world: `kind`+`data` envelopes, the Translator as the write path for board events, `legacy:` id prefix, message ids drawn from the `sqlite_sequence` of an empty `messages` table, `source.kept` reconstructing a message out of request metadata for read-modify-write, the Claude path going stream-json -> `slim` -> Claude-shaped message -> Translator while Codex maps natively and then fakes a Claude `result`. A rewrite could write items directly for both harnesses but still needs a board-wide monotonic ordinal per write (ordering, origins, rewinds, `moved_on`).
- `tasks.thread_items`, `tasks.thread_source`, `threads.converter/error/rebuilt_at/flipped_at/flipped_writes`, settings `thread_items` and `thread_batch`, `flip`/`flip_all`/`settled`, `ensure`, `rebuild`, `compare`, batch + admin routes, `threads-rebuild`, `threads-import`, `CONVERTER_VERSION`, `Translator.finish`, the `failed`/`unbuilt` sets, `history.ready`/`on_items`: all exist to migrate from `messages`.
- `message`, `message_updated`, `delta`, `delta_reset` events and the `/messages` GET routes (`message_page`, `subagent_messages`): kept for old hosts/clients until 2026-11-20; the web still uses `message` events of kind `permission` to refresh pending approvals (needs another source).
- Protocol parts never produced: `thread.updated`, `turn.started`, `turn.completed`, `items.removed`, `turn_id`, `Thread.status: "error"`, `Thread.usage/error/metadata`, `Attachment`, `UserMessage.attachments/queued/client_id`, `ToolResult.structured`, `TurnResult.usage/session`, `PermissionRequest.reason`, reasoning deltas (`kind` is always `text`), request anchoring by `turn_id`. The `thread_items.live` column and its index are written but no reader uses them.
- snake_case function names and "port of …rs" comments (Rust port); agent-threads lineage notes.
- Request `metadata` duplicates `permission_requests` rows as the mutable card state; two sources of truth for a prompt's status.
- `Thread` is recomputed from the task on every read and never pushed; clients rely on `task` events for status/model/mode.

Awkward today:
- A snapshot taken mid-message has no preview text; a client that opens mid-stream shows only the remainder.
- Raw agent output is discarded after 14 days and the stored items are lossy (no per-message usage, no edit diffs for Claude, results cut at 30,000 bytes, images dropped), so translator fixes can't be applied retroactively any more.
- Held translator state (early results, waiting prompts) is lost on restart or cache eviction (64 threads).
- `note_todos` updating the task from inside the event sender; `open()` 404 for a task with no messages being the client's "empty thread" signal.
