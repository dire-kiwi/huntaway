# 10. Web app, shared client package, Electron shell

Source: `the huntaway repository` at `f2298f0c` (master, 2026-11-11). Paths below are relative to it.
Read in full: `apps/web/src/{main.tsx,App.tsx,store.ts,live.ts,router.ts,api/index.ts,itemThreads.ts,deltas.ts,threadModel.ts,threadView.ts,notifier.ts,notifications.ts,push.ts,shortcuts.ts,theme.ts,narrow.ts,selection.ts,activeProfile.ts,approvals.ts,index.css}`,
`packages/client/src/{http,index,hosts,events,protocol,tasks,thread,terminal,attachments,approvals,labels}.ts`, `apps/server/src/wire/events.ts`.
Headers, exports and call sites (not every line) of the other top-level helpers and of about 60 component files.
The Electron shell and the test tiers were read in full by two sub-surveys whose findings are folded in (sections 5, 6, 10).

The task brief said `components/` has 342 files; at this commit it has **298** (210 `.tsx`, 87 `.ts`, 1 `.css`) in 22 folders.

## 1. Purpose

`apps/web` is the board's UI: a React 19 single-page app, served as static files by the Huntaway server (the hub), that
shows every profile, project and task of every linked host, each task's thread, changes, terminal and documents, and
all settings. It talks to one board through `@huntaway/client` (a hand-written typed HTTP client, shared with
`apps/mobile`) and one websocket (`/api/ws`) whose events are folded into a zustand store. `apps/web/electron` is a thin
desktop shell: it starts or attaches to a local server, opens the board in `BrowserWindow`s, and updates itself. There
is no server-side rendering, no router library, no data-fetching library and no form library: all of that is hand-rolled.

## 2. Capabilities

### 2.1 Boot and sign-in (`main.tsx`, `App.tsx`, `api/index.ts`, `packages/client/src/http.ts`)
- `captureTokenFromUrl()`: takes `?token=` off the URL into `localStorage["ia.token"]` and strips it with `history.replaceState` (how the shell and shared links sign in).
- `setUpViewport()` (`narrow.ts`): iOS `maximum-scale=1`; keeps `--app-height` at the visual viewport's height while the on-screen keyboard covers more than 80 px.
- `setUpTint()` (`theme.ts`): applies the last tint from `localStorage["ia.tint"]` before profiles load.
- Open boards (PR previews, server `--open-token`): with no token, `fetchOpenToken()` (`GET /api/open-token`) runs before the first render; with one, render first and check behind it unless `ia.openBoard` is `"0"`.
- `App` mounts once: `setUnauthorizedHandler` (on a 401: reload if the stored token differs from the one used or an open token replaced it, else `setAuthed(false)` → `TokenScreen`), `connectEvents()`, `startToolKeepalive()`, `startNotifications()`, `startPush()`.
- `authed === null` renders nothing; `false` renders `TokenScreen`; no profiles and `loaded` renders `Onboarding`.

