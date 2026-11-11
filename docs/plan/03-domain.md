# 3. Domain types

The shapes in `packages/contracts`. They are the old API's shapes (`apps/server/src/wire/*.ts` and
`threads/protocol.ts` in huntaway) re-declared as schemas, because the kept components read those fields. This page
gives the rules, the central types in full, and what changes. [spike/domain.ts](spike/domain.ts) is the same code,
type-checked.

## Rules for every wire type

1. **A wire type is a `Schema.Struct` whose decoded and encoded forms are identical**: plain JSON values only. No
   `Schema.Class`, no `DateTime`, no `Option`, no `Map`. Components spread and compare these values, and the client
   keeps unchanged objects identical between events so rows do not redraw.
2. **Field names are the old ones, snake_case.** Where the old name is misleading (`claude_config_id` for a config of
   either agent) it stays for now; [14-dropped-and-open.md](14-dropped-and-open.md) has the one mechanical rename
   proposed for after the port.
3. **A field that can be absent is `Schema.NullOr`**, and is always sent. `Schema.optional` is only for the thread
   protocol, which omits unset fields today, and for request payloads.
4. **Ids are branded strings; timestamps are a branded string** in RFC 3339 UTC with milliseconds, compared as
   strings as they are today.
5. **Unions the components switch on keep `type` as the tag** (events, thread items and requests, workflow nodes,
   `StartFrom`, triggers and actions).
6. **A type has one declaration.** The server's row for an entity is `typeof Entity.Type` plus what is never sent
   (secrets), declared beside its repository. There is no second, hand-written interface.
7. **Reading stored JSON is lenient, writing is strict.** A JSON column that fails its schema reads as null or
   empty and logs once, as the old readers do, so one bad value cannot break a board. Nothing is written without
   passing its schema.

## Ids and enumerations

```ts
export const HostId = Schema.String.pipe(Schema.brand("HostId"))
export const ProfileId = Schema.String.pipe(Schema.brand("ProfileId"))
export const ProjectId = Schema.String.pipe(Schema.brand("ProjectId"))
export const TaskId = Schema.String.pipe(Schema.brand("TaskId")) // also the id of the task's thread
export const RunId = Schema.String.pipe(Schema.brand("RunId"))
export const AgentConfigId = Schema.String.pipe(Schema.brand("AgentConfigId"))
// … PenId, AutomationId, WorkflowId, WorkflowRunId, DocId, LinkId (= the other host's HostId), DeviceId, RequestId, CallId

export const Timestamp = Schema.String.pipe(Schema.brand("Timestamp"))

export const Status = Schema.Literals(["backlog", "todo", "in_progress", "needs_attention", "in_review", "ready_for_merge", "done"])
export const Resolution = Schema.Literals(["done", "not_done", "wont_fix"])
export const TaskKind = Schema.Literals(["task", "review"])
export const TaskType = Schema.Literals(["scratch", "assistant", "routine", "pens", "pen", "summary", "workflow"])
export const DocumentLabel = Schema.Literals(["plan", "artifact", "diagram"])
export const PermissionMode = Schema.Literals(["default", "acceptEdits", "auto", "plan", "dontAsk", "bypassPermissions"])
export const Effort = Schema.Literals(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"])
export const Agent = Schema.Literals(["claude", "codex"])
export const WorktreeState = Schema.Literals(["none", "setting_up", "ready", "tearing_down", "error"])
```

All ids are UUID v4 text made by the server. Models are free strings, as now: there is no server-side list.

## The task

One struct, the central type of the board. Its fields are the old `Task`'s, grouped here as
[the inventory](inventory/09-data-model.md) groups them; that note's section 3b has every field's meaning and the
nested value types (`Review`, `PrChecks`, `AgentWait`, `Context`, `ChangeSummary`, `Rewind`, `BackgroundWork`…).