### 2.2 State and live updates
- One zustand store for the board (`store.ts`), fed by the websocket (`live.ts`): section 4.
- Threads kept as items: windowed snapshot + events + paging + catch-up (`itemThreads.ts`, `threads.ts` = the server's `threads/protocol.ts` reducer); view model with identity reuse (`itemModel.ts`, `threadModel.ts`); streamed text previews batched per animation frame (`deltas.ts`).
- Listener registries for events that are not kept in the store (`live.ts` `onCheckpoints`, `onApprovalRules`, `onTelegram`, `onWorkflowsChanged`, `onDocs`, `onDocComments`, `onDocsSite`, `onAutomationsChanged`, `liveTaskChanges`).

### 2.3 Routing (`router.ts`): section 7.

### 2.4 Board (`components/board/`, 34 files)
- Boards: project (`Board`), profile (`ProfileBoard`, all the profile's tasks across projects and hosts plus scratch tasks), group (`GroupBoard`), legacy subproject (`SubprojectBoard`) in `Board.tsx`; all render `TaskBoard`.
- Four views (`taskBoard/model.ts` `VIEWS`): `board` (kanban, a column per status), `list` (sections, with an Archived section), `triage` (`TriageView.tsx`), `graph` (`GraphView.tsx`).
- Columns: `todo, in_progress, needs_attention, in_review, ready_for_merge, done, backlog` (backlog drawn first, collapsible); per-host gating of `ready_for_merge` (API 4) and `backlog` (API 5).
- Archive: done for 2 days (`ARCHIVE_AFTER_MS`) leaves the kanban Done column for the list view's Archived section; re-evaluated every 60 s (`useClock(60_000)`).
- Filters (statuses, kinds, projects, flags), search (lists matches, doesn't filter: HA-306) and sort (`boardQuery.ts`, `useBoardQuery.ts`); manual order by `position`, ties by `created_at` (`taskOrder.ts` `dropPosition`).
- Drag and drop with native HTML5 DnD (`useBoardDrops.ts`): MIME types `text/task-id`, `text/stack-id`, `application/x-huntaway-doc`; optimistic move with rollback; moving a fresh task into In progress also sends the empty message that starts its agent (`moveTask` in the client).
- Confirmations before a move: unfinished todo list (`ConfirmTodos`, API 148 `todos_override`), unmerged work on Done (`ConfirmDone`, `api.unmerged`).
- Cards (`TaskCard.tsx`): status, run state, waits, review, checks, preview dot, PR and branch icons, progress of subprojects and plan-created tasks.
- Stacks (`stacks.ts`, `StackCard.tsx`, `StackedOn.tsx`, `useBoardStacks.tsx`): gathered or spread, per stack; merge a whole stack by dropping on Ready for merge (`api.mergeStack`, API 153).
- Merges-into trees (`MergesInto.tsx`), dependencies (`Dependencies.tsx`), fan-out of one prompt (`Fanout.tsx`), pending permission prompts answerable from the card (`PendingPrompts.tsx`).
- Pens (`Pens.tsx`, `pens.ts`): a profile's named task sets as tabs and lanes, merged across hosts by name; lasso multi-select (`Lasso.tsx`, `lasso.ts`, `selection.ts`).
- Narrow layout shows one column at a time (`useBoardColumn.ts`), touch gets a move menu instead of drag.

### 2.5 Task view (`components/task/`, 66 files)
- `TaskView.tsx`: four modes (`page`, `panel`, `expanded`, `modal`), tabs (thread, details, changes, documents per label, terminal, each terminal tool, memory, brief, routines, workflows…), opening tab chosen once (`openingTab.ts`), terminals stay mounted after first visit, browser pane and desktop view beside it.
- Thread (`Thread.tsx`, `thread/`): item list with stick-to-bottom, older pages on scroll, subagent threads, tool calls, markdown (`react-markdown` + `remark-gfm` + task-key links `taskRefs.ts`), background-work banner, composer.
- Composer (`thread/Composer.tsx`): draft per task in localStorage, attachments (paste/drop/upload, ≤ 10 MB), `@` reference completion, skill menu (`/`), permission-mode cycle (Shift+Tab), model/effort, queued and steering messages, unqueue, line comments from Changes go with the message, sends survive the composer unmounting.
- Prompts: permission cards (`Approvals.tsx`), questions and plans (`Questions.tsx`), project/deletion/automation/workflow approvals as a global dialog (`ProjectApprovals`), approval rules and action log.
- Review and reviewers, summaries, context window breakdown, turns/checkpoints and rewind (`turns.ts`, `Rewind.tsx`), reminders and stars, external links (Asana), attachments.
- Documents (`Document.tsx`): plan/artifact/diagram versions in a sandboxed iframe (`htmlFrame.ts`, `planTheme.ts/.css`), mermaid, plan form answers kept as a draft (`planAnswers.ts`).
- Terminal (`Terminal.tsx`): xterm.js over its own websocket; worktree setup log; workflows runs; assistant page, memory editor, brief, routines, Telegram, Google card; browser pane (`<webview>`, shell only); computer-use desktop view.

### 2.6 Changes (`components/changes/`, 21 files)
- Diff view of a task's worktree (unified/split), git status tree, stage/unstage/discard/commit/amend/reword/stash/reset/apply hunks (`git/use*.ts`), keyboard-driven (`useGitKeys.ts`, `?` lists keys).
- Line comments for the agent (`lineComments.ts`, kept in localStorage), syntax highlighting by Shiki in a web worker (`highlight.ts`, `highlight.worker.ts`), Compare view of fan-out tasks (`Compare.tsx`, lazy chunk).

### 2.7 Settings (`components/settings/`, 95 files)
- `/settings/<tab>` tabs: `hosts`, `configs` (Agent configs), `profiles`, `assistant`, `tools` (Skills and MCP), `notifications`, `shortcuts`, `archived`, `server`, `network`.
- `/p/<id>/settings/<tab>` tabs: `general`, `agents`, `worktrees`, `review`, `prompts`, `scripts`, `tools`, `automations`, `workflows`.
- Host page (`HostPage.tsx`), server status/restart/update/rollback/release checks (`Server.tsx`), devices pairing with QR, telemetry, usage, disk usage, analytics (time tracking, token stats, context stats), workflow graph editor (`workflows/`), automations editor, GitHub repo picker, new-project dialog and directory picker, onboarding, token screen, in-app guide (`Guide.tsx`, `guide.ts`, renders `docs/guide/*.md`).
- New-UI-build detection (`uiVersion.ts`): refetches `/` and compares the entry script's hashed name.

### 2.8 Layout (`components/layout/`, 45 files)
- Sidebar: profiles with status bars, one active profile's projects (grouped, pinned, favourite, hidden), starred tasks, reminders, usage, Agents pill, connection state; drawer in the narrow layout.
- New task dialog (`NewTaskModal.tsx`, `newTask/`): one description field with tokens (`taskTokens.ts`: `/plan`, `in:KEY`, `!model`, `^effort`, `#dep`, `from:`, `into:`), `!` harness tokens make several tasks from one prompt (`harnesses.ts`), draft per project in localStorage, remembered model/effort/config/start per project.
- Page shortcuts (`usePageShortcuts.ts`), notification settings panel, unhandled-rejection toast (10 s), title dialog.

### 2.9 Docs (`components/docs/`, 25 files)
- A profile's published documents: folder/label tree, versions, pages in a sandboxed frame under a CSP (`docFrame.ts`, rendering by `@dire-kiwi/docs-render` on the host), images fetched and inlined as `data:` URLs, comments on selected text, hosted-docs connection (`HostedDocs.tsx`).

### 2.10 Notifications
- In-page (`notifier.ts`, `notifications.ts`): system `Notification`s and a two-note chime, from one leader tab; attention count in title, favicon badge and shell badge.
- Web Push (`push.ts`, `public/sw.js`): subscribe/unsubscribe/resend; service worker shows pushes with Allow/Deny actions.

### 2.11 Client package (`packages/client/src/`): section 8. Electron shell (`apps/web/electron/`): section 9.

## 3. Data

### 3.1 Wire types
All wire types are the server's own files, imported **by relative path** from `apps/server/src/wire/*.ts` and
`apps/server/src/threads/protocol.ts` (type-only except `protocol.ts`'s reducer and `agent/approval_rules/rules.ts`'s
`decide`). The client re-exports them, widened for older hosts:
- `Since<T, K> = Omit<T, K> & Partial<Pick<T, K>>`: fields that came with a later API are optional.
- `Task` (`tasks.ts`): `wire.Task` plus `host_id` (added by the hub and by the store's `tag`), 42 "later fields" optional, `kind` also `"scratch"`, `task_type` also a document type.
- `Host` (`hosts.ts`): `id, name, local, connected, mode: local|outbound|inbound|ssh, agents?, url?, version?, api_version?, api_compat?, capabilities?, commit?, updates_from?, last_seen?, last_message_at?, uplink?`.
- `HostSettings`, `Profile`, `Project`, `ClaudeConfig`, `Usage`, `Pen`, `Approval` and so on: as the server's, plus `host_id` where the store tags them.
- `BoardEvent = (HostEvent & {host_id}) | HubEvent` (`wire/events.ts`).

### 3.2 Thread model (client side)
- `ItemThread = { snap: Snapshot | null; loading: boolean; failed: boolean }` (`itemThreads.ts`); `WINDOW_ITEMS = 300`, `PAGE_ITEMS = 200`.
- `ThreadModel = { items: Item[]; results: Map<callId, ToolResult>; subagents: Map<id, Subagent>; callParent: Map; lastSent: number; childItems: Map<id, Item[]> }` (`threadModel.ts`).
- `Item` is one of `user | event | permission | question | text | thinking | tools | result | compact | report`, each with a stable `key` (`legacy:<message id>[:<block>]` becomes `<id>[.<block>]`).
- Thread commands sent by prompt cards: `{type: "respond", request_id, resolution}` through `POST /tasks/:id/thread/commands` (`threadView.ts`). Permission modes map `default|acceptEdits|auto|plan|dontAsk|bypassPermissions` → `default|accept_edits|auto|plan|dont_ask|bypass`.

### 3.3 Browser storage (all keys; `localStorage` unless marked)
Sign-in and cross-tab coordination:
- `ia.token`: the board token.
- `ia.openBoard`: `"1"`/`"0"`, whether this board handed out its token last time (client `http.ts`).
- `ia.movedHere`: `{ "<host>:<task>": {status, at} }`, moves made in this browser in the last 15 s (suppresses own-move notifications across tabs; client `tasks.ts`).
- `ia.notifyLeader`: `{tab, at}` heartbeat when `navigator.locks` is missing (2 s beat, stale after 6 s).
- `ia.focusedTask`: `{tab, task}`, the task open in the browser's focused tab.
- `ia.push.endpoint`: the push subscription endpoint last sent to the board.

Preferences:
- `ia.notifications`: `{mode: off|notify|sound|both, events: {attention, review, merge, done}, count}`; default `off`, `{true,true,false,false}`, `true`.
- `ia.shortcuts`: only the changed keys, `{[ShortcutId]: key}`.
- `ia.tint`: last shown profile tint (hex).
- `ia.activeProfile`: profile name.
- `ia.collapsedGroups`, `ia.hiddenProjects`, `ia.pinnedProjects`, `ia.favoriteProjects`: JSON arrays of keys (`projectGroups.ts`).
- `ia.sidebar.collapsedSections`: JSON array. `ia.usageOpen`: `"0"|"1"`.
- `ia.boardView`: `board|list|triage|graph`. `ia.board.sort`. `ia.board.backlog`: `open|closed`. `ia.board.archived`: `open|closed`.
- `ia.board.column.<boardKey>`: the column shown in the narrow layout.
- `ia.board.stacks`: `gathered|spread`; `ia.board.stackViews`: per-stack overrides (JSON).
- `ia.triage.closed`: JSON array. `ia.pen.<profile>`: the open pen tab; `ia.pen.collapsed.<profile>`: collapsed lanes.
- `ia.changes.layout`: `split|unified`; `ia.changes.tree`: `tree|flat`; `ia.compare.mode`: `one|side`.
- `ia.details.collapsed`: `{section: bool}`; `ia.details.trackedHideDone`: `"0"|"1"`.
- `ia.docs.view`; `ia.docs.closedFolders:<host>:<profile>` and `ia.docs.closedLabels:<host>:<profile>`; `ia.docComments`: `"0"|"1"`.
- `ia.analytics.{tab,preset,custom,calMode,rules}`: each `{value: …}` (`usePersisted.ts`).
- `ia.newProjectSource`; `ia.browserShare`: the browser pane's width share (number as string).
- New task: `ia.newTask.project` (last project), `ia.newTask.addAnother`, `ia.newTask.model.<project>`, `ia.newTask.effort.<project>`, `ia.newTask.claudeConfig.<project>`, `ia.startAgent.<project>` (`"1"`).

Drafts (user work that must not be lost):
- `ia.composer.draft.<host>:<task>`: `{text, files: AttachmentRef[]}`.
- `ia.newTask.draft.<project or subproject id>`: `{v: 2, description, files, links, fanout?}`.
- `ia.review.<host>:<task>`: line comments and half-written ones (`lineComments.ts`); other tabs follow by `storage` events.
- `ia.planAnswers:<host>:<task>`: answers to a plan's form fields.
- `ia.briefRatings:<host>:<task>`; `ia.browser:<host>:<task>`: the browser pane's last URL.

`sessionStorage`:
- `ia.board.query.<boardKey>`: a board's filters `{statuses, kinds, projects, flags}` (only while filtering); `boardKey` is e.g. `project:<host>:<project>`.
- `ia.openTools`: terminal tools open in this tab, `[{hostId, taskId, toolId}]`.

No IndexedDB, no Cache Storage, no BroadcastChannel. Cross-tab sync is by `storage` events and one Web Lock (`ia.notifications`).
Every storage read and write is wrapped for browsers that block storage: the fallback is a per-page variable.

### 3.4 Files
- `apps/web/public/`: `manifest.webmanifest`, `sw.js`, `icon.svg`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png`, `badge-96.png`.
- `apps/web/src/assets/SymbolsNerdFontMono-Regular.ttf` (terminal glyphs). `apps/web/build/icon.png` (packaging).
- Build output `apps/web/dist/`, copied into the server package as `ui/`.
- Shell files on disk: section 9.4.

## 4. In-memory state (the seam between components and logic)

### 4.1 The board store: `useStore` (`store.ts`, zustand `create<State>`)
Fields:

| Field | Type | Meaning |
|---|---|---|
| `authed` | `boolean \| null` | null until the first `hosts` answer; false after a 401 with no replacement token |
| `connected` | `boolean` | the websocket is open |
| `loaded` | `boolean` | projects and tasks have been fetched once (`refreshProfileData` finished) |
| `hosts` | `Host[]` | from `GET /hosts`, the local one included |
| `localHostId` | `string \| null` | the host with `local: true` |
| `profiles` | `Profile[]` | every board host's, tagged `host_id`; merged across hosts **by name** in the UI |
| `claudeConfigs` | `ClaudeConfig[]` | every host with API ≥ 20, tagged |
| `projects` | `Project[]` | unarchived, tagged, sorted by `sortProjects` (name, case-insensitive, numeric; then host, id) |
| `archived` | `Project[]` | archived projects (API 46); their tasks are not loaded and their task events are dropped |
| `tasks` | `Record<id, Task>` | every profile's tasks and review threads, by **bare task id** |
| `restart` | `{phase, error, log[]} \| null` | local host restart/update progress; log capped at 2000 lines |
| `hostSettings` | `Record<hostId, HostSettings>` | agent defaults per host |
| `usage` | `Record<"<host>:<config or profile id>", Usage>` | |
| `approvals` | `HostApproval[]` | pending project/deletion/automation/workflow approvals of every host, oldest first |
| `pens` | `(Pen & {host_id})[]` | |

Actions: `setAuthed`, `loadAll`, `loadProfiles`, `refreshProfileData`, `refreshHost(hostId)`, `loadHostSettings(hostId)`,
`loadUsage(refresh?)`, `loadApprovals(hostId)`, `upsertTask`, `upsertProject`, `removeProject`, `loadPens(hostId, profileId)`,
`upsertPen`, `removePen`.

Exported selectors and helpers: `defaultAgentHost()`, `scratchHost(profileName)`, `availableConfigs`, `taskConfig`,
`useAvailableConfigs`, `profileConfigLabel`, `profileNames`, `profileNameOf`, `useProfileName`, `useProject`, `useHost`,
`isGroupTask`, `usageKey`, `usageId`, `newest(key)`, `retryAfter(failures)`, `changed`, `otherHosts`, `approvalsLoading`.

Load sequence:
1. `loadAll`: `GET /hosts` → `set({hosts, localHostId, authed: true})` → `loadProfiles()` and `loadHostSettings(local)` in parallel.
2. `loadProfiles`: for each board host, `GET /h/<h>/profiles` and (API 20) `/claude-configs`; a host whose request fails keeps the profiles it had. Then `loadUsage()` (not awaited) and `refreshProfileData()`.
3. `refreshProfileData`: for each board host, `refreshHost`, `loadHostSettings`, `loadApprovals` in parallel; then drop projects, archived, pens, tasks and approvals of hosts that are gone; `loaded: true`; `catchUpItemThreads()`.
4. `refreshHost(h)`: per profile, `projects`, `groupTasks` (with assistant, pens thread, pen threads by capability), archived projects (API 46), `pens`; then per project `projectTasks(kind=task)` and (API 12) `kind=review`. A 404 for a project's tasks counts as empty.

"Board hosts" = `(local && connected) || usableHost`; `usableHost` = connected, `agents !== false`, compat `ok|outdated`.

Module-level bookkeeping (outside the store, in `store.ts`):
- `allLoads {running, queued, started, applied}`: at most one `loadAll` runs and one is queued; the queued one starts when the running one ends or after `LOAD_ALL_WAIT_MS = 2000`, whichever is first. Answers apply in start order.
- `profileLoads {started, applied}`: an older profile list that lands later is dropped.
- `refreshes: Map<host, {started, applied, failures}>`: same for a host's refresh; failed refresh retries after `retryAfter(n) = min(60 s, 2 s × 2^(n-1))` if it is still the latest and the host is still a board host.
- `hostLoads: Map<host, Set<{tasks:Set, projects:Set, gen}>>`: ids changed by events (or by a newer refresh) while a list was loading; the loaded copy of such a task is taken only if its `updated_at` is newer than the store's, and a delete stays deleted.
- `loadGens` / `newest(key)`: latest-wins guard for `settings:<h>`, `usage`, `pens:<h>:<profile>`.
- `approvalsLoading` (`approvals.ts` `approvalLoads()`): merges approval changes seen during a list load into the list; only the latest load's list counts.
- `collisions`: task-id collisions between hosts already warned about.

How components subscribe: `useStore(selector)` with inline selectors (241 calls in 87 component files), `useShallow` for
derived arrays, memoised picker closures for large derived lists (`useBoardTasks`), `useStore.getState()` inside event
handlers (48 uses in 28 files). There is no selector library and no normalised cache beyond `tasks` by id.
Most selected fields: `hosts` 42, `profiles` 36, `projects` 16, `tasks` 15, `hostSettings` 14, `claudeConfigs` 9.

### 4.2 Other zustand stores
- `useItemThreads` (`itemThreads.ts`): `{threads: Record<taskId, ItemThread>, missing: Record<taskId, true>}`. Beside it, `live: Map<taskId, {host, views, held, gen, preview}>` (ref-counted viewers, events held during a load, load generation, streaming preview position).
- `useDeltas` (`deltas.ts`): `{deltas: Record<taskId, string>}`; `watching` ref counts and `pending` tokens flushed once per animation frame.
- `useSelection` (`selection.ts`): lasso-selected task ids.
- `useOpenTools` (`terminalTools.ts`): open terminal tools, mirrored to sessionStorage.
- `useSubagentFocus`, `useSubagentView` (`subagents.ts`): which subagent a thread reveals or shows in full.
- `useDrawer` (`narrow.ts`): the narrow layout's sidebar drawer.
- `useRuns` in `components/task/Workflows.tsx`: workflow runs by `"<host>:<task>"`, with a module-level `onWorkflowsChanged` subscription.

### 4.3 `useSyncExternalStore` sources (hand-rolled)
`router.ts` (URL), `narrow.ts` (media queries), `shortcuts.ts` (keys), `ui/time.tsx` (one shared 1 s clock while anything
shows a timer), `ui/preview.ts` (preview pollers), `lineComments.ts` (review comments).

### 4.4 Module-level caches inside feature code (not reset by anything)
`agents.ts` (Codex models per config), `attachments.ts` (object URLs, ref-counted), `docs.ts` (doc images by sha),
`itemModel.ts` (`made` WeakMap per item, `models` per task), `Composer.tsx` (`pageDrafts`, `sending`, `sendWatchers`,
`composerFills`), `Memory.tsx` (drafts, saving, conflicts, editors), `Reminders.tsx` (`inFlight`), `SkillMenu.tsx`
(60 s cache), `Desktop.tsx`, `DocLink.tsx` (titles), `GithubRepos.tsx` (lists), `TriageView.tsx` (`lastWords`),
`highlight.ts` (results and worker requests), `Document.tsx` (`answersSending`), `Questions.tsx` (`keyed` cards for digit keys).

### 4.5 What survives a reload
Only browser storage (3.3). Everything else is refetched: the store by `loadAll` on socket open, threads by window.

## 5. Outside the process

### 5.1 Web app
- HTTP: `fetch` to same-origin `/api/...` with `Authorization: Bearer <token>`; `GET /` (no-store) for the new-build check.
- Websockets: `/api/ws?token=` (board events); `/api/h/<host>/tasks/<id>/terminal/ws?cols=&rows=&tool=&token=` (terminal).
- Web worker: `components/changes/highlight.worker.ts` (Shiki; ES module worker).
- Service worker: `/sw.js` (not in the shell, not on insecure origins).
- Browser APIs: Notification, Web Locks, Web Audio, Push, `visualViewport`, `ResizeObserver`, Clipboard, `matchMedia`, `<webview>` (shell).
- Iframes: sandboxed `srcdoc` frames for plans/artifacts and docs pages, talking by `postMessage` (`iaInset`, `iaScroll`, `iaHtmlHeight`, `iaForm`, link-follow requests); page CSP `frame-src 'self'`.
- Dev: Vite on 5173 proxying `/api` (with `ws: true`) to `IA_SERVER ?? http://127.0.0.1:7878`.

### 5.2 Electron shell (binaries, env, ports)
- Spawns the server: `<bin> serve --port <port> [--data-dir <dir>] [--host <host>]`, stdio piped; reads `IA_READY {"token"}` and `IA_BACKUP_FAILED {reason, why, dir}` from stdout.
- Other processes: login shell `-ilc` to read `PATH` (5 s), `pacman -Qqo` (5 s), `pkexec pacman -U --noconfirm <file>`.
- HTTP: `GET <base>/api/health`, `GET <base>/api/admin/server`, GitHub releases API (`IA_RELEASE_API` or `https://api.github.com`, repo `IA_RELEASE_UPDATES` or `dire-kiwi/huntaway`), asset download.
- Env read: `IA_PORT`, `IA_DATA_DIR`, `IA_SERVER_BIN`, `IA_DEV_URL`, `IA_PACKAGED_RESOURCES`, `IA_RELEASE_UPDATES`, `IA_RELEASE_API`, `APPIMAGE`, `HUNTAWAY_LAUNCHER`, `SHELL`, `PATH`, `XDG_DATA_HOME`, `APPDATA`.
- Env set for the server: `IA_RELEASE_UPDATES`, `IA_DESKTOP_VERSION`, `IA_DESKTOP_SHELL` (frame stamp), `IA_DESKTOP_INSTALL`, `IA_BUNDLED_SERVER`, `IA_SKIP_DB_BACKUP`, `IA_SKIP_DB_BACKUP_ONCE`.
- Port 7878 by default.

## 6. Background work (timers, retries, polling)

Websocket and loads:
- Reconnect backoff `500 ms × 2^retry`, `retry` capped at 6 (1 s … 32 s); reset on open. Not retried while `authed === false`.
- Watchdog: after the first `tick` (server sends one every 25 s), 60 s of silence (`SILENCE_MS`) closes and reopens the socket. A server that never sends `tick` is never timed out.
- `reconnectNow()` on `online` and `visibilitychange`: drops a quiet socket by the clock, or cuts a pending backoff short.
- `loadAll` coalescing 2 s; host refresh retry 2 s doubling to 60 s.
- Thread retention `KEEP_MS = 10 s` after the last viewer leaves.
- Deltas flushed once per animation frame (16 ms timeout fallback).

Polling by components (all hand-rolled `setInterval` in `useEffect`):
- Git status 4 s while visible and not busy, plus on focus (`useGitStatus.ts`).
- Preview URL up-check 2 s per URL, at most 2 in flight, paused while hidden (`ui/preview.ts`, HA-188).
- Worktree setup recheck 3 s. Desktop view frame 700 ms, ops 3 s.
- Usage 5 min (+ 30 s clock). Devices 3 s (+ 1 s clock). Telemetry 15 s.
- Server panel: status `pollMs`; threads rebuild 1 s while running else 15 s; restart watch loop.
- Host page: 1.5 s while watching an update, 3 s while downloading, 10 s or 30 s otherwise. Host row and desktop-driver install: 1 s or 15 s.
- New UI build check: on mount, on focus, on reconnect, every 5 min.
- Terminal tool keepalive every 30 s (`POST …/terminal/keepalive`).
- Shared clock 1 s (`useClock(step)`), board archive check at 60 s granularity.

Notifications:
- "Ready to review" waits `REVIEW_GRACE_MS = 5 s` and re-checks. Chime at most once per second. Leader heartbeat 2 s.
- Service worker registration wait capped at 5 s.

Terminal socket: reconnect `min(250 ms × 2^n, 2 s)`, up to 6 tries, retries reset after 5 s open; close code 1000 = ended,
1011 = error; flow-control acks `{type:"ack", bytes}` every 32 KiB or 5 ms; answers `ping` with `pong`.

Shell timers: section 9.5.

## 7. Surface: routes and URLs (`router.ts`)

Hand-rolled History API router: `parse(path) → Route`, `href(route)`, `navigate(route|url, replace?)`, `onNavigate`,
`useRoute()`, one `popstate` listener. Unknown paths parse to `home`.

| URL | Route | Shows |
|---|---|---|
| `/` | `home` | redirects (replace) to the active profile's board once loaded |
| `/profile/<name>` | `profile` | `ProfileBoard` |
| `/assistant/<name>` | `assistant` | `AssistantPage`, full width |
| `/docs/<profile>` | `docs` | the profile's document list |
| `/docs/<profile>/d/<slug>/[-/v/<n>/][<page…>]` | `docs` | a document's page; `<profile>` may be a name or a profile id (agents' links) |
| `/p/<projectId>` | `board` | `Board` |
| `/p/<projectId>/settings[/<tab>]` | `projectSettings` | `ProjectSettings` |
| `/g/<hostId>/<group>` | `group` | `GroupBoard` |
| `/t/<taskId>` | `task` | `TaskView` as a page; redirects to the task's board with `?task=` once its place is known |
| `/t/<taskId>/board` | `subproject` | `SubprojectBoard` |
| `/settings[/<tab>]` | `settings` | `Settings` |
| `/analytics[/<profile>]` | `analytics` | `Analytics` |
| `/guide[/<page>]` | `guide` | `Guide` |
| `/hosts/<hostId>` | `host` | `HostPage` |

Query parameters, valid on any path:
- `?task=<id>`: the task open in the side panel (`usePanel`), only drawn on `board`, `group`, `profile`, `subproject` (`hasPanel`). `&expanded`: as a dialog. `&compare`: the Compare view over the page.
- `?modal=<id>`: a task in a dialog over any page, beside the side panel's task (HA-326).
- `?token=<t>`: captured and stripped at boot.

Rules:
- `openTask(id)`: on a panel page, sets `?task=` keeping `expanded`; elsewhere navigates to `/t/<id>`.
- `/t/<id>` redirect targets (`App.tsx`): assistant → `/assistant/<profile>`; routine thread → stays; group task → `/g/<host>/<group>?task=`; scratch task → `/profile/<name>?task=`; subproject child → `/t/<sub>/board?task=`; else `/p/<project>?task=`.
- History state keeps `{from}` (where the user came from) for the docs page's back link; moves within one document keep the earlier `from`.
- Segments are `decodeURIComponent`-decoded; a malformed escape is kept as is.
- Deep links from outside: push notifications (`/…` path or `open-task` message), agents' doc links, the shell's `openWindow(path)`.
- Multi-window: each tab or shell window is an independent app instance with its own socket and store. The window title is `<profile> · Huntaway` when there are several profiles.

Keyboard shortcuts (`shortcuts.ts`), changeable: `p`/`P` next/previous profile, `a` assistant, `/` search, `j`/`k`
triage next/previous, `]`/`[` compare next/previous. Fixed: Esc, Ctrl/⌘+Enter submit, 1–9 answer the latest question
card (or go to a task in Compare), Enter in triage, arrows in Compare, `?` in Changes. A shortcut fires only when
`forPage(e)`: no modifier, target not in a field, no `[data-modal]`/`[data-task-modal]` open.

## 8. The client package (`packages/client/src/`, 30 files, 3,313 lines)

### 8.1 Adapter and `Http` (`http.ts`)
```ts
interface KeyValueStorage { getItem(key): string | null; setItem(key, value): void }   // may throw
interface FetchResponse { ok: boolean; status: number; statusText: string; json(): Promise<any> }
type Fetch = (url: string, init: { method: string; headers: Record<string,string>; body?: string }) => Promise<FetchResponse>
interface ClientAdapter {
  baseUrl: string;              // "" for the board that served the page
  getToken(): string; setToken(token: string): void;
  storage: KeyValueStorage;     // per board
  wsBase?: () => string;        // default: baseUrl with http→ws
  fetch?: Fetch;                // default: globalThis.fetch, looked up at call time
}
class ApiError extends Error { status: number }
```
`createHttp(adapter)` returns `{ storage, getToken, setToken, isOpenBoard, shouldFetchOpenToken, fetchOpenToken,
setUnauthorizedHandler, request, get, post, patch, del, on, wsUrl }`:
- `request(method, path, body?)`: `fetch(baseUrl + "/api" + path)` with `Authorization: Bearer <token>`; JSON body and `Content-Type` only when `body !== undefined`; `post` defaults the body to `{}`.
- 401: calls `onUnauthorized(tokenUsed)` and throws `ApiError(401, "Unauthorized")`. Only this board's own token being wrong is a 401; the hub answers a linked host's rejection with 502.
- Other non-2xx: `ApiError(status, body.error ?? statusText)`. A body that isn't JSON is `null`.
- No timeout, no retry, no abort signal, no request de-duplication (except `fetchOpenToken`, which shares one in-flight call).
- `on(h)`: the same four verbs under `/h/<encoded host>/…`. **Hosts are addressed by a `hostId` first argument on almost every call, routed through the hub; there is one client per board, not per host.** Hub-only calls (`hosts`, `addHost`, `push*`, `devices`, `pairingCode`, `previewStatus`…) take no host.
- `wsUrl(path = "/ws")`: `<wsBase>/api<path>?token=<token>` (token in the query).

### 8.2 `createClient(adapter)` (`index.ts`)
Spreads every resource's functions into one flat object (`api.updateTask(h, id, …)`), plus the token functions and
`wsUrl`. The web app makes one (`api/index.ts`, `baseUrl: ""`, token in `localStorage["ia.token"]`, `wsBase` from
`window.location`) and re-exports the package. Package exports: `.`, `./labels`, `./protocol`.

### 8.3 Resource files and call counts (about 225 calls)

| File | Calls | What |
|---|---|---|
| `tasks.ts` | 30 | create (project, scratch, group), list (`profileTasks`, `groupTasks`, `projectTasks?kind=`), `task`, `updateTask`, `deleteTask`, stacks, merge target, attachments, background/servers stop, unqueue, wait-for-limit, review, summary, fix checks, worktree setup/teardown, fan-out, `unmerged`, `document`; plus `movedHere` (local) |
| `agentTools.ts` | 20 | skills, MCP servers (project and global), switches, skill sources, `taskSkills` |
| `docs.ts` | 20 | documents, versions, folders, labels, images, comments, hosted docs |
| `server.ts` | 17 | telemetry, settings, settings sync, status, restart, releases, DB recopy, service install, threads rebuild |
| `thread.ts` | 16 | permissions, messages (legacy), `send`, `stop`, turns, rewind, context, `resolvePermission`, `thread`, `threadItems`, `threadEvents`, `threadCommand`, `answerQuestion` |
| `hosts.ts` | 14 | hub's hosts (add, rename, uplink, remove, update, ssh, join, discover, copy config), `previewStatus`, `info`, `dirs` |
| `assistant.ts` | 13 | assistant thread, memory files (list, read, write, history, restore, import), Google status, brief and feedback |
| `git.ts` | 12 | `diff`, status, diff, show, stage, unstage, discard, apply, commit, stash, reset |
| `projects.ts` | 12 | CRUD, clone, GitHub create, setup thread, merged worktrees, default prompts, branches, system prompt preview |
| `automations.ts` | 8 | automations and routines CRUD, run, runs |
| `desktop.ts` | 8 | **computer-use driver** on a host (not the Electron shell): status, enable, install, frame |
| `workflows.ts` | 7 | CRUD, run, task runs, stop run |
| `claudeConfigs.ts` | 6 | CRUD, models, `usage` |
| `devices.ts` | 6 | `health`, devices, pairing code, pair, rename, revoke |
| `pens.ts` | 6 | CRUD, pens thread, pen thread |
| `push.ts` | 6 | `push` (public key + subscriptions), subscribe (web, Expo), update, remove, test |
| `profiles.ts` | 5 | CRUD, Asana tasks |
| `analytics.ts` | 5 | analytics, context stats, token stats, disk usage |
| `telegram.ts` | 4 | get, set, link, unlink |
| `terminal.ts` | 4 | `terminalWsUrl`, status, kill, keepalive |
| `approvalRules.ts` | 3 | rules get/set, log (re-exports the server's `decide`) |
| `github.ts` | 2 | accounts, repos |
| `approvals.ts` | 1 | `projectApprovals` (`?all=true&automations=true&workflows=true`) |
| `attachments.ts`, `labels.ts`, `events.ts`, `protocol.ts`, `globals.d.ts` | 0 | helpers and re-exported types |

Uploads and downloads are JSON with base64 (`uploadAttachment(h, name, data)`); there is no multipart and no streaming.

### 8.4 Domain logic that lives in the client (must not be lost)
- Version gates: `hostSupports(host, minApi)` (true for the local host; API numbers stopped at 153) and `hostHas(host, capability)` for anything newer; `hostCompat` (`ok|outdated|incompatible|board_outdated`), `UI_API_VERSION = 24`, `UI_MIN_HOST_API = 0`; about 40 exported `*_API` constants.
- Host predicates: `canRunAgents`, `usableHost`, `boardHosts`, `hostStatuses`.
- Task predicates: `mergeQueued`, `mergeAwaitsApproval`, `rejoinsMerge`, `agentWaiting`, `backgroundIdle`, `agentWorking`, `dependencyQueued`, `limitQueued`, `outOfUsage`, `isMerged`, `isArchived`, `readyToCheck`, `heldTodos`, `runningAgentSteers`, `isScratch`, `isSummaryThread`, `isWorkflowThread`, `isAssistant`, `isRoutine`, `trackedStatus`, `prChecks`, `failedChecks`, `summariesOf`.
- Keys: `keyPrefix` (project key, `G` group, `S` scratch/pens, `A` assistant/routines, `T`), `taskKey`.
- `moveTask(api, task, status, host, fields)`: `updateTask` then, for a fresh task moved into In progress on a host that can run agents, `send(…, "")`.
- `updateTask` notes the move in `ia.movedHere` **before** the request (the task event reaches every tab before the response).
- Attachments in messages: `withAttachments`, `splitAttachments` (the `Attached files:` block), `afterSend`.
- Constants: `STATUSES`, `PERMISSION_MODES`, `NOTIFY_EVENTS`, `LABELS`, `QUESTION_TOOLS`, `MAX_ATTACHMENT_BYTES = 10 MiB`, `ARCHIVE_AFTER_MS`.
- `assistantHome(profiles, hosts, name)`: which host a profile's assistant lives on.

### 8.5 Websocket
The client package only builds the URL. Opening, reconnecting and the watchdog are the app's (`apps/web/src/live.ts`;
the mobile app has its own `apps/mobile/src/live.ts`). There is no subscription message: the server sends every event
of every host, and the client filters. Messages are JSON `BoardEvent`s; the client sends nothing.

### 8.6 What `protocol.ts` shares with the server
`export * from apps/server/src/threads/protocol.ts`: the thread model types (`Snapshot`, items, requests, `ThreadEvent`,
`SavedEvent`, `DeltaEvent`, `ItemPage`, `Resolution`, `PermissionMode`) and the reducer both ends fold events with
(`apply_event`, `apply_events`, `is_gap`, `with_page`, `initial_state`, `item_page`, `snapshot_window`). The file has no
imports so every package's TypeScript settings accept it.

## 9. Electron shell (`apps/web/electron/`, CommonJS, 1,687 lines)

### 9.1 What it does
- **Frame and shell** (`boot.cjs`, package `main`): `boot.cjs` is the only shell file a release can't replace. It picks which `main.cjs` to `require`: the package's own (a checkout, remote mode, or release updates off) or `<dataDir>/app/<version>/electron/main.cjs` from the release the server unpacked.
- `chooseShell`: first of `state.json`'s `[trying, current, previous]` that is not in `bad`, is `>=` the app's version and has `huntaway`, `ia-shim`, `ui/index.html`. If that version's shell is in `shell-state.json.bad` or unusable (`shell.json.electron` major differs from the running Electron, or `shell.json.boot > 1`), the package's shell runs; it never falls back to an older version's shell.
- Crash marker: `shell-state.json.trying = {version, pid}` written before loading a release shell, cleared after 20 s or on quit; a marker left by a dead process marks that shell bad at the next start. A `require` throw marks it bad and relaunches.
- **Server** (`main.cjs`): `resolveTarget()` = remote (`desktop.json.serverUrl` + `token`, nothing spawned) → attach to a healthy server on the port (token from `<dataDir>/auth_token`) → spawn one. `healthy()` treats only `ECONNREFUSED` as "no server"; anything else is retried (10 tries, 1 s apart) and then reported as a foreign program on the port.
- Binary choice: `IA_SERVER_BIN` / `config.serverBin` → `versions.chooseServer` (installed release or the bundled one) → checkout `apps/server/bin/huntaway` → legacy Rust `server/target/{release,debug}`.
- `startWithFallback`: an installed version that exits before ready is skipped and the next tried; it is marked bad in `state.json` only once another server has come up. Never blamed: a 15 s ready timeout, a backup failure, a taken port, quitting, the bundled or overridden binary.
- Server lost after ready: restart with backoff 1/2/4/8/16 s; 5 stops in 5 minutes shows the error page.
- Quit: SIGTERM to a server it spawned, SIGKILL after 10 s, quit on its exit. A server it attached to is left running. Agents run under `ia-shim` and outlive the server.
- **Windows**: `BrowserWindow` 1440×900 (min 900×600), `contextIsolation`, `sandbox`, `webviewTag`, preload in sub-frames; loads `<base><path>?token=<token>`. Multi-window: File → New Window (CmdOrCtrl+Shift+N), `second-instance`, `openWindow(path)`, and board-origin `window.open`. A new window copies the focused one's size, offset 30 px. No bounds persistence, no tray, no protocol handler, no auto-launch.
- Relaunch restores windows from `<userData>/relaunch-windows.json` (paths; deleted on read); only the first window loads before the others are created, so one server starts (HA-298).
- Error page: a `data:` URL with the message, the last 40 stderr lines and the config path; Retry and "Start without a backup" are links to `https://retry.huntaway.invalid/` and `https://start-without-a-backup.huntaway.invalid/`, intercepted in `will-navigate`.
- Navigation: other origins never replace the board; `http:`, `https:`, `mailto:` go to the OS, everything else is dropped.
- Browser pane: `<webview>` allowed only when embedded by the board origin with an http(s) source; preload stripped; partition `persist:huntaway-browser`; permissions limited to `clipboard-sanitized-write` and `fullscreen`.
- WebRTC: `disable_non_proxied_udp` on every window; sub-frame preload deletes `RTCPeerConnection` (HA-269).
- Packaged, non-Windows: prepends the login shell's `PATH` so `claude`, `codex`, `git`, `gh` are found.
- `http:` `serverUrl`: `unsafely-treat-insecure-origin-as-secure` so notifications work.
- Single-instance lock (not with `IA_DEV_URL`); the loser quits via `setImmediate` so boot's `before-quit` handler clears its marker.
- Menu: app menu (mac), File, Edit, View, Window. Badge: `app.setBadgeCount`.
- The shell shows no notifications of its own; the web app uses the DOM `Notification` API.

### 9.2 Self-update (three layers)
1. **Shell code in place**: each release tarball carries `electron/*.cjs` and `electron/shell.json = {electron, boot: 1}`. After any window's `did-finish-load`, `shellChange` relaunches once if boot would now choose a different shell version, or (package/checkout shell) the directory's sha256 stamp changed.
2. **Server version**: `state.json {current, previous, staged, trying, bad[]}` is shared with the server; the shell only adds to `bad` (temp file + rename, keeping unknown keys). Release checks and downloads are the server's.
3. **Package ("frame")** (`shellupdate.cjs`, HA-68): only for AppImage and pacman installs. `GET /api/admin/server` must say `release.shell.outdated` and a strictly newer version; the asset is found on GitHub by exact name (`huntaway-<v>-linux-x64.pacman`, `huntaway-<v>-linux-x86_64.AppImage`) and must carry a `sha256:` digest; downloaded with flag `wx` into a fresh `mkdtemp`, hashed while streaming; AppImage is renamed over the old file, pacman is installed with `pkexec pacman -U --noconfirm`; then relaunch.
- `stamp.cjs`: `frameStamp` = sha256 over `boot.cjs` + Electron version (sent to the server as `IA_DESKTOP_SHELL`; compared with the release manifest); `shellStamp` = the same over every file in `electron/`.
- Relaunch uses `HUNTAWAY_LAUNCHER`, else `APPIMAGE`, as `execPath` when set.

### 9.3 IPC surface (`preload.cjs` → `window.huntawayDesktop`, main frame only)

| Member | Channel | Behaviour |
|---|---|---|
| `setBadgeCount(n)` | `huntaway:badge` (send) | dock/taskbar badge |
| `focus()` | `huntaway:focus` (send) | restore, show and focus the sender's window |
| `openWindow(path)` | `huntaway:open-window` (send) | new window at a board path; sender must be at the board origin, path must start with `/` |
| `browserPane: true` | n/a | capability flag for the `<webview>` pane |
| `shellUpdateKind()` | `huntaway:shell-update-kind` (sendSync) | `"appimage" \| "pacman" \| null` |
| `updateShell(onProgress?)` | `huntaway:update-shell` (invoke), progress on `huntaway:update-shell-progress` | resolves `{version}`, rejects with the reason; progress `{phase: checking\|downloading\|installing\|restarting, version?, bytes?, total?}`, download events at most one per 200 ms |

`updateShell` takes no arguments from the page: the version comes from the server and the package from GitHub.

### 9.4 Files
- `<appData>/huntaway/desktop.json` (read only; legacy `<appData>/issue-agent/`): `{port?, dataDir?, host?, serverBin?, serverUrl?, token?, skipDbBackup?}`.
- `<dataDir>/auth_token` (read), `<dataDir>/server_version` (written for Rust releases below 0.4.0), `<dataDir>/app/state.json`, `<dataDir>/app/shell-state.json` (`{bad[], trying: {version, pid}}`, the shell's alone), `<dataDir>/app/<version>/{huntaway, ia-shim, ui/, electron/}`.
- `<userData>/relaunch-windows.json`. Data dir default: platform app-data dir + `/huntaway` (falls back to `/issue-agent` if only that exists).
- Packaging (`package.json` `build`): `appId nz.net.ivan.huntaway`; asar holds only `electron/**`; `extraResources` copies `release-server/` (server, bundled Node, `ia-shim`, `ui/`); Linux AppImage + pacman, mac dmg + zip (ad-hoc signed); no Windows target, no `publish`.

### 9.5 Shell timers
Health probe 1 s timeout × 10 tries (3 for "port taken"); ready timeout 15 s; exit/close grace 500 ms; restart backoff
1–16 s in a 5-minute window; SIGKILL after 10 s; crash-marker survival 20 s; update: server 10 s, GitHub 30 s, download 30 min.

### 9.6 How the web app detects and uses the shell
Detection is `window.huntawayDesktop` (typed in `notifier.ts`; every member but `setBadgeCount` and `focus` is optional because older shells lack them).
- `notifier.ts`: badge count; `focus()` on notification click.
- `push.ts`: `pushSupport()` returns `"desktop"`; no service worker in the shell.
- `layout/sidebar/newWindow.ts`: "Open in new window" menu items when `openWindow` exists.
- `settings/Server.tsx` (`ShellNotice`) and `HostPage.tsx`: package update button when `shellUpdateKind()` equals the server's `release.shell.install`.
- `task/Browser.tsx`, `TaskView.tsx`: the browser pane when `browserPane` is true.
- `index.css` `.drag` / `.no-drag`: `-webkit-app-region` for title-area dragging.
- `api/index.ts` `captureTokenFromUrl()`: the sign-in hand-off.

### 9.7 Service worker and manifest
- `sw.js`: `skipWaiting` + `clients.claim`; **no fetch handler and no caching** (so a new UI build is never hidden).
- `push`: ignores a message without `title`; skipped if it has `task_id` and a window client is focused and visible; else `showNotification` with `tag`, `renotify`, and for a prompt (`answer`) the actions Allow/Deny and `requireInteraction`.
- `notificationclick`: an action posts `{token, decision}` to `answer.url` (a one-time token; the worker never holds the board token) and shows the result, re-showing the prompt on a retryable failure; otherwise focuses a client and posts `{type:"open-task", task_id}` or `{type:"open", url}`, or opens a window.
- `pushsubscriptionchange`: resubscribes with the old options.
- Manifest: name "Huntaway", `display: standalone`, `start_url` and `scope` `/`, colours `#0b0b0e`, four icons.

## 10. Events consumed (`live.ts` `handleEvent`)

`h = ev.host_id ?? localHostId`. Task-scoped events are dropped when the store already has that task id from another host.

| Event | Effect |
|---|---|
| `task {task}` | `upsertTask({...task, host_id: h})` (ignored if the profile isn't on the board, the project is archived, or another host owns the id); marks the id changed for loads in flight; then `liveTaskChanges` listeners get `(prev, next)` |
| `task_deleted {id}` | marks changed, deletes from `tasks` |
| `project {project}` | `upsertProject`: archived → moves to `archived` and drops its tasks; unarchived → back in `projects` and its tasks are refetched |
| `project_deleted {id}` | `removeProject` (projects, archived, its tasks) |
| `profiles_changed` | `loadProfiles()` (which refreshes every host) |
| `pens {profile_id}` | `loadPens(h, profile_id)` |
| `hosts_changed` | `loadAll()` |
| `usage {usage}` | sets `usage[usageKey(h, config or profile id)]` |
| `settings_changed` | `loadHostSettings(h)` |
| `automations_changed` | listeners `(h, project_id ?? null, automation_id, profile_id)` |
| `approval_rules`, `approval_log` | listeners `(h, profile_id, "rules" \| "log")` |
| `telegram`, `docs`, `doc_comments`, `docs_site` | their listeners `(h, profile_id[, slug])` |
| `workflows_changed`, `workflow_runs_changed` | workflow listeners `(h, {projectId})` / `(h, {taskId})` |
| `checkpoints {task_id}` | checkpoint listeners |
| `message`, `message_updated` | only when `message.kind === "permission"` and `data.kind ∈ {project, delete_task, automation, workflow}`: upserts or removes the approval (`workflow` is stored as `automation`); otherwise ignored |
| `thread_event {task_id, event}` | `onThreadEvent`: a `delta` feeds the streaming preview; a saved event is applied, held during a load, or triggers a catch-up on a seq gap |
| `thread_resync {task_id}` | fresh window for a watched thread; clears `missing` otherwise |
| `resync {host_id?}` | with host: `refreshHost`, `loadApprovals`, `catchUpItemThreads(host)`; without: `loadAll()` |
| `restart`, `restart_log` | local host only: `restart` state; `starting` clears the log |
| `tick` | handled in `connectEvents` (arms the silence watchdog) |
| `delta`, `delta_reset`, `assistant_reply`, `release_checked`, `release_download`, `hello` | ignored on purpose |
| anything else | ignored at run time; a declared kind without a case is a type error (`ev satisfies never`) |

On socket open: `connected: true`, then `loadAll()` (every time, to cover events missed while disconnected).
Events emitted: none over the socket. In-page: `storage` events between tabs; service-worker messages `open-task` / `open`.

## 11. Data fetching and mutation patterns in components

Counts (in `apps/web/src`, commands in 11.4):
- 103 of 298 component files call `api.*` (90 `.tsx`, 13 `.ts`); 279 call sites; 173 distinct client methods. Top-level helpers add 29 call sites in 8 files.
- So **most fetching is done directly in component files**, not behind hooks: of the 48 `use*.ts(x)` hook files only 12 call the API.

Patterns, all hand-written:
- **Load on mount**: `useState` for data and error, `useEffect` calling `api.x().then(setData)`, with a stale guard (`let live = true` or a `seq` ref): 65 guard lines in 41 files. Results are compared by `JSON.stringify` to keep identity when unchanged (`useGitStatus`, `useTurns`).
- **Reload triggers**: task fields in the dependency list (`task.running`, `task.worktree_state`, `task.session_id`), a `live.ts` listener (16 call sites), window `focus`, or polling (section 6).
- **Actions**: `useAsyncAction()` → `{busy, error, setError, run}` (18 uses in 14 files); elsewhere local `busy`/`err` state with `try/catch`. Errors render inline beside the action (`ErrorBox`, red text); there is no global toast except `UnhandledErrors`.
- **Confirmation**: `useConfirm()` / `ConfirmModal` (18 files).
- **Retry**: none automatic for requests; a failed thread window shows a retry button (`reloadItemThread`); host refresh retries with backoff.
- **Optimistic updates**: only where latency shows. Task moves and reorders (`useBoardDrops.dropTask`: `upsertTask` now, `api` calls, roll back on error), pens (`moveToPen`), reminders and stars (`Reminders.tsx` with an in-flight merge), restart state. Everything else writes the response into the store (`upsertTask(await api.…)`: 34 `upsertTask` and 16 `upsertProject` call sites) and relies on the websocket event for other tabs.
- **Field drafts**: `useDraft(value, hold)` follows the server value until edited; forms otherwise keep local `useState` copies and save on a button.
- **Persisted drafts**: composer, new task, line comments, plan answers (3.3); written in a `useEffect` on every change. No debouncing anywhere (`grep -i debounce` finds nothing).
- **Multi-host fan-out in helpers**: analytics, token stats, context stats, disk usage, docs and pens call every relevant host and merge client-side (`analytics.ts` `fromHosts`, `docs.ts` `docsHomes`, `pens.ts`). A profile is "the profiles of that name on every host".
- **Code splitting**: `lazy`/`preloadable` for Compare, Terminal, Changes, Memory, Brief, Routines, PatchBox; mermaid and Shiki grammars load on demand.
- **Context**: only 5 files use `createContext` (thread data, prompt answerer, turns, modal, diff lines). Props and the store do the rest.

### 11.4 Counts and the commands used (run in `apps/web/src`)
| What | Number | Command |
|---|---|---|
| `.tsx` files | 212 (210 in `components/`) | `find . -name '*.tsx' \| wc -l` |
| Files in `components/` | 298 (87 `.ts`, 1 `.css`) | `find components -type f \| wc -l` |
| Lines | 48,752 in `components/`, 6,197 top level | `… \| xargs cat \| wc -l` |
| Files importing the store | 115 (107 in `components/`, 93 of them `.tsx`) | `grep -rlE 'from "(\.\./)*(\./)?store"' …` |
| Files with `useStore(` | 87 (241 calls) | `grep -rlE 'useStore\(' components` |
| `useStore.getState` | 48 in 28 files | `grep -rnoE 'useStore\.getState' components` |
| `useStore.setState` in components | 5 (3 in `settings/Server.tsx` for `restart`, 2 in `settings/hosts/{TerminalTools,NearbyHosts}.tsx` for `hostSettings`) | same pattern |
| Files calling `api.` | 103 (279 call sites, 173 distinct methods) | `grep -rlE '\bapi\.[a-zA-Z]+' components` |
| `useEffect(` | 235 (225 in components, 112 files) | `grep -rnoE '\buseEffect\(' …` |
| `useLayoutEffect(` | 25 in 18 files | |
| `useState` | 720 incl. generic forms (350 plain `useState(` in 128 component files) | `grep -rnoE '\buseState(<[^>]*>)?\('` |
| `useReducer` | 0 | |
| `useSyncExternalStore` | 12 (6 in components) | |
| `useMemo` | 115 (103 in components, 50 files) | |
| `useCallback` / `useRef` | 43 / 125 | |
| `use*.ts(x)` files | 48 | `find . -name 'use*.ts' -o -name 'use*.tsx'` |
| Exported `useX` hooks | 137 | `grep -rhoE 'export (function\|const) use[A-Z]…'` |
| zustand stores | 9 | `grep -rnE '= create<'` |

Classification of component files by what they touch (store = any zustand store; api = `api.` or a helper that calls it):

| | Neither | Store only | API only | Both |
|---|---|---|---|---|
| All 297 `.ts/.tsx` | 149 (17,611 lines) | 41 (5,161) | 48 (9,042) | 59 (16,938) |
| `.tsx` only | 85 (11,460) | 31 (4,349) | 38 (8,218) | 56 (16,562) |
| board | 14 | 8 | 1 | 11 |
| task | 18 | 8 | 19 | 20 |
| changes | 15 | 0 | 5 | 1 |
| settings | 48 | 11 | 13 | 23 |
| layout | 32 | 9 | 3 | 1 |
| docs | 13 | 3 | 6 | 3 |
| ui | 9 | 2 | 1 | 0 |

## 12. Third-party dependencies

Runtime:
- `react`, `react-dom` ^19.3.1.
- `zustand` ^5.0.16: all stores (30 files import it, mostly `useShallow`).
- `@huntaway/client` (workspace).
- `react-markdown` ^10.1.0 + `remark-gfm` ^4.0.1: thread markdown and the guide (2 files).
- `mdast-util-from-markdown` ^2.1.0: finding code spans so new-task tokens in code aren't tokens (`layout/taskTokens.ts`).
- `mermaid` ^12.2.0: diagrams in documents and plans, loaded on demand (`task/mermaid.ts`).
- `shiki` ^4.5.0: diff syntax highlighting, in the worker only, JavaScript regex engine, grammars fetched per language.
- `@xterm/xterm` ^5.5.0, `@xterm/addon-fit` ^0.11.0, `@xterm/addon-web-links` ^0.12.0: the terminal (DOM renderer on purpose).
- `@dire-kiwi/docs-render` 0.2.0 (tarball from a GitHub release): the docs reader's frame document and CSP (`docs/docFrame.ts`); pages are rendered by the host.
- `qrcode-generator` ^2.0.4: device pairing QR (`settings/Devices.tsx`).
- `lucide-react` ^1.61.0: icons (138 files). `clsx` ^2.1.1: class names (124 files).
- `@fontsource-variable/jetbrains-mono` ^5.3.0: the mono font.

Not used (hand-rolled instead): router, data fetching/caching, forms, drag and drop (native HTML5 DnD), virtualisation
(threads are windowed at 300 items and paged by 200), charts (analytics draw their own SVG/CSS), date library, toasts.

Dev: `vite-plus` 1.5.0 (`vp dev|build|check|test`; Vite 8 underneath), `@vitejs/plugin-react`, `tailwindcss` ^4.3.3 +
`@tailwindcss/vite` + `@tailwindcss/typography`, `electron` ^45, `electron-builder` ^26.18, `playwright` 1.64.1,
`@vitest/browser-playwright` 5.1.0, TypeScript types.

## 13. Styling

- **Tailwind CSS v4**, utility classes inline in JSX; `index.css` (170 lines) is the only global stylesheet, plus `components/task/planTheme.css` (748 lines, injected into plan/artifact frames). No CSS modules, no CSS-in-JS, no component library.
- Theme tokens in `@theme` (`--color-*`): `bg #0b0b0e`, `panel #111116`, `panel-2 #16161d`, `raised #1c1c25`, `line #24242e`, `line-strong #33333f`, `fg #e6e6ec`, `muted #9a9aab`, `faint #6b6b7b`, `accent #7c7cf8`, `accent-strong #6366f1`; status colours `st-todo #8b8b9c`, `st-progress #60a5fa`, `st-attention #f59e0b`, `st-review #a78bfa`, `st-merge #f472b6`, `st-done #34d399`, `st-backlog #5f5f6e`. Fonts: Inter stack; JetBrains Mono Variable + Symbols Nerd Font Mono.
- Dark only (`<html class="dark">`, `color-scheme: dark`).
- **Tint** (`theme.ts`, HA-397): a profile's `tint` hex recolours the 11 surface/text/accent tokens in OKLCH, keeping each token's lightness (accents take the tint's chroma; surfaces take stock chroma × 2.5 × strength); set as inline CSS variables on `<html>` and on `meta[name=theme-color]`; status colours don't change. `previewTint` while picking; the active profile's tint is cached in `ia.tint`. Docs frames read the board's current colours.
- **Narrow layout**: custom variants `narrow:` (`max-width: 699.98px`) and `touch:` (`pointer: coarse`), mirrored by `useNarrow()` / `useTouch()`. Below 700 px: sidebar is a drawer (stays mounted, `inert` when closed), boards show one column, a task opens full screen. `#root` uses `--app-height` and `env(safe-area-inset-*)`.
- Helper classes: `.prose-chat` (typography plugin overrides), `.kanban-scroll`, `.animate-pulse-dot`, `.animate-slide-in-right`, `.drag`/`.no-drag`, `[data-selected="true"]` outline.
- DOM hooks other code depends on: `data-task`, `data-stack`, `data-drop-before`, `data-modal`, `data-task-modal`, `data-draft` (a click outside the panel doesn't close it while a composer has a draft), `data-thread`, `data-part`, `section[data-status]`.

## 14. Invariants and hard-won rules

Store and events:
- **Connect, then load**: everything is loaded after the socket opens (and again after each reconnect), so nothing changes unseen between a load and the connection. A socket that never opens on the first try still calls `loadAll` once so a wrong token shows the token screen (`live.ts`).
- **Loads must not undo events**: a list read before an event must not overwrite it, and a deleted task must stay deleted (`hostLoads`, `takesLoaded`, `changed`). Refreshes, profile lists and `loadAll`s are numbered and an older one that lands later is dropped. Answers can arrive out of order through the hub's proxy (`store.ts` `newest`).
- **A failed request must not empty a host's board**: failed profile, config and usage lists fall back to what the store had (`store.ts` comments "Not none…").
- **Task ids are unique only per host**: `tasks` is keyed by bare id, the first host's task wins, the other host's task and its events are dropped with one console warning (`otherHosts`). Project ids likewise: lookups pair `host_id` with `id`, but `useProject(id)` and the `/p/<id>` route use the bare id.
- **Notifications only for live changes**: `liveTaskChanges` fires for events, never for list loads, so a task already waiting at load doesn't notify; a task first seen by an event doesn't notify either (`notifier.ts`).
- A profile's event for a profile not on the board, or a task in an archived project, is ignored.
- `handleEvent` must have a case for every declared event kind (compile-time), and must ignore unknown kinds at run time (linked hosts on other versions).
- The watchdog only arms after a `tick`, so servers from before ticks are never cut off.

Threads:
- Events that arrive while a window or catch-up loads are held and applied after; a seq gap triggers a catch-up from the snapshot's `seq`; `resync` in the events page or a failed catch-up falls back to a fresh window; a newer load generation wins.
- The page's `seq` counts event types this build doesn't know, so it is adopted even when no event applied.
- Streamed text is a preview keyed by `item_id` with offsets; overlapping deltas are trimmed; the preview ends when a top-level `item.added` arrives. Tokens go in a separate store and only for watched threads, so a token doesn't re-run the board's selectors.
- `apply_event` preserves identity of unchanged items and `itemModel`/`reuseItems` keep row objects stable so long threads don't redraw.
- A 404 for a thread means "no items on this host" (shown as a notice), not an error.

UI:
- Own moves don't notify: noted in `ia.movedHere` before the request, 15 s window, shared by all tabs.
- One tab notifies (Web Lock, or the heartbeat fallback); the focused tab's open task is shared so no tab notifies about a task the user is looking at.
- A PR preview (open board) never shows system notifications.
- A message send outlives its composer: sends are tracked per draft key at module level; only what was sent is removed from the draft, text typed meanwhile stays (`afterSend`).
- The composer warns when the browser couldn't save the draft.
- Preview checks: at most 2 in flight (HA-188, six-connection limit).
- Terminals: created only after the font has loaded and one frame later (StrictMode double mount); DOM renderer, not canvas; tmux repaints on re-attach, so the terminal is reset before reconnecting.
- `preloadable` exists because `lazy` suspends for 300 ms on first show even when the chunk is loaded.
- Agent-written HTML is always in sandboxed frames; the page CSP is `frame-src 'self'`; docs images are fetched by the board and inlined, remote images are not shown.
- No service-worker caching; an open tab detects a new build and offers a reload.
- `moduleNames.test.ts`: no two modules in a folder may differ only in case (macOS release build).
- Shell rules: see 9.1 and 9.2 (blame only after another server is up; `ECONNREFUSED` is the only "no server"; AppImage relaunch through `$APPIMAGE`; origin checks on IPC).

## 15. How it is tested

Three tiers (`apps/web/vite.config.ts` projects `unit` and `browser`; `tests/ui/vitest.config.ts`):

| Tier | Files | Runs | Against |
|---|---|---|---|
| Unit | `tests/*.test.ts` (45) | Node, no DOM, `node:assert/strict` | modules by path; fake `WebSocket`, `window`, `localStorage` globals where needed |
| Component checks | `tests/browser/*.test.tsx` (16) | Vitest browser mode, Playwright Chromium, 1400×900, `expect` | components from source with the app's CSS; `fetch` faked in the page; no server |
| Browser checks | `tests/ui/*.test.mjs` (93) | Node driving `playwright-core`, 8+ files at once | the built UI served by a real scratch server per file (`scripts/test-server.sh start --demo`, agents off) |

### 15.1 The component-check fake (`tests/browser/fake/`), which the rewrite must match
The fake does not implement `ClientAdapter`. It replaces `globalThis.fetch` (the client looks `fetch` up at call time)
and writes the zustand store directly. There is **no websocket** in this tier: events are injected by calling
`handleEvent(ev)`.

`builders.ts`:
- `board(host?: Partial<Host>): Board`: a local host (`id "local"`, `api_version 141`, `connected`, `agents`), a profile `b.me` ("Default"), one config, a project `b.demo` (key `DEMO`).
- `Board = { host, hosts, profiles, claudeConfigs, projects, tasks, me, demo, profile(p?), config(c?, profile?), project(p?, profile?), task(t?, project? | null), get(id) }`. `task(…, null)` makes a scratch task. Defaults: status `todo`, `position` = count + 1, timestamps fixed at `2026-11-01T09:00:00.000Z`.
- Ids come from a counter that is never reset, because the app keeps drafts and caches by id outside the store.

`server.ts`:
- `fakeServer(b): FakeServer` installs itself as `globalThis.fetch`.
- `FakeRequest = { method, path, host, query, url, body, params }`: `path` is after `/api` and after `/h/<id>`; `host` is that id or null.
- `on(method, pattern, handler)`: a pattern is a string with `:name` segments or a RegExp; the latest registered wins; a handler returns JSON (200), a `Response`, or `reply(status, body)`; `delay(ms)` for late answers.
- `allow(regex)`: requests with no route are otherwise answered 404, recorded in `missed`, and **fail the check** in `cleanUp`.
- `requests`, `sent(method, pattern) → bodies[]` for assertions.
- `emit(ev)` → `handleEvent(ev)`; `update(id, change)` replaces the board's task and emits a `task` event.
- `thread(id, source)`: serves `/tasks/<id>/thread`, `/thread/items`, `/thread/events` from a `threadFeed` and wires the feed's "socket" to `emit`; marks the task `thread_source: "items"` (call before `mount`).
- Default routes: `GET /hosts`, `/profiles`, `/claude-configs`, `/profiles/:id/projects`, `/projects/:id`, `/projects/:id/tasks?kind=`, `/tasks/:id`, `PATCH /tasks/:id` (merges and emits), `POST /projects/:id/tasks`, `POST /tasks/:id/messages`.

`mount.tsx`:
- `seed(b)`: `useStore.setState({authed: true, connected: true, loaded: true, hosts, localHostId, profiles, claudeConfigs, projects, tasks})`.
- `mount(b | null, node)`: seeds, renders `<StrictMode>` into a new `<div>` on `document.body`.
- `cleanUp()` after each test: unmount, `useStore.setState(initialState, true)`, clear `localStorage` and `sessionStorage`, restore the URL, uninstall the fake, throw if `missed` is non-empty. The other zustand stores and module caches are **not** reset.

Typical check: `const b = board(); const task = b.task({...}); const server = fakeServer(b).thread(task.id, threadFeed(task.id, [])).allow(/^GET /); mount(b, <Shown id={task.id} />); …userEvent…; expect.poll(() => server.sent("POST", "/tasks/<id>/messages"))`.
Checks also set storage keys and `history.replaceState` directly, and one stubs a method on the `api` object.

### 15.2 Shared feed and fixtures
- `tests/shared/threadFeed.mjs`: `threadFeed(taskId, messages)` → `{messages, log, socket, seq, event, add, update, delta, snapshot}`; turns stored legacy messages into item snapshots with the **server's** `threads/translate.ts`, numbers events from `SEQ = 100_000`, sends `{type: "thread_event", task_id, event}` through `feed.socket.send`; `quiet` logs an event without sending it (a missed event). `threadAnswer(taskId, source, url)` answers the three thread endpoints.
- `tests/fixtures/threadHistory.mjs` (about 57 messages covering everything the thread draws), `forkedSkill.mjs`, `threadHistoryDrawn.json`.
- `tests/boardEvents.ts`: `sent(ev)` casts a partial event to `BoardEvent` for unit tests.

### 15.3 Unit-test seams
- Tests import the real singletons (`useStore`, `handleEvent`, `connectEvents`, `reconnectNow`, `SILENCE_MS`, `useItemThreads`, `resetItemThreads`, `useDeltas`, `flushDeltas`) and **stub by assignment**: methods on the one `api` object, store actions via `useStore.setState({refreshHost: …})`.
- `store.test.ts` replaces `globalThis.WebSocket` with a `FakeSocket` and drives `onopen`/`onmessage`; clocks are Vitest fake timers.
- `client.test.ts` uses a real `ClientAdapter` with a recording `fetch` and a Map-backed storage.
- Desktop tests load the `.cjs` files under plain Node (`boot.cjs` tolerates a missing `electron`), with injected `fetch`, `spawn`, `pacmanOwns`, temp dirs.

### 15.4 `tests/ui` harness (`harness.mjs`, `scripts/ui-check.mjs`)
- `startServer(...args)` → `{url, token, dataDir, api(method, path, body), stop()}`; env `IA_CLAUDE_BIN=/bin/false`, `IA_CODEX_BIN=/bin/false`; flags `--seed`, `--fake-claude`, `--open-token`, hub + linked host.
- `withBrowser(server, opts, fn)`: fresh context with `ia.token` preset and animations off; any page or console error fails the check.
- Events injected with `page.routeWebSocket(/\/api\/ws/, …)`; answers held or rewritten with `page.route`; `routeThread`, `fastClock`, `eventually`.
- Many checks depend on the demo seed's titles and counts.

Rules from `docs/development.md`: behaviour checks belong in the lowest tier that can show them, with one wiring check
left in `tests/ui`; a check waits for what it reads rather than sleeping; keys and clicks go through `userEvent`.

## 16. Dependencies

Calls out: the server's HTTP API and websocket (every area); the server's source files by relative path
(`wire/*.ts`, `threads/protocol.ts`, `agent/approval_rules/rules.ts`; tests also `threads/translate.ts` and `demo.ts`
seed data); `docs/guide/*.md` (rendered in app); `scripts/test-server.sh`, `scripts/package-server.sh`,
`scripts/ui-check.mjs`; `.github/workflows/release.yml` (writes `shell.json`, the release manifest, the package version).

Called by: the server serves `dist/` as the UI and expects the shell's env vars and `state.json` protocol;
`apps/mobile` uses `@huntaway/client` (21 imports) and mirrors `live.ts`; a server test checks that every capability
name the web, mobile and client ask for with `hostHas` exists.

## 17. Rewrite notes

### 17.1 Accidental versus essential
Accidental or legacy:
- **Version gating everywhere**: `hostSupports(h, n)` with about 40 API constants and `Since<…>` optional fields exist for linked hosts on older versions. If the rewrite doesn't link to old-code hosts, almost all of it goes (keep named capabilities only if mixed versions of the new code must interoperate).
- Legacy shapes kept for old hosts or data: `kind: "scratch"`, document `task_type`s before labels, `summary` vs `summaries`, subprojects (`SubprojectBoard`, `/t/<id>/board`, `parent_id`/`subproject`; no new ones since API 133), the legacy `messages` endpoints (threads are drawn only from items), `delta`/`delta_reset`/`message` events (ignored or used only for approvals), `UI_API_VERSION = 24`.
- Names: `ia.` storage prefix, `IA_*` env vars, `ia-shim`, `issue-agent` directory fallbacks, Rust server fallbacks in the shell.
- The client importing server files by `../../../apps/server/src/...` (a shared schema package would replace it).
- snake_case function names in the shared thread reducer (Rust-port shape).
- Two assertion styles and `.mjs` untyped `tests/ui`.

Essential:
- Multi-host merge rules (profiles by name, ids unique per host, per-host load reconciliation) if multi-host stays.
- Connect-then-load, latest-wins load numbering, events-beat-stale-loads.
- The thread window/catch-up/hold/gap/resync protocol and identity-preserving view model.
- Draft persistence, the send-outlives-composer rule, own-move suppression, single notifying tab.
- Sandboxed frames and the CSP rules; the shell's hardening, blame rules and `state.json` protocol.
- All storage keys in 3.3 if existing users' preferences and drafts should carry over (otherwise only their meaning).

Awkward today:
- `tasks` is keyed by bare id although ids collide across hosts; "collision" handling is first-wins plus a warning.
- Events not kept in the store go through eight ad-hoc listener sets; each consumer refetches.
- Request state (loading, error, stale guard) is rebuilt by hand in about 100 files, with five slightly different stale-guard idioms.
- No request cancellation, timeout or de-duplication; polling is per-component `setInterval`.
- Several module-level caches are never invalidated and are not reset between component checks (hence the never-repeating ids in the fake).
- Three settings components write the store directly with `useStore.setState` (`Server.tsx` sets `restart`; `hosts/TerminalTools.tsx` and `hosts/NearbyHosts.tsx` set `hostSettings`).
- The store's `refreshHost` issues one request per project per kind (N+1) on every reconnect and `resync`.
- The websocket carries every host's events to every client with no subscription.

### 17.2 Pure view versus tangled logic
By file (11.4): of 210 `.tsx` component files, **85 (40%, 11.5k lines)** touch neither a store nor the API. About 20 of
those still own effects (DOM listeners, observers, timers), so about 65 are pure props-in, markup-out. Another **31 (15%)**
only read the store through selectors: portable once the selectors are swapped for atoms. The remaining **94 (45% of
files, 24.8k of 40.6k `.tsx` lines, 61%)** call the API directly, 56 of them also reading the store.

By kind of work, roughly:
- **Portable as they are (about 35–40% of component lines)**: `ui/` (controls, Modal, ContextMenu, status badges, time), card and row markup, thread item renderers (`thread/items.tsx`, `tools.tsx`, `Markdown.tsx`), diff rendering (`DiffLines.tsx`), board columns/lanes/list, settings form sections that take values and callbacks, plus the pure helper modules (64 `.ts` files in components and most top-level ones: `boardQuery`, `taskOrder`, `stacks`, `lasso`, `taskTokens`, `harnesses`, `refCompletion`, `templateCompletion`, `questions`, `reminders`, `projectGroups`, `tokenStats`, `contextStats`, `guide`, `theme` colour maths, `notifications` triggers, `router` parse/href, `itemModel`).
- **Mechanical rewiring (about 20–25%)**: components whose only coupling is `useStore(selector)` and `navigate`/`openTask`; the 48 `use*.ts` hooks that already separate state from markup (`taskBoard/`, `changes/git/`, `newTask/`, `sidebar/`, `docsPage/`, `workflows/`).
- **Logic to pull out (about 40%)**: fetch-on-mount with local loading/error state, polling loops, optimistic writes and persisted drafts written inline in `.tsx`. Largest: `settings/Server.tsx` (965 lines, 3 polls, restart state), `task/Approvals.tsx` (950), `settings/TokenStats.tsx`, `changes/Compare.tsx`, `task/Questions.tsx`, `task/Document.tsx` (frame messaging + answers draft), `task/TaskView.tsx` (603; tabs, panel dismissal, seek-by-id fetch, terminal tool cleanup), `task/Memory.tsx` (module-level editors and conflict handling), `task/Review.tsx`, `thread/Composer.tsx` (draft, send tracking, attachments), `task/Terminal.tsx` (its own socket), `settings/HostPage.tsx`, `settings/ClaudeConfigs.tsx`, `board/taskBoard/useBoardDrops.ts`.

Everything outside `components/` that holds state or does I/O is replaced outright: `store.ts`, `live.ts`,
`itemThreads.ts`, `deltas.ts`, `threadView.ts`, `api/index.ts`, `notifier.ts`, `push.ts`, `terminalTools.ts`,
`assistant.ts`, `agents.ts`, `attachments.ts`, the fetching halves of `analytics.ts`, `docs.ts`, `pens.ts`, and all of
`packages/client` except its pure predicates and constants (8.4), which components import by name and must keep meaning the same.

### 17.3 What a replacement must offer the kept components
- The same read surface: hosts, local host id, profiles, configs, projects, archived, tasks by id, host settings, usage, approvals, pens, restart, `authed`/`connected`/`loaded`.
- Synchronous "current value" reads inside event handlers (today `useStore.getState()`), and imperative upserts after a mutation's response.
- Per-topic change notifications for automations, workflows, checkpoints, docs, doc comments, docs site, telegram, approval rules.
- A retained, ref-counted thread subscription per task with window, older pages, failed/retry, missing, and a separate streamed-text value.
- A test entry that applies one board event, a way to seed and reset all state, and request recording with fail-on-unrouted (15.1); plus a fake socket and a routable `/api/ws` for the other two tiers.