```ts
export const Task = Schema.Struct({
  // identity and placement
  id: TaskId,
  profile_id: ProfileId,
  project_id: Schema.NullOr(ProjectId),
  kind: TaskKind,
  parent_id: Schema.NullOr(TaskId), // a review thread's task; a routine thread's assistant
  task_type: Schema.NullOr(TaskType),
  labels: Schema.Array(DocumentLabel),
  group_name: Schema.NullOr(Schema.String),
  number: Schema.Int,
  key: Schema.String, // new: "HE-2", worked out by the server
  pen_id: Schema.NullOr(PenId),
  fanout_id: Schema.NullOr(Schema.String),
  created_by: Schema.NullOr(TaskId),
  position: Schema.Number,
  work_dir: Schema.NullOr(Schema.String),

  // what the user sees
  title: Schema.String,
  title_pinned: Schema.Boolean,
  description: Schema.String,
  status: Status,
  resolution: Schema.NullOr(Resolution),
  done_at: Schema.NullOr(Timestamp),
  attention_reason: Schema.NullOr(Schema.String),
  starred: Schema.Boolean,
  remind_at: Schema.NullOr(Timestamp),
  reminder: Schema.NullOr(Schema.String),
  preview_url: Schema.NullOr(Schema.String),
  pr_url: Schema.NullOr(Schema.String),
  pr_checks: Schema.NullOr(PrChecks),
  external_links: Schema.NullOr(Schema.Array(ExternalLink)),
  todos: Schema.NullOr(Schema.Array(Todo)),
  tracked: Schema.NullOr(Schema.Array(TrackedItem)),
  context: Schema.NullOr(Context),
  document_at: Schema.NullOr(Timestamp),
  cost_usd: Schema.Number,
  last_activity_at: Timestamp,
  created_at: Timestamp,
  updated_at: Timestamp,

  // git and merging
  use_worktree: Schema.Boolean,
  worktree_path: Schema.NullOr(Schema.String),
  worktree_state: WorktreeState,
  worktree_error: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  base_branch: Schema.NullOr(Schema.String),
  start_from: Schema.NullOr(StartFrom),
  merges_into: Schema.NullOr(TaskId),
  carries: Schema.NullOr(Carries),
  restack: Schema.NullOr(Schema.Literals(["due", "conflict"])),
  github_stack: Schema.NullOr(Schema.Int),
  stack_title: Schema.NullOr(Schema.String),
  stack_description: Schema.NullOr(Schema.String),
  stack_pinned: Schema.Boolean,
  stack_run: Schema.NullOr(Schema.String),
  merging: Schema.Boolean,
  remerge: Schema.Boolean,
  merge_approval: Schema.NullOr(Schema.Literals(["pending", "approved"])),
  depends_on: Schema.Array(TaskId),
  waiting: Schema.Boolean,

  // the agent and its run
  session_id: Schema.NullOr(Schema.String),
  running: Schema.Boolean,
  run_started_at: Schema.NullOr(Timestamp),
  steerable: Schema.Boolean,
  limit_reset_at: Schema.NullOr(Timestamp),
  agent_wait: Schema.NullOr(AgentWait),
  background_work: Schema.NullOr(BackgroundWork),
  servers: Schema.NullOr(Schema.Array(TaskServer)),
  queued_message: Schema.NullOr(Schema.String), // worked out from the task's queue rows
  steering: Schema.Array(Steer), // worked out from the task's steer rows
  model: Schema.NullOr(Schema.String),
  effort: Schema.NullOr(Effort),
  permission_mode: Schema.NullOr(PermissionMode),
  claude_config_id: Schema.NullOr(AgentConfigId),
  auto_allow: Schema.Array(Schema.String),
  review: Schema.NullOr(Review),
  summaries: Schema.Array(ChangeSummary),
  rewind: Schema.NullOr(Rewind)
})
export interface Task extends Schema.Schema.Type<typeof Task> {}
```

The task's `external_links`, `todos`, `tracked` and `servers` are plain arrays, always sent (the old row builder
always sent arrays; HE-3), not `NullOr` as above.

Changes from the old `Task`:

| Field                                              | Change                                                                                             |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `key`                                              | New. The server works it out (`<project key>-<n>`, `G-`, `S-`, `A-`), so no client re-derives it   |
| `host_id`                                          | Not on the wire type. The client adds it to what it keeps (`HostTask = Task & { host_id }`), as now |
| `subproject`                                       | Gone, with subprojects. `parent_id` now means only "the thread this one hangs under"               |
| `thread_items`, `thread_source`                    | Gone: every thread is items                                                                        |
| `summary`                                          | Gone: `summaries` is the list (always an array, possibly empty)                                    |
| `rewind`                                           | Always present, null when unset (it was omitted)                                                   |
| `kind: "scratch"`, document names in `task_type`   | Gone: the importer converts the few old forms                                                      |
| `queued_message`, `steering`                       | Same shape on the wire, but worked out from rows ([04-database.md](04-database.md#the-queue-and-steers)) |

`TaskPatch` (what `tasks.update` takes) and `NewTask` (what `tasks.create` takes) are separate structs with only the
fields a client may set; the inventory has both lists (07, sections 7.7 and 7.8).

### What kind of thread a task row is

The old code asks this with predicates spread over five columns, and a board query that forgets one leaks the
assistant onto a board. The server has one function, used by every query filter, the prompt builder and the end of a
run:

```ts
export type ThreadKind =
  | { _tag: "Code"; project_id: ProjectId; worktree: boolean } // an ordinary task
  | { _tag: "Document"; project_id: ProjectId | null; labels: ReadonlyArray<DocumentLabel> } // plan, artifact, diagram
  | { _tag: "Scratch"; project_id: ProjectId | null }
  | { _tag: "Group"; group: string }
  | { _tag: "Assistant" }
  | { _tag: "Routine"; assistant: TaskId }
  | { _tag: "PensRoot" }
  | { _tag: "Pen"; pen: PenId }
  | { _tag: "Review"; of: TaskId }
  | { _tag: "Summary"; of: TaskId }
  | { _tag: "WorkflowStep"; of: TaskId }

export const threadKindOf: (task: Task) => ThreadKind
```

`threadKindOf` is a pure function in `packages/contracts`, so the clients use it too. "Is on a board", "takes a
status", "is reviewed", "has a merge", "which key letter" and "which system prompt" are all tables over `_tag`.

## The other entities

Each keeps its old fields. What changes:

| Type                    | Old declaration (`wire/`)                  | Changes                                                                                         |
| ----------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `Profile`               | `profiles.ts`                              | Without `claude_config_dir` and `summarizer` (the single one). Secrets (`asana_token`) are not in the schema at all |
| `AgentConfig` (was `ClaudeConfig`) | `claude_configs.ts`             | Same fields. `has_api_key`/`has_management_key` stay booleans; the keys are write-only inputs    |
| `Project`, `Reviewer`   | `projects.ts`                              | Without `subproject_pull_requests`, `summarizer`. `is_git`/`has_commits` are cached, not read from disk on every row |
| `Pen`                   | `pens.ts`                                  | Without `hidden`                                                                                 |
| `Automation`, `Trigger`, `Action`, `AutomationRun` | `automations.ts` | `Action.task_type` no longer takes document names                                              |
| `Workflow`, `Graph`, `Node`, `Edge`, `WorkflowRun` | `workflows.ts`   | Without the legacy node kinds (`set_status`, `trigger` on `status`/`finished`)                  |
| `Doc`, `DocVersion`, `DocComment`… | `docs.ts`                       | Same                                                                                             |
| `Host`, `HostInfo`, `HostSettings`, `ServerStatus`, `ReleaseStatus` | `server.ts` | `api_version`/`api_compat` replaced by `protocol` and `version`; `capabilities` stays. `HostInfo` gains `read_only` (a [rehearsal](11-migration.md#rehearsal)). `HostSettings` without `thread_items` |
| `Usage`, `UsageLimit`   | `usage.ts`                                 | Same                                                                                             |
| `PendingPermission`, `Approval` | `permissions.ts`, `approvals.ts`   | `kind` is `tool \| project \| delete_task \| automation \| workflow`, each with its own input    |
| `ApprovalRules`, `ApprovalAction` | `approval_rules.ts`              | Same, in `approval.ts` (3.6): the view is `ApprovalRulesView`, the stored rules `ApprovalRuleSet`, a save `ApprovalRulesUpdate` |
| `GitStatus`, `DiffResult`, `Turn`, `Checkpoint` | `git.ts` and handler-local types | Declared for the first time: the old handlers returned untyped JSON                      |
| `SyncEntry`, `SettingsSync` | `settings_sync.ts`                     | Same                                                                                             |

`Run` is not a wire type: clients see a run only through the task's fields. The server's `Run` is in
[07-agents.md](07-agents.md#the-run).

## The thread protocol

`threads/protocol.ts` becomes `packages/contracts/src/thread/`: the schemas (`Thread`, `Item`, `ThreadRequest`,
`ThreadEvent`, `Command`, `Snapshot`, `ItemPage`) and, beside them, the pure functions that are shared with the
clients today, kept behaviour for behaviour: `initialState`, `applyEvent`, `applyEvents`, `isGap`, `snapshotWindow`,
`itemPage`, `withPage`, `openRequests`, `isSubagent`. [The inventory](inventory/08-threads.md) has the full
declaration (section 3.1), the window rule and the id conventions.

```ts
export const Item = Schema.Union([UserMessage, AssistantMessage, Reasoning, ToolCall, Compaction, Notice, TurnResult])
export const ThreadRequest = Schema.Union([PermissionRequest, QuestionRequest, PlanRequest])
export const ThreadEvent = Schema.Union([ItemAdded, ItemUpdated, RequestOpened, RequestResolved, Delta]) // each with thread_id and seq
```

Changes:

- **Only what is produced is declared.** `thread.updated`, `turn.started`, `turn.completed`, `items.removed`,
  `turn_id`, `Attachment`, `UserMessage.queued/client_id/attachments`, `ToolResult.structured`,
  `TurnResult.usage/session` and `PermissionRequest.reason` were never sent and are left out. `Schema.Struct` ignores
  unknown keys on decode, so adding one later is not a break.
- **The reducer still ignores an event whose `type` it does not know**, counting its `seq`. The stream decodes with
  the union plus an `UnknownEvent { type: string, thread_id, seq }` fallback, so a host one version ahead does not
  break a thread view.
- **Item ids keep their form**, including the `legacy:<n>[:<block>]` ids of board-written items. `<n>` is a
  board-wide write number ([04-database.md](04-database.md#write-numbers)). The UI orders requests among items by it,
  and rewinds, "has the conversation moved on" and question answers key on it. Renaming the prefix would change code
  on both sides for no behaviour.
- **Permission modes keep both spellings**: Claude Code's on tasks and projects (`acceptEdits`), snake_case in the
  thread protocol (`accept_edits`). One pair of converters in the contracts package replaces the copies.

As built (HE-4, 2.1), in `thread/Thread.ts`, `Item.ts`, `Request.ts`, `Event.ts`, `Command.ts`, `Snapshot.ts`,
`reducer.ts`, `window.ts`:

- **Names that would clash** with the board's: the request's `Resolution` is `RequestResolution` (the task has a
  `Resolution`), the protocol's mode is `ThreadPermissionMode` (converters `toThreadPermissionMode`,
  `fromThreadPermissionMode`), item and request `metadata` is `ThreadMetadata`. A tool call's `todos` are the task's
  `Todo`, the same shape. The protocol's `Usage` went with the fields that held it.
- **Also left out, as never produced**: `Thread.status: "error"`, `Thread.usage/error/metadata`, `send`'s
  `attachments` and `client_id`, and `rewind`'s `turn_id` (it takes the user message's `item_id`). Without `turn_id` a
  request is anchored by its tool call only; one with none is in every window and in no page, as before.
- **Fields the old protocol omits when unset are `Schema.optionalKey`** (exact: absent, never `undefined`). The types
  are `typeof X.Type` aliases, not interfaces, so the reducer can spread them (`no-misused-spread` takes an interface
  over a schema's type for a class).
- **The reply being written is a `preview`, not a `delta`.** `threads.watch` streams it as
  `ThreadPreview { type: "preview", thread_id, seq, item_id, offset, text }`, and the snapshot carries what has
  streamed so far (`ThreadSnapshot.preview: { item_id, text } | null`). `previewAfter(preview, message)` folds it as
  the old web did: text at its offset, overlap skipped; a new reply for another `item_id`; none once an item is added
  to the main conversation. `Delta` stays in `ThreadEvent` (the reducer applies one to an item the thread has, and the
  recorded sessions have them), but the board does not produce one.
- **`threads.watch` streams `ThreadMessage`** = `ThreadSnapshot | ThreadEvent | ThreadPreview | UnknownEvent`, in that
  order, so an event of a newer type, or of a known type whose item this build cannot read, decodes as an
  `UnknownEvent`. The reducer takes `ThreadEvent | UnknownEvent` and counts what is not a whole `ThreadEvent`.
- **The recorded sessions are checked in `packages/testing/test/threadFixtures.test.ts`** (contracts has no Node
  types to read files with): each of the 695 expected events of a declared type decodes as `ThreadEvent` losing only
  the fields above, and every scenario folds. agent-threads' spec examples are beside them in `fixtures/threads/examples/`.

## Events

`BoardEvent` is what a host's board stream carries: the old `HostEvent` union
([inventory](inventory/08-threads.md), section 8) with a sequence number on every event, minus the legacy kinds.

```ts
export const BoardEvent = Schema.Union([
  Hello, // { type: "hello", host_id, boot, seq }: first on every subscription
  Resync, // { type: "resync", seq }: events were dropped or cannot be replayed; refetch lists
  TaskChanged, // { type: "task", seq, task }
  TaskDeleted, // { type: "task_deleted", seq, id, project_id }
  ProjectChanged, ProjectDeleted, ProfilesChanged, SettingsChanged, PensChanged, UsageChanged,
  ApprovalChanged, // new: { type: "approval", seq, approval | removed }, replaces reading `message` events
  ApprovalRulesChanged, ApprovalLogChanged, CheckpointsChanged, AutomationsChanged, WorkflowsChanged,
  WorkflowRunsChanged, DocsChanged, DocCommentsChanged, DocsSiteChanged, AssistantReplied,
  ReleaseChecked, ReleaseDownload, Restart, RestartLog
])
```

Where the old event said "read them again" (`profiles_changed`, `settings_changed`, `pens`), the new one carries
what to read (all profiles and configs, the settings, the profile's pens), so a client never loads lists beside the
stream (HE-3). So do `approval_rules { profile_id, rules }` (the view `approvalRules.get` gives) and
`approval_log { profile_id, task_id, action }` (the entry as written or settled) (3.6). The board snapshot carries
neither: Settings reads them per profile with `approvalRules.get` and `log`.

Gone: `message`, `message_updated`, `delta`, `delta_reset` (legacy), `thread_event` and `thread_resync` (a thread
is its own subscription, [05-protocol.md](05-protocol.md#a-thread)), `telegram`, `tick` (the RPC client pings).
`hosts_changed` moves to the hub's own stream.

## Errors that cross the wire

A small closed set, so a client can handle any call the same way. Each is a `Schema.TaggedError` in
`packages/contracts/src/errors.ts`:

| Error            | Fields                                   | Replaces                  | Shown as                                        |
| ---------------- | ---------------------------------------- | ------------------------- | ----------------------------------------------- |
| `NotFound`       | `what`, `id`                             | 404                       | "task … not found"                              |
| `Invalid`        | `field`, `reason`                        | 400, and the 422 texts    | Beside the field                                |
| `Conflict`       | `reason` (a literal), `detail`           | 409                       | The detail; the reason lets the UI offer the fix (`todos_unfinished` offers "move anyway") |
| `Forbidden`      | `scope`                                  | 403                       | "this device can't …"                           |
| `Unauthorized`   | none                                     | 401                       | The token screen                                |
| `HostOffline`    | `host_id`, `host_name`                      | 503 from the proxy        | The host's offline state                        |
| `HostRefused`    | `host_id`, `reason`                      | 502 from the proxy        | "link it again"                                 |
| `Unavailable`    | `what`, `reason`                         | 503 (no tmux, no gh, agents can't run here) | The reason                    |
| `External`       | `service`, `reason`                      | 502 (Asana, GitHub, docs site) | The reason                                 |

`Conflict.reason` is the closed list of things a client reacts to (`agent_running`, `worktree_made`, `merging`,
`todos_unfinished`, `pr_not_approved`, `changed_meanwhile`, `has_session`, `archived`, `already_running`,
`not_pending`, `moved_on`, `duplicate_name`, `restart_in_progress`). Inside the server, services fail with more
specific errors (`AgentAlreadyRunning`, `WorktreeDirty`…); the RPC handler maps them to this set.
`RpcClientError` (the socket) and a defect (an opaque internal error with a log id) are the two other things a
caller can see.
