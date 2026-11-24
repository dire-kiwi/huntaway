# 9. Frontend

The web app, the shared client and the desktop shell. The React components are kept: their markup,
styles and look. What they read from and call into is replaced. Facts and counts here are from
[inventory 10](inventory/10-web-client.md) and [11](inventory/11-mobile-tooling.md).

## What is kept and what is replaced

| Kept as it is                                                                                           | Replaced                                                                                              |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `apps/web/src/components/` (298 files, 210 of them `.tsx`, 48,752 lines), in the same feature folders    | `store.ts` and the eight other zustand stores                                                         |
| `index.css`, Tailwind 4, the theme and tint variables, the narrow layout                                 | `live.ts` (the websocket feed and its 30 event cases)                                                 |
| Pure helpers: `boardQuery`, `taskOrder`, `stacks`, `lasso`, `taskTokens`, `refCompletion`, `questions`, `reminders`, `projectGroups`, `tokenStats`, `theme`, `itemModel`, `threadModel`, the router's parse and href functions | `itemThreads.ts`, `deltas.ts`, `threadView.ts` (windows, held events, gaps, catch-up)                 |
| Third-party view libraries: xterm, Shiki, Mermaid, react-markdown, lucide                                | `api/index.ts` and all of the old `packages/client` except its pure predicates and constants          |
| The 55 `ia.*` storage keys and what they hold, so drafts and preferences survive the switch              | `notifier.ts`, `push.ts`, `assistant.ts`, `agents.ts`, `attachments.ts`, the fetching halves of `analytics.ts`, `docs.ts`, `pens.ts` |
| `tests/ui` (93 whole-app checks) and `tests/browser` (16 component checks), with new harnesses under them | The component-check fake's `fetch` replacement and direct store writes                                |

How much each component needs depends on what it touches:

| Component files (`.tsx`)                    | Count      | Work                                                               |
| ------------------------------------------- | ---------- | ------------------------------------------------------------------ |
| Touch neither the store nor the API         | 85 (40%)   | None. Copied                                                       |
| Read the store only                         | 31 (15%)   | A mechanical swap of the hook they read with                       |
| Call the API (56 of them also read the store) | 94 (45%, 61% of the lines) | Step 1 mechanical; step 2 by hand, a feature at a time |

## `packages/client`

Everything the web app knows about servers. It uses no DOM, Node or React Native APIs: the app gives it a websocket
constructor and a key-value store as layers. That costs nothing now and is what would let a phone app share it
later.

```
packages/client/src/
  session/     HostSession.ts   one RPC connection to one host: its protocol layer, its auth, its state
               sessions.ts      which hosts there are (from the hub) and a runtime for each
               relay.ts         a relayed session: ticket, then the socket through the hub
               hub.ts           the hub's own queries (its SSH key, the dial-in command, hosts nearby)
  board/       hostBoard.ts     one host's board, folded from board.watch
               board.ts         every host's, merged: the read surface the components use
               tasks.ts         taskAtom(ref), tasks of a project, of a profile, optimistic moves
  thread/      thread.ts        threadAtom(ref): a window folded from threads.watch; older pages; the preview
  queries/     one file per group: atoms for reads that are not in the board snapshot
  mutations/   one file per group: functions that call the server
  invalidate.ts  which board events refresh which queries
  logic/       the old client's pure predicates and constants (hostHas, usableHost, assistantHome, …), kept by name
  index.ts
```

### Sessions

```ts
/** A host's RPC client, reached directly (the page's own board) or through the hub's relay. */
export class HostClient extends Context.Service<HostClient, RpcClient.RpcClient.Flat<HostRpcs, RpcClientError>>()("huntaway/client/HostClient") {}

/** One runtime per host. Atoms for a host are built from its runtime, so they share its connection. */
export const hostRuntime: (host: HostId) => Atom.AtomRuntime<HostClient> // Atom.family over Atom.runtime(layerFor(host))

export const hubRuntime: Atom.AtomRuntime<HubClient | HostClient> // the board the page was opened on
```

- `layerFor(host)` is `RpcClient.layerProtocolSocket({ retryTransientErrors: true })` over a `Socket` that is
  either `Socket.layerWebSocket(ownUrl)` or, for another host, a socket obtained by `hub.hosts.openRelay` and
  re-obtained on every reconnect. The RPC client's own ping (5 s, dead after a silent interval) replaces the tick
  watchdog; its retry schedule replaces the hand-written backoff.
- A session's state is an atom: `connecting`, `live`, `offline { since, error }`, `unauthorized`, `needs_update`.
  `unauthorized` on the hub session is what shows the token screen.
- `AtomRpc.Service` in `effect/reactivity` is built for one protocol. The spike type-checked it for one host
  ([spike/web.tsx](spike/web.tsx)); the per-host family above is a thin wrapper of the same parts (`Atom.runtime`,
  `runtime.atom`, `runtime.fn`) and is the first thing M2 builds and tests.

### The board

```ts
/** Everything one host's board stream has said so far. */
export const hostBoardAtom: (host: HostId) => Atom.Atom<AsyncResult.AsyncResult<HostBoard, RpcClientError>>

export interface HostBoard {
  readonly host_id: HostId
  readonly seq: number
  readonly profiles: ReadonlyArray<Profile>
  readonly configs: ReadonlyArray<AgentConfig>
  readonly projects: ReadonlyArray<Project>
  readonly archived: ReadonlyArray<Project>
  readonly tasks: ReadonlyMap<TaskId, Task>
  readonly pens: ReadonlyArray<Pen>
  readonly settings: HostSettings
  readonly usage: ReadonlyMap<string, Usage>
  readonly approvals: ReadonlyArray<Approval>
  readonly restart: RestartState | null
}
```

`hostBoardAtom(host)` is `hostRuntime(host).atom(stream)` where the stream is `board.watch` folded with
`applyBoardEvent`, a pure reducer that keeps every unchanged object identical. On a reconnect it resubscribes with
the last `{ boot, seq }` and continues, or receives a fresh snapshot. A host that goes offline keeps showing what it
had, marked stale, which is the old "a failed request must not empty a host's board". A subscription that ends before
anything after `hello` waits 1 s before the next, twice as long each time up to 30 s (HE-104): a client that couldn't
read a snapshot (it was over RPC's then 16 MiB limit) asked again at once, for ever, and the host built and sent the
whole board each time until it ran out of memory.

`boardAtom` merges the hosts into the shape the components read today:

```ts
export interface Board {
  readonly authed: boolean | null
  readonly connected: boolean
  readonly loaded: boolean
  readonly hosts: ReadonlyArray<Host>
  readonly localHostId: HostId | null
  readonly profiles: ReadonlyArray<HostProfile> // tagged with host_id; merged by name in the UI, as now
  readonly claudeConfigs: ReadonlyArray<HostAgentConfig>
  readonly projects: ReadonlyArray<HostProject>
  readonly archived: ReadonlyArray<HostProject>
  readonly tasks: Readonly<Record<string, HostTask>> // by bare id, first host wins, as now
  readonly hostSettings: Readonly<Record<string, HostSettings>>
  readonly usage: Readonly<Record<string, Usage>>
  readonly approvals: ReadonlyArray<HostApproval>
  readonly pens: ReadonlyArray<HostPen>
  readonly restart: RestartState | null
}
```

`loaded` waits for more than the page's own host's snapshot: the hub's host list too, and the first board of every
linked host the hub says is connected (one whose session went offline, was refused or needs an update isn't waited
for). A hub that runs no agents has its profiles on a linked host, and without this the onboarding screen showed on
every reload until that host's board came. Once true it stays true.

It has the old store's field names on purpose, so that 241 selector call sites change by one word. Task ids are
still unique per host only; `taskAtom({ host_id, id })` is the exact lookup, and new code uses it.

### Threads

`threadAtom({ host_id, task_id })` is a window folded from `threads.watch` with the contract's reducer. It is kept
alive while something shows it and for ten seconds after, as now. `olderPage` pages back with `threads.page`. The
text streamed for the reply being written is its own atom (`threadPreviewAtom`), taken once per animation frame by
the web app, so a token does not re-run anything that reads the thread. `itemModel.ts` keeps turning items into rows
with stable identity. As built: see "Step 1 as done for task/" below.

All of the old hold, gap, catch-up, resync and load-generation logic is gone: the server sends a consistent window
and then what follows ([05-protocol.md](05-protocol.md#a-thread)).

### Queries, mutations, invalidation

- A **query** is an atom for a read that is not in the board snapshot: a task's git status, a document, an
  automation's runs, disk usage. `queries.git.status({ host_id, task_id })` gives `AsyncResult<GitStatus, …>`:
  initial, waiting (with the previous value), success, failure.
- A **mutation** is `mutations.tasks.update` and the like: an `AtomResultFn` a component runs with `useAtomSet`. It
  does not write the result into the board; the event that follows does.
- **Invalidation**: `invalidate.ts` maps board events to reactivity keys (`automations_changed` refreshes that
  project's automations; `checkpoints` a task's turns; a task's `running` or `worktree_state` changing refreshes its
  git status). It replaces the eight listener sets and the dependency-array tricks.
- **Optimistic changes** (`Atom.optimistic`): moving and reordering cards, pens, stars and reminders, as now.
  As built (9.2): stars and reminders are not `Atom.optimistic` transitions, which hold back the host's events while
  they run. Each save is kept in `pendingMarksAtom` (`packages/client/src/board/marks.ts`) and shown on top of the
  moves' optimistic board (`boardAtom` is `movesBoardAtom` with the marks) until it is refused or its event arrives, so a rename or a reminder set elsewhere meanwhile shows, and a
  refused save takes back only its own change (`tests/ui/reminders.test.mjs`).
  Nothing else is optimistic.
- **Reads across hosts** (analytics, token statistics, disk usage, docs, pens): one query per host, combined by a
  derived atom, in place of the hand-written fan-outs.

## The web app's own state: `apps/web/src/state/`

| File               | Holds                                                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `board.ts`         | `useBoard(selector)` and `board.get()`: the read surface over `boardAtom`                                                        |
| `mutation.ts`      | `useMutation(method)` and `useAction()`: a component's changes, their state its own, their runs the page's; `runExit` for module code (step 2: `rpc.ts`'s `useRpc()` promise is gone) |
| `route.ts`         | The route as an atom over the History API, with the old router's `parse` and `href`. The 14 routes and their query parameters stay |
| `drafts.ts`        | Composer, new-task, line-comment and plan-answer drafts as `Atom.kvs` atoms over the browser's storage, under their old keys     |
| `prefs.ts`         | The other persisted keys (view toggles, collapsed groups, theme, active profile…), the same way, each with a schema              |
| `selection.ts`, `terminalTools.ts`, `subagents.ts`, `narrow.ts`, `shortcuts.ts`, `clock.ts` | The small stores and `useSyncExternalStore` sources, as atoms             |
| `timers.ts`, `visibility.ts` | DOM timers on Effect's clock (`after`, `every`), and whether the page is shown (what polls only while it is)              |
| `notify.ts`        | Which changes notify, the single notifying tab, own-move suppression                                                             |

Storage is `BrowserKeyValueStore.layerLocalStorage` from `@effect/platform-browser` behind `Atom.kvs`, with a schema
per key so a value an older build wrote is read leniently.

## Moving the components

Two steps. The first gets the whole UI running on the new server with the smallest edit to each file; the second
makes each feature idiomatic. Both are done with the type checker as the guide: the old `api` object and `useStore`
do not exist, so every place that needs a change is a compile error.

### Step 1: mechanical (one pass over all 298 files)

| Old                                                        | New                                                                        | Sites |
| ---------------------------------------------------------- | -------------------------------------------------------------------------- | ----- |
| `useStore((s) => s.tasks[id])`                             | `useBoard((s) => s.tasks[id])`                                              | 241   |
| `useStore.getState().projects`                             | `board.get().projects`                                                      | 48    |
| `await api.updateTask(host, id, patch)`                    | `await rpc(host, "tasks.update", { id, patch })` with `const rpc = useRpc()` | 279   |
| `upsertTask(await api.…)` after a mutation                 | Deleted: the event updates the board                                        | 50    |
| `catch (e) { if (e instanceof ApiError && e.status === 409)` | `catch (e) { if (isTagged(e, "Conflict"))`: `useRpc` rejects with the tagged error | where used |
| `hostSupports(host, 131)`                                  | Deleted, or `hostHas(host, "name")` for the few real capabilities           | ~40 constants |
| `import { type Task } from "../../api"`                    | `import { type HostTask as Task } from "@huntaway/client"`                  | most files |
| `onAutomationsChanged(listener)` and the seven like it     | Deleted where a query replaces the fetch; otherwise `useBoardEvent("automations_changed", f)` | 16 |
| A legacy branch (`thread_source !== "items"`, `task.subproject`, `kind === "scratch"`, `summary` single) | Deleted                              | —     |

After step 1 a component still has its own `useState` for loading and errors and its own `useEffect` to load. That
is allowed to stand: it works, and it is the same code that works today. The lint override for
`apps/web/src/components/**` exists for this state.

Order within step 1, each a task of its own once `state/` and the shared pieces exist: `ui/` and `layout/` (little
to do), `board/`, `task/` with `thread/`, `changes/`, `docs/`, `settings/`. The app is runnable after `board/` and
`task/`.

### Step 1 as done for `ui/`, `layout/` and `board/` (M1, HE-3)

- What a board or layout file needs from a later milestone is cut with the smallest edit and a note in the code: the
  task panel, page and modal are stubs; the Triage view, the Agents pill, the usage panel, notifications, the
  assistant and docs entries, Add project, the config picker, Compare, stack merges and titles, merge targets, the
  branch list, review badges, Asana, preview polling and attachments in New task wait for their areas. The rest of the
  app's pages show "not yet on this server".
- `components/boardHelpers.ts` holds what the old `store.ts` offered beside its state (`useHost`, `useProject`,
  `taskConfig`…) and `moveTask(task, patch)`, a promise over the client's `optimisticMove` that replaces `upsertTask`
  for drops and menus. `src/smallStore.ts` (`useSyncExternalStore`) replaces zustand for the selection and the drawer.
- `index.html` links `index.css` (a side-effect import in `main.tsx` breaks `import/no-unassigned-import`).
- Fixing the React hook rules changed a few things slightly: clocks tick inside the components that show the time, and
  some effects that kept refs now run after every render or adjust state during render.
- `HostBoard` also carries `boot` and archived projects' tasks (the merged `Board` leaves them out), and a session's
  view carries its `host.info`. The page's own host id comes from `public.health`. Keys the old app stored as bare
  strings use `storedBare`, because `Atom.kvs` writes JSON.
- Not yet: component checks under `tests/browser` (the fake is there, with unit tests), and a catch-all member for
  board events of a kind a client does not know (`BoardMessage` has none; the client's reducer ignores unknown kinds,
  but decoding fails first).

### Step 1 as done for `task/` and `task/thread/` (M2, HE-4)

- **The client** (`packages/client/src/thread/`): `threadAtom({ host_id, task_id })` is a `ThreadView`
  (`{ snap, loading, failed, unknown }`) folded from `threads.watch` (a window of `WINDOW_ITEMS` = 300) with
  `applyEvent`; a dropped subscription subscribes again with `since` its window's `seq`. It stays subscribed ten seconds
  after the last reader (`Atom.setIdleTTL`). `olderPage(ref)` loads `PAGE_ITEMS` = 200 before the window's start with
  `threads.page` and `withPage`, keeping the window's own copies of what both have, so an event for an item of a loaded
  page changes it. `threadPreviewAtom(ref)` is the reply being written (`previewAfter`), apart from the thread; the web
  app takes it once per animation frame (`usePreviewText`), since the client has no DOM. `sendMessage(ref)` and
  `unqueueMessage(ref)` are kept for the page's life and take the composer's draft atom: a send outlives its composer,
  and only what it sent (`draftAfterSend`) comes off the draft; an unqueue puts the queued text back in front
  (`draftWithQueued`). `sendingAtom(ref)` counts sends in flight. `mutations.tasks.send`, `stop` and `dropQueued` are
  the plain calls.
- **The web app**: the draft is `composerDraftAtom(composerDraftKey(task))` in `state/drafts.ts`, under the old
  `ia.composer.draft.<host>:<task>` key, kept for the page's life with `composerUnsavedAtom` for the "couldn't save"
  warning; the composer edits it directly, so a send's change shows in whichever composer is open. The old
  `src/itemModel.ts`, `threadModel.ts`, `subagents.ts` (`thread/subagentView.ts`, on `smallStore`) and `taskRefs.ts`
  moved into `components/task/thread/`, under the components' lint override; `thread/threadView.ts` holds the hooks
  (`useThreadView`, `useThreadModel`, `useLoadOlder`, `useReloadThread`, `usePreviewText`). The thread's rows read an
  agent's tool input and the board's metadata loosely through one `type Any = any` (the one listed suppression) until
  step 2. Every host keeps threads as items, so the old notices for an old host or a thread not on items are gone; a
  thread that cannot be watched (its task gone) says so with "Try again".
- **Cut with a note, by milestone**: the background banner's Stop buttons (2.5); turns, checkpoints, rewind marks
  and the rewind dialog (4.3); line comments sent with a message (4.2); the skills menu (6.4, inert); Changes, review,
  summary and the review's dot (M4); workflows' tabs and list (6.6); the terminal and its tools, the browser pane (HE-62,
  below) and the desktop view (M6); documents and plan tabs, document links (M6: links are plain external links); the assistant's
  memory, brief, routines and action log, and finding a routine's thread on other hosts (M6); Asana links (6.11);
  approval rules in Details (3.6, 6.12); worktree set-up and tear-down (4.1); "Stacked on" and "Landing after" in
  Details (4.8); fix-checks buttons (4.5, 4.6); the context breakdown's lists and "carry on" (2.8); Codex config models
  (M5); a review thread's own view (M4); the Agents pill (`layout/AgentsPill`, HE-40), in the task view's and a review
  thread's header. Subprojects are a legacy branch, deleted.
- **Smaller changes the lint asked for**: the thread notes its top row as it is scrolled and after each change (not
  while it draws) to keep the place when older items come in; its source of rows is filled by an effect; tool groups'
  stable keys are kept per thread for the page's life. A host's tagged errors have no message, so `errorText` reads
  their fields (`Unavailable: what: reason`, `Conflict: detail`…). `components/task/attachments.ts` is
  `attachmentFiles.ts` (two names differing only in case).
- **Checks**: `tests/ui/threads.mjs` writes a thread's items into a test server's database before the page opens it
  (`seedThread`), since only runs write threads and this server has none yet; the checks that need a run are written
  against `--fake-claude` and skipped until Runs (2.5) is in. With 2.7 they run (`threadUpdates`, `threadLive`'s
  streaming, `detailsStatusStart`, `uiState`'s Stop): a fresh task moved into In progress starts its agent only where
  `host.info` says `agents: true`, which the server now reports unless it runs with `--no-agents`; the fake agent
  streams a reply only for a prompt with `fake-subagent`, and keeps a turn going until a stop interrupts it only for
  one with `fake-until-interrupted` (its sleep before a reply doesn't heed a stop).
- **Answering what agents ask (3.3)**: the permission card (`items.tsx`: Allow, Always allow, Deny), Claude's questions
  (`AskCard`: picks by click or keys 1–9, typed answers, Dismiss, answers by message after the run ended), the plan
  (`PlanCard`: Approve into a mode, Keep planning with feedback) and the board's own approvals (`ApprovalCard`: Approve or
  Deny; their detailed views are 3.4's) answer with `mutations.permissions.answer` through `thread/promptAnswers.ts`
  (`usePromptAnswers(host)`); the board's request_user_input card answers with `mutations.threads.answerQuestion`. The
  old `Questions.tsx` cards live in `thread/requestCards.tsx` (no `Questions.tsx`, `Approvals.tsx` or `planAnswers.ts`:
  plan documents' answers are M6's). A board question's state comes from its request's resolution (`itemModel.ts`), as
  its metadata keeps only the card. The snapshot's `approvals` and `approval` events fold into `HostBoard.approvals`.
  Checks: `tests/ui/permissions.test.mjs`, on a test server with `--fake-claude`; the harness starts every other server
  with `--no-agents`.

### Step 1 as done for linked hosts and Settings → Hosts (M7, HE-6, 7.2)

- **The client**: `hubHostsAtom` folds `hub.hosts.watch` on the hub's runtime (subscribed again when the hub's
  connection comes back), and `hubHostListAtom` is its list. `boardHostIdsAtom` is the page's own host and every host the
  hub lists, offline ones too: their `hostBoardAtom` keeps its last board, and their session's state marks them. A linked
  host's runtime is `relayTransport` (relay.ts, see [08-hosts.md](08-hosts.md#relay)); the page's own stays the hub's.
  `Board.hosts` takes a linked host from the hub's entry (its link's name, mode, URL, uplink, `status` and
  `status_reason`), `connected` while its own session is live. A linked host whose `protocol` is not this client's, or
  that the hub says `needs_update`, has the `needs_update` session state without a runtime and is not subscribed to; the
  sidebar says "needs update" beside it. The hub's own reads (`hubSshKeyAtom`, `hubJoinAtom(url)`, `nearbyHostsAtom`)
  are query atoms in `session/hub.ts`; linking, renaming, the uplink switch and forgetting are plain calls on the hub.
- **The web app**: `components/settings/Settings.tsx` is the page at `/settings/<tab>`, with the old tab list's
  structure and only Hosts in it; 6.12 adds the other sections as siblings. A board with no profiles of its own still
  opens Settings, to link a host that has some. `settings/Hosts.tsx`, `hosts/AddHost.tsx` (over SSH, by URL and token,
  and "Connect from elsewhere"), `hosts/HostRow.tsx` and `hosts/NearbyHosts.tsx` (with the scratch-host picker) are the
  old ones on `hubRpc` (`settings/hosts/hub.ts`) and the query atoms; they load nothing in effects. Over SSH, the hub's
  key and nearby hosts answer `Unavailable` until 7.3 and 7.5, and say so.
- **Cut with a note**: the row's Update (the hub pushing its code or release to a host) needs `hub.hosts.pushUpdate`,
  which is not in the contract yet, and the host's restart state (`admin.status`): 8.1 (done there, and in 6.12). A row's version line shows
  `protocol` where it showed the API number. Copying a login between hosts is on the host page and Agent configs, which
  are 6.12's (its RPC, `hub.hosts.copyConfig`, is 7.5's).
- **Checks**: `packages/client/test/hosts.test.ts` (an in-memory hub with two hosts; the relay socket's new ticket per
  connection), and `tests/ui/hosts.test.mjs`: the Hosts page on one server, and two test servers linked through the
  page, the linked host's projects and tasks on the board, one opened and moved, the host stopped (its board stays,
  marked offline) and started again, and forgotten. The harness's servers have `kill()` and `restart()` for it.

### The Code tab (HE-79)

- **Where.** `components/code/`: `Code.tsx` (the view, a `preloadable` chunk mounted by `task/view/TabContent.tsx` for the
  `code` tab, which every task with a Changes tab has; on a phone the task's tabs are tighter so all of them still fit), `FileTree.tsx`, `FileView.tsx` (`CodeLines`), `SymbolPanel.tsx`
  (the symbol's hits, and the file's outline), `tree.ts` and `lines.ts` (plain, tested in `tests/unit/code/`), `state.ts`.
- **What it shows.** The tree of `git.files` (folders first, a folder holding one folder on one row, files with changes
  marked from `git.status` as the Changes tab lists them), a finder over it (`t`, Enter opens the first match), the file
  (`git.readFile`) highlighted by the Changes tab's Shiki worker (`useTextHighlight` in `changes/highlight.ts`, files of
  up to 20,000 lines), a Markdown file as its preview first, and the README of the project's folder until a file is
  picked. Over 3,000 lines only the lines in view (and 80 each side) are drawn.
- **Ignored files (HE-90).** Dotfiles git tracks or would are always listed. The eye button beside the finder
  (`ia.code.ignored`, `codeIgnoredAtom`) shows what git ignores too, dimmed (`.env`, `node_modules/`…): `git.files` is
  asked with `ignored` and every open folder (`filesAsked`; the server lists the ignored ones), so an ignored folder's
  contents are read as it's opened, the last tree shown meanwhile. The question is made from the tab's state, never
  from an answer: two answers that disagree on what's ignored (a `dist/` rebuilt) would each ask for the other. An ignored folder is never folded into one row with its only
  folder. Its files are in the finder once listed.
- **Symbols.** A click on a name (not a drag) takes the word under the caret (`wordAt`: not a keyword, unless it's a
  member's name after `.` or `::`) and looks it up (`git.symbol`):
  the side panel lists its definitions and uses by file, its uses in the file are marked, and a hit opens its file at
  its line. The outline button lists the names the file defines (`outline` from `@huntaway/shared`). Back (and
  Alt+←) returns to the places before; Escape closes the panel (not the task).
- **State.** Where the tab is (the file, line, the places to go back to, the open folders, the symbol) is an atom per
  host and task kept for the page's life (`codeState`), so leaving the tab or the task and coming back keeps it. The
  reads are queries read again every 10 s while the page is shown, on focus, as the agent starts and stops
  (`invalidate.ts`), and after a Changes tab change (the `git` group).
- **Checks.** `tests/ui/code.test.mjs`: the README first, `t` to a file, a name clicked and its use in another file
  followed, back, Escape.

### The Changes tab as a tree of changes (HE-96)

The lazygit-style view that step 1 brought over (below) is replaced: the Changes tab is laid out as the Code tab is.

- **What it shows.** The task's own work against where it started, uncommitted and untracked files too
  (`git.taskDiff`, as the old Status panel's diff), read again every 4 s while the page is shown. On the left the Code
  tab's `FileTree` of the files in that diff alone (every folder open until closed, each file marked A, D, R or M, the
  finder on `t`); on the right the diff of the file picked, or all of them, with the branch's commits, until one is
  (Esc goes back to all). Every new file is in the tree (`untracked`), though the diff reads only the first 50 new
  files' contents: picking one of the others says so and opens it in the Code tab. A diff cut at 2 MB says so above the
  tree, and the count says `n+`. The file picked and the folders closed are kept for the page's life, by host and task
  (`changesState`), as the Code tab's place is. `j`/`k` go to the next or previous file in the tree's order, `|` switches unified and split.
- **Into the Code tab.** The file's title bar, and each file's header in the diffs, have *Open in the Code tab* (not
  for a deleted file): it sets the Code tab's place (`codeState`, `goTo`) to the file at its first changed line and
  switches the task view's tab (`onShowCode`, from `TaskView` through `TabContent`). Narrow, the Code tab opens on the
  file when it has a place to go to, rather than on its tree.
- **Comments for the agent** stay: lines picked by their numbers (`n`, or a line's comment button) on the branch's
  diff (`branchSource`), the review bar at the bottom, and a comment in it going to its file.
- **Gone.** Staging and unstaging files and lines, discarding, committing, amending and rewording, stashes, resetting,
  the commits and the agent's turns as panels, and the keys and dialogs for them (`git/{MainPanel,SidePanels,Panels,
  Dialogs,useGit*,useStaging,useFileDiffs,useShownDiffs}`, `diffs.ts`'s `linesPatch` and `fileRows`, `DiffLines`'s
  cursor and hunk buttons). A turn is still rewound from the thread. The server's `git.*` writes stay, for a later
  view or a client that wants them.
- **Checks.** `tests/ui/changes.test.mjs`: only the changed files listed, a file's diff alone, `j`/`k`, Esc, a folder
  folding, the finder, *Open in the Code tab* to the file's first changed line and back, new changes coming, the page's keys left
  alone. `tests/ui/lineComments.test.mjs`: comments on the branch's diff.

### Step 1 as done for `changes/` (4.2, HE-5)

Superseded by HE-96 (above): kept as the record of what came over.

- **What came over.** All of the old `components/changes/` but `Compare.tsx`: `Changes.tsx`, `DiffLines.tsx`,
  `diffs.ts`, `lineComments.ts`, `highlight.ts` with its worker, and `git/*`. The task view's Changes tab mounts it as the
  old one did (a `preloadable` chunk, preloaded as the task opens: `preloadTabs` in `task/view/TabContent.tsx`). The old
  view of a host from before API 66 (the branch's whole diff alone) is gone: every host here has the git methods.
- **Calls.** `api.git*` became `rpc(host, "git.status" | "git.diff" | "git.show" | "git.stage" | …)`, `api.diff`
  `git.taskDiff`, `api.turnDiff` `checkpoints.turnDiff`; the turns are `useTurns` (4.3's atom, which follows the
  `checkpoints` event, so the old `turns.reload()` after a rewind is gone). No client atoms were added: the tab keeps its
  fetches in hooks as step 1 allows. The status is still polled every 4 s while the page is visible and nothing is being
  changed, and read again when the agent starts or stops or the worktree changes, as the old `useGitStatus` did; the
  other reads (a file's diffs, the branch's, a commit's, a stash's, a turn's) go through one hook, `git/useLoaded.ts`
  (read again when its key changes, an answer the same as the last kept as it was, so what's picked in a diff stays).
- **Line comments.** The review (`ia.review.<host>:<task>`, the old key and format) is `lineReviewAtom` in
  `state/drafts.ts` (a schema, kept for the page's life, the browser's storage when it can, another tab's changes read
  again on its `storage` event); `lineComments.ts` keeps the old functions over it. The composer shows the comments and
  sends them with the message (`withComments`); they come off the review once the send has gone, through `onSent` on
  @huntaway/client's `SendMessage` (added for this). "Send to the agent" in the tab sends them alone (`tasks.send`).
- **Smaller changes the lint asked for.** The effects that reset state when a file or a patch changed now adjust it
  during render; the waiting keys are taken in an effect through `useEffectEvent`; the comment button's handlers are
  kept in a ref written in a layout effect; lines and runs are keyed by their position in the diff (they have no other
  identity); the worker listens with `addEventListener` and answers with `{ transfer: [] }`. The highlight worker builds
  with Vite+ as it did (`worker: { format: "es" }`, Shiki's grammars one chunk each) and was checked to colour a diff.
- **Cut.** Compare (fan-out) waits for 6.11: it reads and picks through `tasks.fanout`, which isn't on this server
  (noted in `task/view/details/TaskLists.tsx`).
- **Checks.** `tests/ui/changes.test.mjs` (the old checks, a commit added) and `tests/ui/lineComments.test.mjs` (on
  `--fake-claude`): the old checks that slowed `/git/diff` and `/git/show` with `page.route` hold `git.diff`/`git.show`
  with `routeRpc`; "outside the tab the page's keys work" is shown with the next profile's board (`p`), as the assistant
  isn't on this server. Unit tests: `tests/unit/changes/{diffs,lineComments,highlight}.test.ts`, every old case
  (`diffs` drives git through `node:child_process` as the old one did).

### As built in 6.10 (HE-7): computer use

- `settings/HostDesktop.tsx` (the old one: install, check, remove, the switch; `rpc(host, "desktop.*")`, polled every
  15 s, every second while installing) is a component for the host page 6.12 brings; nothing mounts it yet.
- `task/Desktop.tsx` (`useDesktopOn(hostId)` from `desktop.status`, cached a minute; `DesktopButton`; `DesktopPane`
  polling `desktop.frame` every 700 ms and `desktop.ops` every 3 s) is in the task view: the button beside the tabs on a
  host with computer use on and a driver, the pane beside the main area (half the width while wide, in its place when
  narrow; it expands a side panel), the column beside the main area giving way. Its share stays fixed; the browser has
  the splitter (HE-62), and the two are open one at a time. The old capability check (`hostHas(host, DESKTOP)`) is gone.
- Checks: `tests/ui/desktop.test.mjs` (`--fake-claude --fake-desktop`: a run's desktop calls over its own server, then
  the pane shows the window and what it did; no button with computer use off) and `tests/ui/driver.test.mjs` (the old
  checks of `scripts/ui-check.mjs`; its sandboxed frame is a page of the check's own until documents come, 6.2).

### As built in HE-62: the task's browser

- `task/Browser.tsx`: `BrowserButton` (a globe beside the tabs, on every task) and `BrowserPane`, beside the main area
  with the old pane's splitter (`BrowserBar.tsx`'s `useBrowserShare`, `ia.browserShare` in `state/prefs.ts`; in the main
  area's place when narrow). In the desktop app, when the board's server runs on the app's own machine
  (desktop.json has no `serverUrl`: the preload exposes `paneDebugger` only then, `huntaway:pane-local`) and for a task
  on that server's host (`localHostId`), it is `BrowserWebview`; everywhere else `BrowserStream` (a remote server's
  tasks' localhost is that machine's, and its agents mustn't reach this one's network). `BrowserBar` is the address bar both have (`browserUrl` from
  `@huntaway/shared`, which the agent's `navigate` uses too).
- `BrowserWebview.tsx`: the old pane's <webview> (`persist:huntaway-browser`, popups in the pane, DevTools, open in the
  system's browser, the last address in `ia.browser:<host>:<task>`), which an empty pane starts at the agent's page
  (`browser.status`): it starts at the first web address it learns of (the saved one, the task's preview, the agent's
  page) and keeps it; while it has none it reads `browser.status` every 2 seconds, so a page the agent opens later
  comes into the pane. Once the webview is ready it takes its debugger through the preload's `paneDebugger` and opens
  `/api/browser/<ticket>` with a `browser.pane` ticket: the server's CDP commands go to the debugger and its answers and events come
  back. A dot in the bar says whether the agent is connected. Closed, it stays mounted for the task it was opened on
  (`TaskView`'s `keptFor`; never for a task viewed after), off-screen at a page's size rather than `display: none`,
  so its page stays and still draws for the agent.
- `BrowserStream.tsx`: a canvas the socket's JPEG frames are drawn on (`createImageBitmap`), each acknowledged once
  drawn; the pane's size is the page's (a `ResizeObserver`, after 150 ms); mouse, wheel (a non-passive listener), keys
  and pasted text go back as JSON. It shows the download of Chrome as it goes, and says so when the desktop app has the
  page. Unmounted when closed: the page stays on the host. An `error` before the page has shown (no Chrome, its
  sandbox) is final, with Retry (a new stream); after, it's a dismissable note. A socket the server closes (the page went) is opened again
  with a new ticket. HE-93: the socket is on the task's host (`hostSocketUrl`, as the terminal's): through the hub's
  relay for a task on another host, which passes no query on, so the pane's size and start address go in `browser.open`
  as well as the socket's query (the ticket's win; the query is for a server before HE-93).
- The desktop shell: `main/paneDebugger.ts` (`huntaway:browser-debug`, `-send`, `-undebug`; only the board's own frame,
  only for a <webview> it embeds, and refused in remote mode; events relayed as `huntaway:browser-event`), and the
  preload's `paneDebugger`, given to the board only when `huntaway:pane-local` (`paneIsLocal`) says its server is here.
  HE-67: and `setBrowserProxy` (`huntaway:browser-proxy`), which `BrowserWebview` calls with its host's `socks_proxy`
  before it mounts the webview and whenever it changes; the main process sets it on the pane's session
  (`paneProxy` checks it) and closes its open connections.
- Looked at in a browser (a test server on this machine's Chromium, `ui-check.mjs`): the pane opens beside the thread,
  an address typed loads, clicks and keys reach the page, a link and Back work, a second task's page streams beside it,
  and the phone layout puts the pane in the main area's place. The desktop app's <webview> path has its server side
  tested (`Browsers.test.ts`) but hasn't been run in Electron here.

### As built in 4.8 (HE-5): web

- **Wired** (the cuts M1/M2 left for merges and stacks), each through `@huntaway/client`'s mutations
  (`useAtomSet(…, { mode: "promise" })`), what comes back arriving as events: a held task's choice of where it merges
  now (`board/MergesInto.tsx` `HeldChoice`: onward, close, or one of them taking the closed task's place:
  `tasks.mergeTarget`, called on the first of them, as before); merging a whole stack from a gathered stack's menu
  (`board/taskBoard/useBoardStacks.tsx`: `checkOf` is `mergeCheck` again on every host, `tasks.mergeStack`, the server's
  refusal shown as "Couldn't merge the stack: …"); a stack's title and description edited or written again
  (`board/StackCard.tsx` `StackEditModal`, `tasks.updateStack`; `hasMeta` is true on every host); the Details panel's
  "Stacked on"/"Lands after" and "Landing after this"/"Stacked on this" sections (`board/stackSections.tsx`, already
  split out of `StackedOn.tsx` so it and `MergesInto.tsx` don't import each other); and the New task dialog's branches
  after `from:` (`layout/newTask/useTokens.ts`, `projects.branches` read once a `from:` is typed, in an effect as the old
  one was). The merge approval card needed nothing: `task/thread/requestCards.tsx` already answers it through
  `threads.answerQuestion` and shows approved/denied.
- **Looked at in a browser** (a `--seed` test server, `ui-check.mjs`): a gathered three-level stack merged from its menu
  (all levels in Ready for merge, "Merging the stack: 0 of 3 landed"); a stack whose top level has no work refused with
  the server's reason; the edit dialog saving a title by hand; a task whose target was closed choosing "Go where TES-4 was
  going" (its thread says "Merges into main now, instead of TES-4"); a level on a closed level closed with it ("Close it
  too"); Up's "Lands after" and Low's "Landing after this"; `from:` listing the project's branch `main` (the tasks' own
  branches stand behind their keys); and, with `--fake-claude`, the approval card after the summary run, Approve
  deciding the merge ("approved", "Merge approved: …", and the merge request sent).

### As built in 6.1 (HE-7): web

- **The Terminal tab and the terminal tools** in the task view (`task/TaskView.tsx`, the old code back where step 1 cut
  it): the tab on every task, the host's tools beside the tabs, terminals mounted from their first visit and kept while
  the tab changes, a terminal tab in the side panel expanding it into the dialog, a tool taken out of the host's settings
  ended. `task/Terminal.tsx` is the old pane: the socket is `/api/terminal/<ticket>` on the task's host, with a ticket
  from `terminal.open` asked for each connection (a ticket that can't be had is retried as a dropped socket is). The
  client's `hostSocketUrl` puts it on the page's own server for its own tasks, and through the hub's relay (a relay
  ticket for that path) for a task on another host (HE-74: the pane first opened every task's terminal on the page's own
  server). The relay passes no query on, so a relayed terminal starts at the host's default size and takes the pane's
  from its `resize` frames: one on open, and the same again on the first output, since a host whose pty helper predates
  HE-74 could lose a resize that came while its terminal started.
  A terminal is still made once its font has loaded and a frame later, and reset before re-attaching; Restart and
  Reconnect remount the pane (`key`), which the lint's effect rules asked for in place of an `attempt` dependency, and
  the connection's mutable state is one object in the effect. xterm's styles are imported by `index.css`.
- **Open tools** are `task/terminalTools.ts` (the old store on `smallStore`, `ia.openTools` in sessionStorage), kept
  alive every 30 s once signed in (`App.tsx`). `settings/hosts/TerminalTools.tsx` (`TerminalToolsRow`) edits the host's
  `terminal_tools` with `host.updateSettings`; the settings come with the board, so there is nothing to load. It is
  mounted by the host page (6.12); it was checked by mounting it there for a moment.
- **Checks**: `tests/ui/terminal.test.mjs` (the old checks, the status and ticket held with `routeRpc`, and a real tmux).

### Step 1 as done for 6.11 (HE-7)

- **Add project** is back in the sidebar (`layout/Sidebar.tsx`, "+"), opening `settings/NewProjectModal.tsx`: a folder
  (`projects.create`, with the folder browser `settings/DirPicker.tsx` over `host.listDirs`, ported here though it is
  6.12's), "Create a GitHub repository for it" (`projects.createOnGithub`; a repository made but not pushed says so and
  waits for "Open project"), or the GitHub tab (`settings/GithubRepos.tsx`'s picker over `profiles.githubRepos`, then
  `projects.clone`). `settings/repoSource.ts` keeps the old helpers and the `ia.newProjectSource` key. The old modal's
  host picker is back (HE-38): with more than one host that runs agents, a Host field (`hosts/profileFields`'
  `HostSelect`) picks where the project goes, and the folder browser and GitHub picker follow it. On a host without the
  picked profile, the dialog makes it there first (`profiles.create`) with the configs ticked in a `ConfigPicker`, or,
  when the host has no configs, with the folder typed as its first config (`configs.create`), as Settings → Profiles
  does.
- **The compare view** (`changes/Compare.tsx`) mounts over the page from `App.tsx` on `?task=…&compare`, from a card's
  model badge (`board/Fanout.tsx`), a card's menu ("Compare all N from its prompt") and the Details panel's Same prompt
  section. Facts and the pick are `tasks.fanout` and `tasks.pickFanout`, each one's diff `git.taskDiff`; the facts go
  through `changes/git/useLoaded`. `ReviewVerdict` is back in `task/Review.tsx` for it.
- **Asana** (`task/ExternalLinks.tsx`): the Details panel's Asana section, the cards' link icons, and the New task
  dialog's "Link Asana task" (`layout/newTask/OptionsRow.tsx`, `useDraft.ts`, `NewTaskModal.tsx`). The search is
  `profiles.asanaTasks`; connecting is `profiles.update`'s `asana_token`. A search failing `Unavailable` (off, not
  connected) or `External` "didn't accept the token" asks to connect again. `AsanaAccount` (connected as…, disconnect)
  is exported for 6.12's profile form.
- **`settings/hosts/CopyLoginModal.tsx`** is a component taking `hosts` (where a login can go) and `copy` (the hub's
  `hosts.copyConfig`, 7.5, over `configs.exportArchive`/`importArchive`): 6.12's ClaudeConfigs and HostPage mount it
  once those exist. A profile's own config folder is gone with `claude_config_dir`, so only a config is copied.
- **Checks**: `tests/ui/{githubClone,githubCreate,compare,fanout,fanoutCodex,fanoutConfigs,asanaLinks}.test.mjs` and
  `tests/unit/repoSource.test.ts`. The old `page.route` answers are `routeRpc` ones (`profiles.githubRepos`,
  `projects.createOnGithub`, `configs.models`, a failing `tasks.create`), a held models call is checked with the calls
  the page made rather than a sleep, and githubClone adds a list and clone through the fake gh. A set of configs' models
  is asked for together (5.3's `configModelsAtom`), so the old "another config's come in first" can only be shown as
  both loading. Dropped: asanaLinks' "moves between hosts before and after Asana links" (a second host, M7, and hosts
  before API 57). `scripts/test-server.sh` gives the server `$HUNTAWAY_ASANA_URL` (a test's fake Asana), else an
  address with nothing on it, so a test server never reaches Asana.

### As built in 6.4 (HE-7): web

- **Came over.** `settings/agentTools/GlobalAgentToolsPanel.tsx` (Settings → Skills and MCP, in place of its
  placeholder), `SkillsSection.tsx`, `McpSection.tsx`, `SkillSources.tsx`, and `parts.tsx` (the old `AgentTools.tsx`'s
  `Section`, `OtherList`, `describe` and McpSection's `serverSummary`, apart so the files don't import each other);
  `settings/AgentTools.tsx` exports `ProjectAgentTools`, which 6.12's project settings mount under their Skills and MCP
  tab; `settings/AgentStepTools.tsx` (with `stepToolChoices`) for 6.6's workflow inspector; `task/SkillMenu.tsx` works
  (`tasks.skills`, kept a minute per task and config as before; `/compact`, `/plan` for a task, `/new`; HE-102: a
  Claude task's `/output-style` and its styles, [07-agents.md](07-agents.md#output-styles)). Calls are
  `rpc(host, "agentTools.…")`, read again after a change, as the old ones were. The project settings' Agents tab had no
  agent-tools part.
- **Changed.** Every host has sources, subfolders, `/plan` and `/new`, so the API checks are gone; the host picker waited
  for M7 (the page's own host), and came back in HE-41: with more than one host that runs agents, a picker says whose
  tools these are, starting on this board's host if it has profiles, else on the first that has (a board whose own
  host has none showed tools no agent got, with no profile to switch them on). The host is settled once the board
  has loaded and kept while it's offline, so the panel doesn't remount (losing an open editor) or move to another host
  when a link drops; the picker lists it as offline (`tests/ui/globalAgentToolsHost.test.mjs`);
  the menu's state is adjusted during render and its list keyed by task and config
  instead of a ref the lint refuses.
- **Checks.** `tests/ui/skillSources.test.mjs` (the old one, and a global skill and server added, switched, refused and
  deleted), `tests/ui/agentTools.test.mjs` (fast switch clicks, with `agentTools.updateProject` held by `routeRpc`; it
  opens `/p/<id>/settings/tools`, so it passes once 6.12 mounts `ProjectAgentTools` there: run against a temporary
  mount), and `messageBox.test.mjs`'s two dropped cases back (`/` and `$`). Not ported: `forkedSkills.test.mjs`, which
  checks a forked Skill's subagent in the thread through the Agents list (not on this server) with the old translator's
  messages, nothing of agent tools.

### Step 1 as done for `settings/` (6.12, HE-7)

- **What came over.** The Settings shell's conditions (Agent configs and Skills and MCP only with a host that runs
  agents, Assistant with a profile, Archived projects with a profile), `ClaudeConfigs` (with `ConfigPicker`,
  `ConfigSelect`, `ConfigUsageNote`, `AgentBadge`), `Usage` (the sidebar's usage panel, asking each host's `host.usage`
  every 5 minutes; what comes back arrives as `usage` events), `hosts/ProfilesPanel`, `ProfileForm`, `profileFields`,
  `AgentDefaults`, `TintField`, `Shortcuts`, `Guide` with `src/guide.ts` and `docs/guide/` (the old repository's pages,
  copied byte for byte and bundled as the old app did, so no server route; their links out of the guide still go to the
  old repository until 9.3 brings them into line), `Onboarding` (in place of App's note), `DirPicker`, `TemplateField`
  with `src/templateCompletion.ts` (it reads a `TemplateGraph`, which 6.6's `WorkflowGraph` is), the `ArchivedProjects`
  panel (the board's `archived`, so nothing is fetched), `repoSource`, `versions`, `uiVersion`, the `HostPage`, the
  `ServerPanel` and `NetworkPanel`, and `project/*` (`ProjectSettings` and its General, Agents, Worktrees, Review,
  Prompts and Status scripts tabs). `task/Reviewers.tsx`, which the profile form and the Review tab use, came with them.
  `components/ui/usageConfigs.ts` has the rest of the old `usageConfigs.ts` (`usageConfigs`, `usageAlert`, `WARN_AT`,
  `resetsPhrase`); `boardHelpers.ts` has `profileConfigLabel`.
- **A new build.** `state/uiBuild.ts` reads the page the server serves at `/` through `effect/http`'s fetch client in an
  atom runtime (`servedUiBuildAtom`); `useNewUiBuild` refreshes it on focus, on a reconnect and every 5 minutes, and the
  sidebar's `ReloadButton` offers the reload.
- **Decided where the old code had a host-version branch.** Every host has every setting: the API gates are gone, a
  profile's and a project's summarizers are always a list, a profile always has configs (with none on the host yet, the
  folder the profile form names is made its first config, named after the profile, as the old server did), and the
  Agent defaults row reads the board's `hostSettings` rather than fetching (its "Keep threads as items" switch is gone
  with threads on messages). The Prompts tab's preview has no Subproject type. Reviewers' and summarizers' optional
  `name`, `prompt` and `skills` are left out when unset (`withField`), as the wire has them.
- **Marked slots, for the areas that bring them.** Agent tools (6.4): the Skills and MCP project tab, and the skills a
  reviewer or summarizer picks from (names are typed until then). Automations (6.5) and Workflows (6.6): their project
  tabs, and the Review tab's note on which workflows take reviews over (it says what using workflows means until then).
  6.11: gh's accounts in `GithubAccountSelect` (`profiles.githubAccounts`, a stub that lists none), config archives, and
  connecting Asana (`AsanaAccount`). Terminal tools (6.1), Telemetry (6.9) and Desktop (6.10) are `Slot`s on the host
  page.
- **The project settings laid out again (HE-32), where the old page was copied.** What a setting does is behind a ?
  beside its label (`ui/Help.tsx`: shown while the pointer or the keyboard's focus is on it, kept open by a click, placed
  in the window so the scrolling page doesn't cut it off), not in a line under the field, and says less. `Field` takes
  it as `help` (the ? is beside the label's text but outside the `<label>`), a switch as `ToggleField`, a tab as its
  `help`, the agent tools' `Section` as `help`. Only what a field's state says stays under it (what a profile's
  reviewers are, what saving a changed repository path does). The tabs are in four groups down the side, with a line
  between: General; Agents, Skills and MCP; Worktrees, Prompts, Review, Pull requests (a task's way to merged);
  Workflows, Automations, Status scripts. Pull requests (`/settings/pull-requests`, `PullRequestsTab.tsx`) is the half
  of the old Review tab that wasn't reviews or summaries: the pull request switch, watching and previews, then
  _Merging_ (GitHub approval, merge approval, Done when merged). Within a tab, settings that belong together are under
  a heading (`settings/parts.tsx`'s `Group`). The project's own agent configs are a select like its other inherited
  settings, and the prompts are named Start, Review and Merge prompt.
- **The board's settings laid out the same way (HE-39).** `/settings`'s tabs keep their ids and labels (so
  `Settings → <label>` in the UI and the guide still names them) and are in four groups down the side, with a line
  between: Hosts, Profiles, Archived projects (the board); Agent configs, Skills and MCP, Plugins, Assistant (what its
  agents run with); Notifications, Keyboard shortcuts (this browser); Server, Network access, Experiments (this
  server). Hosts is still the tab `/settings` opens on. Each panel starts with `settings/parts.tsx`'s `PanelHeading`,
  which the project settings use too: its label, one line on what it's for, the rest behind the ? beside the label,
  and its buttons at the right (`small` is the Server panel's on a host's page, which is not laid out again). The
  paragraphs the panels opened with are that line and that help. Within the panels: an experiment's description, the
  uplink switch's (a host that dials in keeps one amber line under it while it's on), Nearby hosts' and the scratch
  host's are behind a ?; Notifications is _Notify with_, _When a task_ and the count, then _Push to this device_ as a
  `Group`, with what each event is in the ? beside the list rather than after each name; Network access is the URL
  alone (the data folder and version it ended with are Settings → Server's); Skills and MCP's heading is its tab's
  label. A profile's form (`hosts/ProfileForm.tsx`, also the first profile's on a fresh board and a host's page's) is
  its name and tint, then _Agents_ (configs, default model, the assistant's and threads' agents, running out of
  usage), _GitHub and Asana_ (account, clone folder, Asana), _Review and merging_ (reviewers, summarizers, the two
  approvals) and _Access_ (other profiles' agents, the assistant's host, telemetry), each setting's text behind its ?
  (`ToggleField` for the switches, which no longer say one thing on and another off under them). An agent config's
  form has its hints behind ? too. Escape closes help that's kept open in a dialog, not the dialog with it (`Modal`
  leaves an Escape that something in it has taken).
- **HE-6's parts, after it merged.** Settings → Server is the old one over `admin.status` (polled, and on focus) with
  `host.info`'s machine and data folder: Rebuild & restart, Update to a deployed commit, the source checkout and the
  deployment and their new commits, and under `settings/server/` the release checks (`Releases`: Check now, the
  download, prereleases through `host.updateSettings`, Roll back), the desktop app's own update (`ShellNotice`, its
  preload's `shellUpdateKind`/`updateShell` read with `Reflect` as notifier.ts does), and `RestartModal` (restart,
  `admin.update`, `admin.updateRelease`, `admin.rollback`). This host's restart is followed by the board's `restart`
  (its `restart` and `restart_log` events): where the old modal set the store's restart to "starting", it keeps the
  board's restart as it was when it asked and shows "Starting…" until that changes. Since HE-44 a restart in progress
  shows its steps (`RestartProgress`: download, check, install or fetch and build, then stop and start again) with a
  bar that fills where a step's share is known (the release's download from `release_download` events, kept on the
  board's `restart`; the new server's backup and migrations as the desktop app relays them, its preload's
  `onServerProgress`) and moves otherwise, and says not to reload. "Start again" begins once the board's connection
  drops. After 2 minutes it says the server hasn't come back, lets the dialog close, and goes on polling `admin.status`,
  so a server that comes back late still reloads the page. While the board first loads (`authed` or the first board not
  there yet) the page says "Loading the board…" after a moment, rather than staying blank. The sidebar has `UpdateButton`
  again. The host page has `HostVersion`, settings sync (`hosts/SettingsSync.tsx` over `settingsSync.get` and
  `resolve`, read again when the host's settings change), a linked host's `RemoteServer` and any host's `HostService`
  (`server/RemoteServer.tsx`, polling that host's `admin.status` through the relay, as its events go down with it), and
  Remove (`hub.hosts.remove`). `CopyLoginModal` is mounted from Agent configs and the host page's configs with the
  board's connected hosts that run agents and `hub.hosts.copyConfig`, whose `files` are now the archive's entries (it
  said how many) and which now copies through 6.11's archives (08-hosts.md). HE-6's row Update is the old one again:
  it sends the hub's checkout as it is (`hosts/useUpdateCommit.ts`, the hub's `admin.status`), a release host only a
  newer version, follows the host's phases by polling it, and ends on its new boot. Since HE-76 it updates the whole
  cluster: Update on one host is sent to every other host the hub links itself that it is offered for too (not a mesh
  host, which its own neighbour links), a few at a time (the hub makes their bundles one at a time: `Updater`'s
  `bundleSince`, in its one `outgoing.bundle`), and the button says how many (`· all 3 hosts`). Each host's
  Update is followed to its end in the action that sent it (`hosts/hostUpdate.ts`: the host's `admin.status` polled,
  and the hub's list for it back on what it was sent), not on its row, and kept per host (`hostUpdateAtom`), which the
  rows show; so one started from a host's page ends for the hosts with no row shown too. A host whose server runs the
  hub's commit or one after it (ahead of the hub) answers up to date rather than restarting (`Updater.runsAlready`).
- **Dropped.** Settings → Server's database line and Copy again, and the threads' batch rebuild (docs/plan/14: the
  two-file database scheme, moving threads onto items). The paired phones under Network access came back with device
  pairing (HE-91): Pair a phone shows the PIN with how long it is good for and the tries left (the list is read every
  2 s while it shows, so the phone that pairs appears and the PIN goes), and each phone with Unpair.
- **Checks.** `tests/ui/projectSettings`, `proxyConfig` (on `--fake-claude`: Agent configs need a host that runs
  agents), `reviewerOptions`, `summarizers`, `systemPromptPreview`, `guide`, `settingsPanels` (the old `confirmErrors`'
  refused profile delete through `routeRpc`, a shortcut's key, onboarding) and the unarchive half of `archiveProjects`.
  Changed from the old checks: a tab of another area is waited for by its heading; `reviewerOptions` types its skills;
  `summarizers` no longer reads the single `summarizer`; `guide` opens the workflows page by its address (the old check
  followed the Workflows tab's link, 6.6's); the shortcut moved is the search field's (Triage isn't on this server).
  Not ported: `databaseFile` (dropped), `worktreeSetup` (the board's setup thread, not a settings panel: ported in HE-8 with `task/WorktreeSetup.tsx` in place of the board), `devices`
  (deferred), and the settings checks of other areas (`telemetry`, `skillSources`, `agentTools`, `automations`,
  `workflows*`, `githubClone`, `githubCreate`). With HE-6's parts: `hostRelease`, `hostUpdate`, `releaseUpdate` (the
  old `release-update`) and `nearbyHosts`, with `tests/ui/servers.mjs` answering `admin.*`, `hub.hosts.pushUpdate` and
  rewriting what the hub says of its hosts on the page's socket and the relays (where the old checks routed
  `/api/admin`, `/api/h/<host>` and `/api/hosts`), and pushing `restart` events on the board stream; the linked hosts
  are a second test server. New: `hostPage` (a config's login copied to a linked host for real, settings sync switched
  on there, Remove). Not ported: hostUpdate's "the events socket reconnects at once when the network comes back"
  (HA-38): the client's session retries on its own schedule and does not listen for `online`, which is
  `packages/client`'s to decide. The old checks' `fastClock` is gone: the polls they sped up (1.5 s) fit in a step.

### As built in 6.8 (HE-7): notifications and push

- **`state/notify.ts`**: which changes notify (`taskEvent`, `stillApplies`, `notificationText`, `attentionCount`), the
  settings under `ia.notifications` and own moves under `ia.movedHere` (noted by `boardHelpers.moveTask` before its
  request), read from the browser's storage each time as the old ones were (another tab changes them). The DOM half is
  `components/layout/notifier.ts` (one notifying tab by Web Lock or `ia.notifyLeader`, `ia.focusedTask`, the chime, the
  count in the title, icon and the desktop app's badge, `setTitleProfile`), under the components' lint override for
  timers and `Date`. Live changes come from the client's `onLiveTaskChange` (`board/live.ts`): `watchBoard` calls it
  for a task event numbered after its `hello`, never for a snapshot or a replay after a reconnect.
- **Push**: `components/layout/push.ts` (the old `push.ts`, calling `hub.push.*` through `state/rpc.ts`'s `hubRpc`),
  `public/sw.js` without Allow and Deny, and `layout/Notifications.tsx` as the old one but its prompts hint. Both start
  in `main.tsx`.
- **Checks**: `tests/ui/push.test.mjs` (a `--fake-claude` server: the agent's permission prompt is the move that
  pushes) and `tests/ui/notifications.test.mjs` (moves by `tasks.update` in place of the old fed websocket; a stopped run
  through the fake agent). The harness's `withBrowser` takes `fullBrowser` again (the full Chromium: notifications,
  service workers). Not ported: answering a prompt from its notification (deferred), a hub's linked hosts (M7).

### Step 1 as done for a task's documents (6.2, HE-7)

- **What came over.** The old `task/Document.tsx` (its view only: the labels' names and badges were `documentInfo.tsx`
  already), `htmlFrame.ts`, `mermaid.ts`, `planAnswers.ts`, `planTheme.ts` and `planTheme.css`, under `task/`. The task
  view's document tabs mount `DocumentView` in place of the placeholder (`task/view/TabContent.tsx`).
- **Reads and calls.** The document is `taskDocumentAtom({ host_id, task_id, label, version })` in `@huntaway/client`
  (`board/taskDocument.ts`, read again as the task's `document_at` changes, as the old view refetched on it). Sends (the
  answers, "Ask the agent to fix it") are `rpc(host, "tasks.send", …)`; the old page-wide `ia-plan-answers` event is a
  module-level set of listeners. The unsent answers are `loadPlanAnswers`/`savePlanAnswers` in `state/drafts.ts`, under
  the old `ia.planAnswers:<host>:<task>` key, read from the browser's storage each time as before. The host-version check
  for sending while the agent runs is gone.
- **What the lint asked for.** The code that runs in a frame as source (`keepPlace`, `linksInNewTabs`, `noWebRtc`,
  `iaForm`…) stays self-contained, so its helpers use a constant of their function rather than moving out of it; a
  worker's URL goes into its script `encodeURIComponent`d rather than as JSON; the frame's document is set in a layout
  effect (`setAttribute("srcdoc")`), which reads where it was scrolled to and the answers then, rather than in a memo
  during render; `withPlanDiagrams` renders the diagrams side by side (Mermaid queues its renders itself).
- **Checks.** `tests/ui/plan.test.mjs`, `planDiagrams.test.mjs`, `planTheme.test.mjs` and `documentCsp.test.mjs` (the
  old ones), on the demo board (`--demo`), with `tests/ui/documents.mjs`: a document's contents and a send's answer are
  given on the page's RPC websocket (`routeDocuments`; agents are off), and "a version written over" gets its `task`
  event the same way. Skipped, with its reason in the file: "a touch held on the board doesn't let a plan open a link",
  as on Chromium 155 the board's activation after the held touch didn't run out while the plan kept taking the focus.
  `markdownImages.test.mjs` is about a task's description (Markdown), not its documents, and isn't ported here.

### Step 1 as done for `docs/` (6.3, HE-7)

**Replaced in HE-42**: published documents are the docs plugin's now ([15-plugins.md](15-plugins.md#the-docs-plugin-he-42)); what follows is what the web app had until then, and is gone. Left: `task/thread/DocLink.tsx`
and `PublishedDoc`, over `task/thread/docLinks.ts`, which open a document's link as the plugin's page.

- **What came over.** The old `components/docs/` whole (`DocsPage.tsx`, `DocComments.tsx`, `HostedDocs.tsx`,
  `docFrame.ts`, `docsPage/*`), and the old `src/docs.ts` as `components/docs/docs.ts`; the sidebar's Docs entry
  (`layout/sidebar/DocsEntry.tsx`, the old `ProfileEntries.tsx`'s half, as the assistant's is 6.7's); a thread's
  "Open … in Docs" for a `publish_document` call (`task/thread/tools.tsx` `PublishedDoc`) and links to documents in
  messages (`task/thread/DocLink.tsx`: they open in the board and show the document's title). `task/htmlFrame.ts` is
  6.2's file, taken as it is (the frame's policy and its scripts).
- **Calls and events.** `api.*` became `rpc(host, "docs.…", …)`; the old `onDocs`, `onDocsSite`, `onDocComments`
  listeners are `useDocsChanged`, `useDocsSiteChanged` and `useDocCommentsChanged` (`docsPage/hooks.ts`), which
  subscribe to `@huntaway/client`'s `docsSeqAtom` (a `docs` event names the profile, so the page reads again for any of
  its documents). The host-version checks (`hasDocs`, `hasDocLabels`, `hasDocFolders`, `hasDocComments`,
  `hasHostedDocs`) are gone: every host has them. The view and closed folders stay in `localStorage` under their old
  keys (step 2 makes them atoms).
- **Smaller changes the lint asked for.** The frame's source is set on the frame in a layout effect (as 6.2's
  `Document.tsx` does), so where the reader was is read when it's drawn, not in a render; the comments' marks are a
  memoised message posted in an effect; the functions that run inside the frame keep their helpers inside them (one
  captures `document`, the context matcher is inlined).
- **Checks.** `tests/ui/docs.test.mjs` (plus the board's `frame-src 'self'`), `docFolders`, `docLinks`, `docComments`
  (on `--fake-claude`: sending starts DEMO-5's agent) and `hosted_docs` (a stub site in the check, as before), all on
  `--demo`; `tests/ui/docs.mjs` writes documents into the test server's database as `threads.mjs` writes threads. Unit:
  `tests/unit/docs.test.ts`, every old case. Not ported here: `documentCsp.test.mjs` (plans and artifacts, 6.2's) and
  `markdownImages.test.mjs` (images in a task's Markdown). The old check's count of the page's HTTP requests for a
  version is gone with HTTP.

### Step 1 as done for workflows (6.6, HE-7)

- **Files.** `settings/Workflows.tsx` (`ProjectWorkflows`: the list, its switch, the editor, "Use workflows") and
  `settings/workflows/*` (the canvas editor, its inspectors, presets, text, geometry and hooks), `settings/TemplateField.tsx`
  and `templateCompletion.ts` (as 6.12 copies them), `task/Workflows.tsx` (the `wf:` tabs, `WorkflowTabView`,
  `WorkflowsList`, `useWorkflowRuns`, `workflowRunning`), `task/thread/workflowChange.tsx` (the approval card's detail,
  reading the approval's graph with the contract's `WorkflowGraph`). The lists come from `workflowsAtom` and
  `workflowRunsAtom` (`packages/client/src/board/workflows.ts`), read again on `workflows_changed` and
  `workflow_runs_changed` as a task's turns are; changes are `mutations.workflows.*`, and nothing reloads after one.
- **Gone.** `legacyGraph`, `set_status` and a start on a status, every API-version check (`COLUMN_WORKFLOWS_API`,
  `AB_TEST_API`, `REVIEWS_IN_WORKFLOWS_API`). A node's field set to undefined is removed, never sent as null
  (`patchNode`). A send step still shows only its `exhausted` port in the editor, as before.
- **Where it mounts.** The project settings' Workflows tab (`/p/<id>/settings/workflows`): until 6.12 brings
  `project/ProjectSettings.tsx` over, its placeholder renders `ProjectWorkflows` for that tab. `settings/AgentStepTools.tsx`
  is a stub (the step's own skills and turned-off MCP servers, no project list to pick from) that 6.4 replaces;
  `task/Reviewers.tsx` has only `ReviewerRow`, as 6.12's. The column preview says "The board's default start/merge
  prompt." for a blank prompt until `host.defaultPrompts` (6.12) gives the text.
- **Checks.** `tests/ui/workflows.test.mjs`, `workflowPresets.test.mjs`, `workflowWires.test.mjs` (the old ones on the
  new harness, through `workflows.*`). Not ported: `graphPicks.test.mjs` (subprojects), the `/settings/review` and
  `/guide/workflows` assertions (6.12's pages), the agent-tools picks of the skills case (6.4).

### Step 1 as done for Analytics and Telemetry (6.9, HE-7)

- **Files.** `components/settings/Analytics.tsx` (the page, in place of the scaffold's placeholder, same props),
  `analytics/*` (Report, Calendar, DayTimeline, range, the hooks), `TokenStats.tsx`, `DiskUsage.tsx`, `disk.ts`,
  `chart.tsx`, `Telemetry.tsx` (`HostTelemetry`), and `components/task/ContextStats.tsx` (the Context tab). The old
  `src/analytics.ts`, `src/tokenStats.ts` and `src/contextStats.ts` moved under the components' lint override as
  `components/settings/analytics/analytics.ts`, `components/settings/tokenStatsData.ts` and
  `components/task/contextStatsData.ts` (names that differ from the components' only in case are avoided).
- **Calls.** The fetching halves stay hand-written fan-outs over `rpc(host, "analytics.…", { profile_id, from, to })`
  to every connected host, one profile at a time, as the old ones were (09's "one query per host, combined by a derived
  atom" is step 2's); a host that fails is named in the page's warnings. The host-version gates are gone. Reclaiming
  disk space is `projects.removeMergedWorktrees`. `HostTelemetry` polls `admin.telemetry` every 15 s and saves with
  `admin.updateTelemetry`; until 6.12 brings the host page over, the scaffold's `HostPage` placeholder shows it.
- **Not changed.** The reports still carry `subproject` (always false now), so the token tables' subproject grouping
  stays as code that never runs; step 2 deletes it.
- **Checks.** `tests/ui/telemetry.test.mjs` (a fake ClickHouse in the check, as before) and `tokenStats.test.mjs`
  (the reports given on the RPC websocket with `routeRpc`; its subproject case is a task with its review thread);
  `tests/unit/tokenStats.test.ts` and `contextStats.test.ts`, the old unit tests unchanged.

### Step 2: by hand, a feature folder at a time

| Pattern in a component                                                             | Becomes                                                                                         |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `useState` + `useEffect(() => { api.x().then(setData) })` + a stale guard (65 guards in 41 files) | `const result = useAtomValue(queries.x(args))`, drawn with one `<Loading result={…}>` wrapper that shows the same spinner and error box |
| Reload on a listener, a focus event or a dependency                                | The query's invalidation keys; `Atom.refreshOnWindowFocus`                                      |
| `setInterval` polling (preview status, restart status, release download)           | A query with `Atom.withRefresh`, or the board event that already carries it                     |
| `useAsyncAction()` and local `busy`/`err`                                          | `const [state, run] = useAtom(mutations.x)`: `state.waiting`, the failure by tag                |
| Optimistic update and rollback written inline                                      | The optimistic mutation in `packages/client`                                                    |
| A module-level cache (`agents.ts` models, `SkillMenu`'s 60 s cache, `DocLink` titles) | A query atom with a time to live                                                             |
| A module-level map for something that outlives the component (a send in flight, memory editors) | An atom kept alive, in `state/` or beside the component                            |

Step 2 is not a condition of switching over to the new server. The plan had it as one task per folder, largest files
first; it was done as one board task (HE-9), the folders side by side. A file left the lint override when it was done,
and the override went with the last one.

### Step 2 as done (M10, HE-9)

- **The shared layer.** `packages/client`: `query(method, host, payload, { refresh, focus })` (`queries.ts`), one atom
  per method, host and payload (payloads compared by value), shared by its readers and kept ten seconds after the last (`plugins.page` not at all, HE-63: 15-plugins.md, Pages);
  `mutate(method, host, payload)`, which reads again every query of the method's group on that host once it has run;
  `invalidate.ts`, the `invalidates` table (other groups a mutation reads again: a rewind or a fan-out's pick the
  `git` queries, a host's settings its `admin` and `settingsSync`, removing merged worktrees the disk usage) and the
  `triggers` table (a query read again when what it picks from its host's board changes: a task's run and worktree for
  its git status and diffs, its column and branch for its branch diff, the `docs`/`doc_comments`/`docs_site` counts for
  the Docs page, `approval_rules`/`approval_log` for the assistant's rules and log, `document_at` for the brief, the
  assistant's run for its memory, a config change for a task's skills, the host's boot for `admin.status`, its settings
  for settings sync and a project's system prompt). The web app: `state/mutation.ts` (`useMutation`, `useAction` with
  `clear`, `runExit`, `isTagged`, `errorText`, `exitError`), `state/clock.ts` (`useNow`, `nowMillis`),
  `state/timers.ts` (`after`, `every`; `after(0)` waits for the browser's next task as `setTimeout(f)` did),
  `state/visibility.ts`, `components/ui/dates.ts` (ISO times and `toLocale…String` through `DateTime`, the browser's
  zone made once) and `components/ui/Loading.tsx`.
- **A run is the page's, not the component's.** `useAction`'s runs go through the registry (`runExit`), so a dialog
  closed while its save, a fan-out's tasks or a clone are on their way doesn't interrupt the call (an interrupted RPC
  is interrupted on the host too). Only its busy and error state is the component's. The client's shared
  `mutations.*` atoms in promise mode are no longer used by components: overlapping calls could resolve with another
  call's result. `ConfirmModal`'s `onConfirm` may resolve with an `Exit` and shows its failure.
- **Deleted:** `state/rpc.ts` (`rpc`, `useRpc`, `hubRpc`), `smallStore.ts` (the selection, drawer, subagent view and
  open tools are atoms), `changes/git/useLoaded.ts`, `useAsyncAction`, the module-level caches (preview checks, the
  skills menu's minute, `DocLink`'s titles, the repository list, the last disk measurement, the attachments' object
  URLs, the memory editors), and the last listed suppression (`type Any = any`: the thread's rows read their metadata
  and tool inputs through `thread/fields.ts`'s guards, and board approvals' inputs through the contract's schemas).
- **Lint.** The components' override has the React rules only. (`components/docs/docFrame.ts` kept `global-timers`
  off until HE-42 removed it with the rest of the Docs page.)
- **Decided where this page was silent** (each folder's commit says more):
  - Polls are a query's `refresh` while the page is visible (git status 4 s while nothing is being changed, previews
    2 s, `desktop.frame` 700 ms, `desktop.ops` 3 s, telemetry and desktop status 15 s, a host's usage 5 minutes). The
    old limit of two preview checks at once (HA-188) was for the browser's six HTTP connections; they share the RPC
    socket now.
  - Reads across hosts (analytics, token statistics, disk usage, docs, a routine's thread, a doc link's title) are one
    query per host combined by a derived atom; a host that fails is named in the warnings as before.
  - The branch diff is polled with the status rather than read again when the status's content changes; `useKept`
    keeps an unchanged answer as the same object, so what is picked in a diff stays picked. Compare's pick dialog reads
    the facts again as it opens.
  - Persisted choices that were read straight from `localStorage` are atoms over the same keys and formats (the docs'
    view and closed folders, the changes' layout and tree, compare's mode, the analytics choices, the sidebar's
    groups and marks, pens' tabs and rows, the tracked list's filter, the open tools). `ia.board.stackViews` holds
    booleans, as the old board kept it. A key `Atom.kvs` reads first is written with its default (`[]`, `null`), which
    the old build reads the same. Exceptions: the New task dialog's per-target choices and `useActiveProfile` still use
    storage directly, since their atoms don't map one to one.
  - Reports and lists are kept ten seconds after their last reader rather than for the page's life or not at all:
    analytics tabs, the GitHub repository list, a task's skills, Asana searches, a document's images.
  - Memory files are read again on the assistant's turns and after any `assistant.*` change, not by modified time.
  - The subproject grouping in the token tables is deleted (reports' `subproject` is always false).
  - The code that runs inside a plan's frame holds its scroll with `performance.now()` on resize rather than a timer.
- **Not done.** `task/Thread.tsx` still loads older pages from an effect when a subagent's thread starts before the
  window (moving it into the action that opens the view is `thread/`'s); `ui-check` can't drive a
  `datetime-local`, so that was checked through the whole-app checks only (nor a `<select>` then: since HE-70 the
  app's selects are `ui/Select.tsx`, clicked as any button).
- **Checks.** `pnpm check`, `pnpm test` (236 files) and all 71 `tests/ui` files pass, as on `main`. New unit tests:
  `packages/client/test/queries.test.ts` (one atom per payload, a mutation reading its group again and not another's,
  a board trigger), `tests/unit/ui/{dates,reminders}.test.ts` (run in several time zones), `analyticsRange.test.ts`,
  `automationDraft.test.ts`; `tests/unit/state/fakeHost.test.ts` calls through `runExit` and `mutate`.

### As built in HE-78: HTML pages in the thread

An `html_render` call (docs/plan/07-agents.md, HTML pages in the thread) is an item of its own in the thread model,
`{ type: "html", call }` (`itemModel.ts`' `Rows.tool`, by `isHtmlRender`), not one of a tool group, so a folded turn
leaves it in sight. `thread/htmlPage.tsx` draws it: while it runs or if it failed, as its tool row (`ToolGroup`);
once its answer names the kept page (`htmlRenderAttachment`), the page, read with `attachmentTextAtom`
(`attachmentFiles.ts`, `attachments.get` decoded as UTF-8, kept while shown). The frame is a document's (`sandbox`
`allow-scripts allow-forms`, `srcdoc`): `FRAME_CSP` and `noWebRtc` before the page, the theme (`liveTheme`: the stock
theme with the board's `--color-*` as the tint leaves them) and the page, then `fitFrame` (planTheme.ts', now exported:
the frame takes the height the page reports, from the call's `height` until then, 40 to 20,000 px) and
`linksInNewTabs`, whose `iaOpen` opens a link at once after the user's own input in the frame and otherwise asks with
`OpenLinkBar` (in the full-screen view while that's open, where the click was), as a document's frame does, and
`escapeToBoard`, which passes Escape on (`iaKey`: a key pressed in the frame, another origin, never reaches the board).
Its buttons (shown on hover, always where there's no hover) download the page and open it full screen (a portal, wider,
zoom 50 to 200 %; Escape, on the board or in the page, closes it before the task view's own Escape; `data-modal`, so a
click in it isn't one outside the side panel, which would close the task). Browser check:
`apps/web/tests/ui/htmlPage.test.mjs`. The
tool rows call them "Previewed a page" and "Showed a page". The phone app shows the call as a tool call for now.

### Experiments (HE-22)

Settings → **Experiments** (`settings/Experiments.tsx`) lists the features still being tried, each with a switch and
its name, and what it does behind the ? beside that (HE-39). All are off at first.

- **One list.** `EXPERIMENTS` in `packages/contracts/src/experiments.ts` is every experiment (`id`, `name`,
  `description`), and `ExperimentId` its ids. Adding one is an entry there: the tab lists it, the host keeps its switch
  and settings sync carries it, with nothing else to change. What the experiment does reads
  `experiments.includes("<id>")`.
- **Per board, not per profile.** They are a host's settings (`HostSettings.experiments`, the ids switched on: optional
  and open strings on the wire, read through `knownExperiments`; see [05-protocol.md](05-protocol.md#rpc-groups)), so they
  hold in every browser and the desktop app, and the server can read them (`HostSettings.get`) for an experiment of
  its own. The web app reads the page's own host's: `experimentsAtom` in `packages/client` (`board.ts`), from the
  board's `hostSettings[localHostId]`, which `settings_changed` keeps. The tab sets them on that host with
  `host.updateSettings` (`experiments`: the whole list to have on), showing the list it saved until the host's
  settings have it. A per-profile switch would need a profile picked for pages that show several; nothing tried so
  far is about one profile.
- **Synced** like the other host-wide settings (docs/plan/08-hosts.md): each experiment is its own field
  (`global/experiment_<id>`), so two switched on two hosts apart don't conflict. A linked host that doesn't sync keeps
  its own, which the page doesn't read (it reads its own host's).
- **Fold finished turns** (`fold_turns`, `task/thread/turnFold.ts`, `FoldedTurnRow` in `items.tsx`, used by
  `ItemList`). A turn runs from a message to the agent (the user's, or the board's: an `auto` user item) to its
  `result` item; a message sent while it worked (`steered`) is part of it, and a compaction's result ends one without
  folding. A finished turn with tool calls folds its tool groups, its answered tool permission prompts and its result
  line into one row, where its first tool group was: "Worked for 2m 10s · 7 steps · $0.123", with an amber dot if a
  tool prompt came up and a red one if a call failed or a prompt was denied; "Interrupted" or "Ended: <subtype>" is
  added as the result line says. The time is the result's `duration_ms`, shown between 1 s and 12 h (as bot-hq does),
  else just "Worked". Its text, thinking, questions, plans and the board's own approvals stay as they are. Clicking it
  draws the turn as it is without the experiment (the result line too) under the row, and again folds it; which are
  open is `ItemList`'s state. A request to reveal a subagent whose call is in a folded turn opens the turn. A turn
  without a result yet, the running one, stays open.
- **Checks.** `tests/unit/turnFold.test.ts`; `tests/ui/foldTurns.test.mjs` (the switch on and off, a turn with a failed
  call and one that waited for approval); `apps/server/src/settings/HostSettings.test.ts` (the rows).
- **Show outgoing mail and events as drafts** (`draft_cards`, HE-23; from bot-hq's draft card, which never had a server
  side). `task/thread/drafts.ts` reads a prompt's tool and input (pure): workspace-mcp 2.3.0's `send_gmail_message` and
  `draft_gmail_message` (any `mcp__<server>__` prefix; `to`, `cc`, `bcc`, `subject`, `body`, `body_format`,
  `thread_id`, `forward_message_id`, `attachments`) are a mail, and `manage_event` with `action` `create` or `update`
  (and the older `create_event`/`modify_event`) an event; a Codex prompt's `{message, arguments}` is read for its
  arguments; anything else is null, and `PromptCard` (items.tsx) draws the usual `PermissionCard`. `draftCards.tsx`
  draws them: a mail's To/Cc/Bcc/Subject and body (plain text, or HTML in a `srcdoc` frame sandboxed without scripts
  and with `MAIL_CSP` first: inline styles and data: images only; it's `allow-same-origin` only so the page sizes it
  to its content), **Send**/**Discard** for Allow/Deny with _Always allow_ kept as `PermissionCard` has it; an
  event's title, `eventWhen` (its own wall clock and zone, not the viewer's), attendees, place and description, and
  for an update `changes` ("the time", "the place"…, the fields it sets). Edit (not on Codex: `agent` is `codex` when
  the request's metadata has `codex`) turns the mail's fields into inputs; `editedInput` is the tool's input with
  them, sent as `permissions.answer`'s `input` (07-agents.md, 3.3) and shown as "Edited" until then and "Sent as you
  edited it" after (`edited` in the request's metadata). Settled, a card folds to a line ("To kim@… · Invoice 4411")
  that opens. Events aren't edited: their fields are many and the time zones easy to get wrong.
- **Checks.** `tests/unit/drafts.test.ts` (the tools, Codex's shape, times, the edited input, the frame's policy);
  `tests/ui/draftCards.test.mjs` (off and on, a mail edited and sent and the fake agent's reply with the edited input,
  an event discarded, an HTML mail's frame running and loading nothing, Codex without Edit);
  `Permissions.test.ts` (the input Claude is told, the thread and the action log; refused for a question, a deny and
  Codex). The fake `claude`'s `fake-ask-mail`/`fake-ask-event` call the run's `google` MCP server (the stub) once
  allowed.
- **Assistant check-ins** (`check_ins`, HE-24; HE-17's write-up of bot-hq, idea 7). The assistant's Routines tab
  (`task/Routines.tsx`) shows **Add check-ins** beside New routine while the experiment is on and the profile has no
  routine called _Check-in_; it opens `CheckInSetup`: the times (`settings/automations/TimesInput.tsx`, which the
  routine editor uses too), the days, and a Google box shown only once `assistant.google` says it's connected. It
  calls `assistant.addCheckIn`, which the server refuses (`Invalid`) while the experiment is off, so the server's
  template is the experiment's too. The routine (`assistant/checkInText.ts`, `Brief.addCheckIn`) runs in a fresh
  thread, with a message that reads the boards through the board's tools and replies with one short message or
  `NO_REPLY`, and is told `{{last_run}}` and `{{quiet_runs}}` (the back-off: the more quiet check-ins in a row, the
  higher the bar).
  - **Not while you're talking to it.** Decided: the server gives a routine's precheck an environment variable,
    `HUNTAWAY_MINUTES_SINCE_USER_MESSAGE`, and the check-in's precheck exits 1 under 20. A `huntaway` CLI call from
    the precheck would need the board's token and address in the precheck's environment, and a check the server
    makes itself would be a new field on every automation (its column, its editor, its sync); the variable is one
    line of the server, the rule stays the user's to read and change in the precheck, and the run is recorded as
    skipped with why (_you messaged the assistant 5 min ago_) as any precheck's.
  - **Several times a day.** A daily trigger takes several times (`11:00, 16:30`), so the check-ins are one routine:
    a cron expression can't say 11:00 and 16:30, and one routine per time would be several to change. This isn't the
    experiment's alone: any routine's editor can add a time (+) and take one out (×).
  - **Checks.** `apps/server/src/assistant/CheckIn.test.ts` (the template, refused while off; on its schedule with the
    test clock, a run skipped because the user has just written, a quiet one, and one that reports);
    `Automations.test.ts` and `schedule.test.ts` (several times, `{{last_run}}`, `{{quiet_runs}}`);
    `tests/ui/checkIns.test.mjs` (nothing while off; Add check-ins; the editor's times).

### Interactive replies (HE-77)<a id="interactive-replies"></a>

What the agent is told and the tools are in [07-agents.md](07-agents.md#interactive-replies). In the web app:

- **Splitting a reply** (`segments` in `packages/a2ui/src/message.ts`, the package's light entry `@huntaway/a2ui`,
  which imports nothing): Markdown and `<a2ui>` blocks, a block being a line starting `<a2ui>` up to `</a2ui>` outside
  an Express string or comment. A tag in fenced or inline code stays Markdown, so an agent can show how one is
  written. A block whose Express leaves a string or comment open (`#`, `//`, `--`, `/* */`) still ends at a later line
  that is `</a2ui>` alone; one with no closing line is the rest of the text (`closed: false`). A row is a finished
  message (the reply being written is Thread.tsx's), so an unclosed block there is drawn as one that doesn't draw. `ItemList`'s `text` row hands a reply that has `<a2ui>` to `Reply` (`task/thread/a2ui/A2ui.tsx`), the
  rest to `Markdown` as before.
- **A chunk of its own**: `A2uiView.tsx`, loaded by an atom the first time a block is shown (as the Markdown renderer
  is, The bundle): the Express parser (`@a2ui/agent`, ANTLR) and the renderer (`@a2ui/react`, `@a2ui/web_core`) are
  about 220 KB gzipped, and most threads never need them. The first chunk only gets the splitter.
- **One renderer state per thread** (`ThreadSurfaces` in `packages/a2ui/src/thread.ts`, in `surfacesAtom` by host and
  task while a block of it is shown): the thread's closed blocks and the user's clicks, in order (`entriesOf` over the
  thread model's rows), parsed against the board's catalogs, lowered by the macro expander, and applied to one
  `MessageProcessor`, so a later reply's `update=true` changes the surface an earlier one drew. Each block shows the
  surfaces it was the last to draw; an earlier copy says "Interactive reply updated below", or "Interactive reply
  removed" once a later block deletes the surface (`deleteSurface`), and a block that only deletes shows nothing. A block that doesn't parse
  or draw shows why, with its source behind a click; nothing of it is drawn. When the start of the list changes (an
  older page loaded, a rewind) it is rebuilt from the start, keeping each surface's data (what the user typed or
  picked and hasn't sent) where the same block still draws it, and a click on its way: only an entry the thread
  hadn't applied before ends one. The rows are the loaded window of the thread, so a block
  that updates a surface drawn before it (`missing`) says so, with Load earlier messages (`more` and `loadEarlier` on
  the thread's context), rather than that it's wrong. A block in a subagent's rows isn't one of the main
  conversation's entries and shows as code. A surface is locked (`inert`, dimmed) while a click on it is on its way
  and once the thread has that click, until the agent draws it again (which also ends a click still marked as on
  its way). The whole surface: the rules (`BOARD_RULES`) tell agents so, and to give a surface one question or one
  submit button.
- **The board's look** (`task/thread/a2ui/catalog.tsx`): every component of A2UI's basic catalog v1.0 drawn with the
  board's controls (`Button`, `Input`, `Textarea`, `Modal`, lucide icons), under the catalog's own id and schemas
  (`basicCatalogOf`), so what the server checks is what draws. Media from an agent's URL isn't loaded, as in the
  thread's Markdown: an image, video or sound is a link to it, unless the block carries it (a `data:` URL). A `Modal`'s
  trigger only opens it (a trigger Button's own action isn't sent), and the dialog is portalled to the page's body,
  outside the surface's `inert` lock, closing when the surface locks (`SurfaceLocked`, a context A2uiView provides).
- **A click** sends `tasks.send` with `actionMessage` (`runExit(mutate(…))`); the user's row (`UserMessage`,
  `ActionText`) shows each click in it (`clicksOf`), what it sent when opened, and the message's other text.
- **The phone** (`apps/mobile`) shows a block as a note ("open the task on the board in a browser to use it") and a
  click as its line.

### The page's own selects (HE-70)

The browser's `<select>` drew its list in the system's colours and font (a white list on the dark board), so every
select in the web app is `Select` (`components/ui/Select.tsx`): a button that shows the picked option and opens a
list drawn by the page, in the menus' style (`ContextMenu`), with a tick by the picked one.

- **Used as a `<select>` was.** Its children are the same `<option value>`s (in arrays, as a `.map` makes them;
  `disabled` ones shown but not picked), and it takes `value`, `className`, `title`, `aria-label` and `disabled`.
  `onChange` gets the picked value, a string as `e.target.value` was, and only when it changes. As a native select:
  its width is its widest option's unless its class sets one (every option's text sits unseen in one grid cell, in
  `::before`, so it isn't text on the page), a value no option has shows the first, and typing an option's first
  letters picks it, with the list closed or open.
- **Placed in the window** (`position: fixed`, as `Help` is) under the button, or above it when there's more room
  there, as wide as the button at least and at most 360 px tall, and moved with it when anything scrolls; inline,
  not in a portal, so a dialog's focus trap and a popover's press-outside see it as theirs. The button is
  its parent's child as the select was (the list comes before it, so a parent's `space-y` margin still reaches the
  button), and its baseline is the picked option's text, as a native select's is.
  Its button's base class is `inline-flex`, which a `hidden` in the caller's class doesn't reliably beat: a select
  shown only in one layout is wrapped in an element that hides it (the Guide's page picker).
- **The highlight is kept by the option's value**, not its place: a board update that adds, removes or reorders
  options while the list is open leaves it on the same option, so Enter picks what was arrowed to (or, the option gone,
  the picked one). `tests/ui/select.test.mjs` adds a task above the highlighted one in a task's Depends on list.
- **The highlighted option is scrolled into view** as the list opens and as the highlight moves, not on every redraw:
  a board update while the list is open doesn't undo the wheel's scrolling of it.
- **The keyboard's focus stays on the button** (a `combobox` with `aria-activedescendant`): the arrows, Home and End
  move, Enter or Space picks, Tab and a press elsewhere close it (it closes on the button's blur; a press in the list
  is kept from taking the focus). Escape is taken in the window's capture phase, so it closes the list and not the
  dialog, task panel or popover it's in.
- **The page's shortcuts** left keys pressed in a `select` alone: those checks (`forPage`, the lasso, Compare, the
  git keys, the thread's and task view's keys, a workflow's Delete, a prompt card's digits) now look for
  `[role=combobox]`.
- **Not changed:** the `<select>` a plan's `ia-question type="select"` makes inside the plan's sandboxed frame
  (`planTheme.ts`): it is the document's own form, styled by the plan's theme.
- **Checks.** The `tests/ui` checks that picked in a select (`automations`, `assistant`, `confirmErrors`,
  `globalAgentToolsHost`, `mergesInto`, `push`, `permissions`, `skillSources`, `plan`, `reviewerOptions`,
  `systemPromptPreview`, `workflowPresets`) do it through the harness's `pick(combobox, value | { label } | { index })`,
  which clicks the button and then the option, and read it with `pickedValue` (the button's `data-value`).

### As built in HE-89: dictation

The microphone beside the thread's composer and in the New task form (`components/task/Dictation.tsx`), as T3 Code's
composer has it: a click starts recording, a pill shows the time, the level, ✕ and ✓; Ctrl+Shift+D (⌘⇧D) in the field
starts and finishes, or held past 300 ms records until it is let go; Escape cancels (and doesn't reach the dialog). The
recording (`speech/recorder.ts`) is the browser's `MediaRecorder` on the microphone, decoded and resampled to 16 kHz
mono with an `OfflineAudioContext` when it stops, and sent whole to this page's own server (`speech.transcribe` on the
local host, whatever host the task is on); what comes back goes in at the field's selection, spaced from the words
either side (`insertDictation`). T3 Code streams PCM from an AudioWorklet for a live preview, which this leaves for
later. A recording under 0.3 s isn't sent; one reaching five minutes finishes itself. The button is hidden where the
server can't transcribe, greyed out where the page can't use a microphone (not https or localhost), and with no model
installed it opens Settings → Voice input (`settings/Voice.tsx`: the models, Download with its progress, Cancel, Use,
Remove). The desktop app's macOS build gives the reason macOS asks for (`NSMicrophoneUsageDescription`).

### As built in HE-101: `/rewind`

The composer's `/rewind`, as Claude Code has it, to reword a prompt that left something out. It is the composer's own
command (`task/rewindCommand.ts`), never sent: the `/` menu lists it for a task with a worktree of its own (the only
threads with checkpoints), and picking it, or sending `/rewind` on its own, empties the field and opens `RewindCommand`
(`task/Rewind.tsx`). That lists the user's messages a rewind can go back to before, newest first (each message's first
turn from `checkpoints.turns`, without those already rewound past; Up and Down move between them, and one that can't be
rewound to says why), and picking one opens the thread mark's `RewindDialog`, whose Cancel goes back to the list. With
the conversation taken back (ticked by default), the message goes into the composer (`rewound`, moved here from
`Composer.tsx`) to change and send again; the next run resumes the session from before it. Elsewhere (the assistant, a
task in its project's repository) `/rewind` says there are no checkpoints rather than reaching the agent. The phone app
has no `/` menu and is unchanged. Checks: `tests/unit/rewindCommand.test.ts`, `tests/ui/rewindCommand.test.mjs` (the
fake claude: two turns, the list, Cancel, the rewind, and the reworded message's run resuming at the rewind).

### Logic that must not be lost on the way

These live in components or module-level state today, outside the store, and are easy to drop when "the store and
the client" are replaced (inventory 10, section 14):

- A send outlives its composer; only what was sent is removed from the draft, and text typed meanwhile stays.
- Moving a fresh task to In progress sends the empty message that starts its agent.
- Own moves do not notify (noted before the request, for 15 seconds, across tabs). One tab notifies. No tab notifies
  about the task its user is looking at. A preview board never shows system notifications.
- Notifications fire for live changes only, never for what a snapshot or reconnect brings.
- The composer warns when the browser could not save a draft.
- Agent-written HTML is always in a sandboxed frame; the page's CSP is `frame-src 'self'`; remote images are not
  shown.
- A terminal is created after its font has loaded and one frame later; it is reset before re-attaching.
- An open tab detects a new build and offers a reload. There is no service-worker cache.

### The bundle (HE-71)

A board opened over a network (a linked host's, a phone's) waits mostly on bytes, not on the server: before HE-71 the
first load was 1.99 MB uncompressed and took about 1.0 s to the first card at 20 Mbit/s and 40 ms, 3.6 s at 5 Mbit/s
and 100 ms (on localhost, under 0.1 s either way). Three changes:

- **Precompressed.** `apps/web/vite.config.ts`'s `precompress` plugin writes `<file>.br` (brotli 11) and `<file>.gz`
  (gzip 9) beside each text file of the build over 1 KiB (js, css, html, svg, json, webmanifest, ttf…), when that saves
  a tenth or more. The server's `StaticUi` (`apps/server/src/http/routes.ts`) sends `.br`, else `.gz`, to a browser
  whose `Accept-Encoding` takes it (q-values and `*` read), with the file's own type, `Content-Encoding` and
  `Vary: Accept-Encoding`; the variant is served by the same `HttpStaticServer` under its own name, so its ETag (size
  and time), 304s and ranges are its own. No variant on disk (a file too small, a UI folder from before), the file as
  it is. Nothing is compressed per request. `scripts/package-server.sh` copies `dist` whole, so a release's `ui/` and
  the desktop app carry the variants. The build takes about 5 s longer for it.
- **Split.** Every page but the boards is a chunk loaded the first time it is opened (`App.tsx`: Settings, a project's
  settings, Analytics, the Guide, a host's page, onboarding, the assistant, a plugin's page), with `React.lazy`; a page
  shows `PageLoading` (a word after a moment, as `BoardLoading`) while its chunk comes. The task's views (`TaskView`,
  `TaskPanel`, `TaskModal`) and the Markdown renderer (react-markdown, GFM: `thread/MarkdownView.tsx` behind
  `thread/Markdown.tsx`) are chunks too, but fetched as the app starts, beside the board's snapshot, through atoms
  (`taskViewsAtom` in `App.tsx`, `markdownViewAtom`) rather than `React.lazy`: once loaded they draw in the same render,
  where a lazy component suspends on its first render and shows its fallback for a moment (which made opening a task
  flash, and broke the checks that open one). Until then a task shows nothing and a text takes its room unseen. The
  Guide's links other pages use are in `settings/GuideLink.tsx`, so the Guide (with its own Markdown) leaves the entry.
  The entry went from 1,443 KB to 742 KB (the first load from 1,892 KiB in 8 files to 1,270 KiB in 24, 455 to 330 KiB
  as brotli). What is left in it: the board, the layout, the New task dialog, `mdast-util-from-markdown` (the
  composer's tokens, `layout/taskTokens.ts`) and react-dom.
- **A chunk that doesn't load.** A tab opened before an update asks for chunks the new build doesn't have (404), and a
  network blip fails one. The pages and the compare view are inside `ChunkBoundary` (`layout/ChunkError.tsx`), an error
  boundary that shows `ChunkError` (it couldn't load, with Reload) in the page's place, rather than React unmounting the
  whole app; another page tries again. Task views that failed show `ChunkError` on a task's page and floating over the
  board for the panel or the dialog; a Markdown renderer that failed leaves texts as they are, shown (`whitespace-pre-wrap`).
- **The RPC socket is compressed.** Both listeners (`Main.ts`, `ReadOnlyMain.ts`) turn on `ws`'s permessage-deflate
  (`http/websocket.ts`) for messages of 1 KiB or more: the first `board.watch` message is about 1.8 KB a task as JSON
  and deflates about 7 times smaller. It applies to the websockets the server accepts (the terminal, the task's
  browser), except the relay's piped ones (`hosts/pipe.ts`): `ws` queues a frame for zlib before it reaches the
  connection, out of sight of the pipe's wait for a drain, so a fast sender would be read into memory. `accept` takes
  the extension out of the upgrade request and `dial` doesn't offer it; `pipe.test.ts` runs its hub with these options.
  A message is at most 16 MiB inflated (`maxPayload`, the limit the server's RPC reads a request with,
  `RpcNdjsonServer`; 1009 past it; clients take answers up to 512 MiB, `RpcNdjson`): `/api/rpc` upgrades before any
  token, and `ws`'s default of 100 MiB let a few kilobytes deflated make the server allocate that much
  (`http/websocket.test.ts`). The desktop pane's DevTools answers can be bigger (a long diff's accessibility tree is
  tens of MiB), so the pane sends a message over 1 MiB as `{"parts":n}` and `n` binary parts of 1 MiB, up to 100
  (`paneParts` in `@huntaway/shared`), and the server joins them (`paneText`); `Browsers.test.ts` has a 20 MiB tree
  go through the listener.

After: 0.41 s to the first card at 20 Mbit/s and 40 ms, 1.0 s at 5 Mbit/s and 100 ms (Chromium's network emulation,
the demo board, an empty cache). Not done: `board.watch` still waits for `public.health`'s answer (one round trip on
the open socket) to learn the page's own host id, which keys every host's atoms (`hostRuntime`, `hostBoardAtom`,
`boardHostIdsAtom`); the board stream's `hello` carries it only once the watch has started, so starting it sooner
would mean putting the id in `index.html` (served as a static, precompressed file) or guessing it from the last visit
and re-keying when wrong.

## The desktop shell: `apps/desktop`

The Electron shell (six CommonJS files, 1,687 lines) becomes TypeScript, with its main process an Effect program
(`NodeRuntime.runMain`): find or start a server through the launcher and read its `HUNTAWAY_READY` line, watch its
health, open windows, update itself. What it does, and the rules that make it safe, are unchanged (inventory 10,
section 9): only `ECONNREFUSED` means "no server"; a failed start is blamed on the new build only after another
server came up; AppImage and pacman installs are done by the shell; `app/state.json` is shared with the server's
`Releases` service and keeps its format; the preload exposes the same six members on `window.huntawayDesktop` (and
`onServerProgress`, HE-44), to the main frame only, with origin checks.

As built (8.3):

```
apps/desktop/
  src/boot/      boot.ts (the frame, the package's `main`), shells.ts (which release's shell to load, shell-state.json, the crash marker)
  src/shared/    versions.ts (every decision as a plain function: chooseServer, chooseShell, markBad, shellChange, installKind,
                 updateKind, packageName, releaseEnv), paths.ts (the data folder, the shell's folder, the default port)
  src/main/      main.ts (the entry: NodeRuntime.runMain), Desktop (what it knows: desktop.json, environment, Electron),
                 Servers (find, attach or start; the blame rule; restarts; stop on quit), ServerProcess (the launcher's
                 process, its ready line and output), fallback.ts (startWithFallback), health.ts, appState.ts, install.ts,
                 stamp.ts, shellUpdate.ts (the AppImage and pacman update), Windows.ts (windows, navigation, browser
                 pane, IPC, menu, relaunch), urls.ts, errorPage.ts, progressPage.ts and progress.ts (HE-44)
  src/preload/   preload.ts (its own tsconfig, with the DOM)
  scripts/       dist.ts (electron-builder), stamp.ts (the release manifest's `shell` and `electron/shell.json`)
```

- **The frame stays a separate file.** `vp pack` makes three CommonJS bundles with their dependencies inside
  (`dist/boot.cjs`, `dist/main.cjs`, `dist/preload.cjs`; one build each, so no chunk is shared), and the packaged app
  carries no `node_modules`. boot.cjs is plain TypeScript with no effect import, so that its stamp (sha256 over
  `boot.cjs`, its contents and the Electron version, as before) changes only when the frame does. It still loads
  `main.cjs` from a release's `electron/` (with `shell.json {electron, boot: 1}`) and gives it the same
  `globalThis.huntawayBoot`. A release's tarball carries `dist/main.cjs`, `dist/preload.cjs` and the `shell.json` that
  `pnpm --filter huntaway-desktop run stamp --shell-json` prints; `stamp` without it prints the manifest's
  `{shell, electron}`.
- **Its own names, beside the old app.** desktop.json and the windows' storage (Electron's userData) are in
  `<appData>/huntaway-effect/` (`HUNTAWAY_DESKTOP_DIR` overrides it), not the old app's `huntaway/` and `Huntaway/`: the
  old desktop.json points at the old board, and the single-instance lock is per userData folder, so the two apps would
  otherwise open each other's windows. The default port is 7879 and the data folder the new server's. The variables are
  `HUNTAWAY_*`: `HUNTAWAY_PORT`, `HUNTAWAY_DATA_DIR`, `HUNTAWAY_SERVER_BIN`, `HUNTAWAY_DEV_URL`,
  `HUNTAWAY_PACKAGED_RESOURCES`, `HUNTAWAY_RELEASE_UPDATES`, `HUNTAWAY_RELEASE_API`, `HUNTAWAY_LAUNCHER`, and to the
  server `HUNTAWAY_DESKTOP_VERSION`, `HUNTAWAY_DESKTOP_SHELL`, `HUNTAWAY_DESKTOP_INSTALL`, `HUNTAWAY_BUNDLED_SERVER`,
  `HUNTAWAY_SKIP_DB_BACKUP[_ONCE]`. Dropped with the former name (14, "The `issue-agent` command…"): the `issue-agent`
  and "Issue Agent" folder fallbacks; and with the Rust port's leftovers (14, "the backup rules for Rust releases"): the
  `server/target` fallback and `server_version` for Rust releases.
- **The server it starts** is the launcher (a release's `huntaway`, the bundled one, or the checkout's
  `apps/server/bin/huntaway` once `apps/server/node_modules` is installed), run as a child that is not in a process
  group of its own, so that stopping it is SIGTERM to the launcher alone (SIGKILL after 10 seconds). Its PATH is the
  login shell's for a packaged app; the old shell changed its own `process.env.PATH` instead.
- **The order of a start** (HE-71): the single-instance lock first (main.ts's `early`), then the layers, then
  `Servers.prestart` begins finding or starting the server before `app.whenReady()` (it needs nothing of Electron's;
  the first window's `resolve` takes that result, and a window counts as open until the first one is, so a server lost
  meanwhile is still started again). How a release build was installed (`pacman -Qqo`) is one cached effect in
  `Servers`, begun as its layer is built, for the started server's environment and for the windows' package update
  (the preload's synchronous `shellUpdateKind` reply waits for it if it must). Once no server answers on the port, the
  login shell's PATH and the release variables (frame stamp, install kind) are begun and then awaited together just
  before the spawn; a server already up costs no login shell. The window is created without waiting for any of it:
  the shell stamp `checkShell` compares against is hashed beside it.
- **What the shell reads of the server**: `HUNTAWAY_READY {"port","token"}`, `HUNTAWAY_PROGRESS {step, done, total,
  file}` as it starts (06-server.md, Startup, step 2), and `HUNTAWAY_BACKUP_FAILED {reason, why, dir}` for the error
  page's "Start without a backup". The server does not print the last yet (its `Backup` fails the start with a
  `StartupError`); until it does, a failed backup shows as a server that exited.
- **The progress page** (HE-44): a window with no board to show yet shows it rather than a black window: at once when
  this app is starting the server (`Servers.starting`, HE-71), else while `Servers.resolve` takes more than 300 ms
  (another launch's server being waited for; one already up loads the board with no flash of it), and in every window
  as the app quits to relaunch (a new shell after an Update, or its own package update, after which the next instance
  says "Starting Huntaway 0.0.5": `relaunch-windows.json` is `{windows, heading}` now, and a plain list is still read).
  Like the error page it is a `data:` URL in the board's theme: the app's heading, the step (`Servers.startup`: looking
  for the server, starting it, then the server's own steps, "Backing up the database: 0.6 GB of 1.6 GB" with the size
  of the backup's file read every 250 ms, "Updating the database: 2 of 3", "Starting the board", "Opening the board",
  or "Stopping the server" on quitting), a bar (filled to the step's share where it's known, a moving stripe
  otherwise), that it can take a minute and not to reload or close the window, and the server's last 40 lines (stderr,
  and stdout but for the lines for the app, as the ready line has the token) folded away. The main process loads it
  once and then calls `huntawayProgress(state)` in it (`executeJavaScript`, which sets text only), also after a reload
  of it. A page of the app's own doesn't run the shell check: reloading the progress page while a new version starts
  doesn't relaunch the app (HE-43's Ctrl+R).
- **The ready wait counts silence, not the whole start**: a start fails as slow (not blamed, as before) after 15 s with
  no `HUNTAWAY_PROGRESS` line and no growth of the backup's file, so a long backup or migration that goes on reporting
  doesn't put up the error page.
- **The board hears the steps** of the server it started as it starts again in place (a Restart or an Update execs
  under the same launcher): the main process sends each new step to the board's windows, and the preload has a seventh
  member, `onServerProgress(listener)`, which returns the function that stops it. The restart dialog shows them.
- **The package update** asks the board for the release status with `admin.status` over `POST /api/rpc` (a one-method
  group with the contracts' `Auth`), where the old shell called `GET /api/admin/server`. It reads only
  `release.latest.version` and `release.shell.outdated`. It hashes the download after writing it (Effect's `Digest`
  has no streaming hash), still before the rename.
- **Tests**: the old `desktop-versions`, `desktop-boot` and `desktop-shell-update` cases, and `Servers.test.ts`, which
  runs stand-in launchers (shell scripts) on a free port: the ready line, an installed version that exits and is
  blamed once the next is up, a failed backup, attaching to a server already there, remote mode, windows sharing
  one start, a start begun before any window (`prestart`, HE-71), and a packaged app's login-shell PATH.

## The phone app

`apps/mobile` (HE-20): an Expo SDK 58 app (React Native 0.88, expo-router) on `packages/client` and effect 4, which
bundles for Hermes as it is (the client's atoms, sessions and thread are the web app's own; Expo installs `URL` and
`structuredClone`, and Babel turns effect's `import.meta` into what Hermes parses). Hermes has no ES2023 copying array
methods, which the lint asks for (`toSorted`, `toReversed`): the entry, `src/index.ts`, loads `src/polyfills.ts` before
Expo Router (HE-98; without it the network search died before asking anyone). The old app's screens are kept in
shape and its state modules are gone: `serverUrlAtom` and `tokenAtom` are set from the board kept in the keychain
(`expo-secure-store`, `localStorage` on its web build), and everything else is atoms.

- **Connect** (HE-91): the boards on the phone's network first. The app asks every other address of its own /24 (from
  `expo-network`; only on a private LAN, nearest first, 32 at a time, 1.5 s each) for `/api/health` on port 7879 (a
  field changes it) and lists those that answer as a board, by the name their health gives (`state/discovery.ts`,
  `logic/discovery.ts`). Plain HTTP, so it needs no native module and runs in Expo Go: mDNS (the boards' responder)
  would need one. The web build asks only `127.0.0.1` (expo-network's web address lookup asks a service on the
  internet), an Android build `10.0.2.2` too (an emulator's computer). Tapping a board asks for the PIN its Settings →
  Network access shows (pairing, [08-hosts.md](08-hosts.md#paired-devices)); the phone keeps the device token it
  gets. Below, an address typed in (Tailscale, another port) with a PIN, or the board's link with its token, or none
  on a board started with `--open-token`. The board must answer `public.health` within 10 s before it is kept. Forget
  this board unpairs the phone first (`hub.devices.unpair`; a board token's `Invalid` is ignored). iOS asks for the
  local network (`NSLocalNetworkUsageDescription`). Plain HTTP to another machine is allowed with a warning (boards are reached over
  Tailscale and the like), so a release build allows cleartext (`expo-build-properties`, `NSAllowsArbitraryLoads`).
- **Inbox**: every usable host's `permissions.pending` (read every 5 s while it shows: a prompt is no board event),
  Allow or Deny in place, a question or plan opening its task; and the tasks in Needs attention with no prompt.
- **Assistant**: the shown profile's, found with `assistantHome` and opened with `assistant.get` (`here`).
- **Projects** and **a project**: the shown profile's projects on every host; a project's tasks by status, what needs
  the user first, Done the latest 20; New task (`tasks.create` with `start`).
- **A task**: Stop (`tasks.stop`), Start (an empty `tasks.send`), Move (`optimisticMove`), its thread (`threadAtom`,
  `threadPreviewAtom`, `olderPage`) as rows (`src/logic/thread.ts`, a smaller cut of the web's `itemModel.ts`), its
  requests' cards (`permissions.answer`; a board question's `threads.answerQuestion`), and the composer
  (`sendMessage`).
- **Board**: the board's sessions, its hosts, the profile shown (merged by name, kept), connecting another, forgetting.

Checked: its pure logic in `pnpm test` (`apps/mobile/tests`); the type check and lint in `pnpm check`; the screens on
its web build (`pnpm --filter huntaway-mobile export:web`, served on a free port, driven by `scripts/ui-check.mjs`)
against a test server with the fake agent; `expo export --platform android` (Hermes bytecode); a release build on an
Android phone (HE-98).

What is left, a task each:

1. **Run on a phone, and an APK in releases**: a development build or Expo Go on Android and iOS; the release
   workflow's Android job (signing key, `versionCode` from the version, as the old one did).
2. ~~**Device pairing**~~: done in HE-91, by a PIN rather than a QR code (the app finds the board on its network,
   so only the PIN is left to type).
3. **Several boards**: one atom registry per board (the client's atoms are per registry), an Inbox across them.
4. **Expo push** and **answering from the lock screen**: the server's `expo` subscriptions are kept and not pushed to
   (6.8); with them, `push_answer_tokens` and the notification's Allow and Deny.
5. **Sharing into the app, attachments, dictation**: the old app's share intent, photos and files
   (`attachments.upload`), voice notes. The web's dictation (HE-89, below) has the server transcribe
   (`speech.transcribe`), which the phone can send its recording to as well, rather than the platform's recogniser.
6. **One thread model**: the web's `itemModel.ts` and the phone's `thread.ts` moved into `packages/client`, so the two
   apps draw a thread from the same rows.

## Tests

- **Unit** (`apps/web/tests/unit`, `packages/client`): reducers, the pure helpers (their tests are carried over),
  atoms with a test registry and an in-memory `HostClient`.
- **Component checks** (`apps/web/tests/browser`, Vitest browser mode): the fake keeps its builders (`board()`,
  `b.task(…)`, ids that never repeat) and its promise: a call the test did not expect fails the check. Under it, the
  `fetch` replacement becomes an in-memory RPC handler set.

  ```ts
  const b = board()
  const task = b.task({ status: "in_progress" })
  const server = fakeHost(b).thread(task.id, threadFeed(task.id, [])).allow(/^board\.|^threads\./)
  mount(b, <Composer id={task.id} />)
  await userEvent.type(screen.getByRole("textbox"), "hello{Control>}{Enter}")
  await expect.poll(() => server.sent("tasks.send")).toEqual([{ id: task.id, text: "hello" }])
  server.emit({ type: "task", task: { ...task, running: true } })
  ```

  `fakeHost(b)` gives `on(method, handler)`, `sent(method)`, `emit(event)`, `update(id, change)`, `thread(…)`,
  `delay(ms)` and default handlers for the board stream and task basics. `mount` provides a registry seeded from the
  board and resets every atom afterwards, which the old fake could not do for the other stores and module caches.
- **Whole-app checks** (`apps/web/tests/ui`, 93 files): they drive the built UI against a real test server with a
  fake agent, by visible text and roles, so they carry over with a new harness under them (`startServer`, an RPC
  call helper in place of `api()`). They are the port's parity suite for the UI: [10-testing.md](10-testing.md).
  Checks that injected events by intercepting `/api/ws` use a test server's `debug.emit` method instead.

### Step 1 as done for automations (6.5, HE-7)

- `components/settings/Automations.tsx` (`ProjectAutomations`) and `settings/automations/*` (the editor, row, run history,
  test delivery, webhook and guard fields, `draft.ts`, `text.ts`), reading `automationsAtom` and `automationRunsAtom`
  (`packages/client/src/board/automations.ts`, read again on the host board's `automations` map, which the
  `automations_changed` event bumps by owner and by automation), writing through `useRpc()`. The old host-version gates
  are gone. `TemplateField.tsx` is the workflows' (6.6).
- Where it mounts is 6.12's: project settings' `automations` tab renders `<ProjectAutomations project={project} />`.
  `tests/ui/automations.test.mjs` (the old three cases) passes with it mounted there, and is skipped (`MOUNTED`) until it is.
  `task/Routines.tsx` is 6.7's: the editor and row take the owner (no project: a routine) as props.

### Step 1 as done for the assistant (6.7, HE-7)

- **What came over.** `task/AssistantPage.tsx` (`assistant.get`, then the task view of the task its event puts on the
  board), `task/Memory.tsx`, `Brief.tsx`, `Routines.tsx`, `ActionLog.tsx`, `ApprovalRules.tsx` (the Rules section of the
  assistant's details), `GoogleCard.tsx`, `settings/Assistants.tsx` (Google per profile; Telegram dropped, 14), the
  sidebar's `layout/sidebar/AssistantEntry.tsx` (the old `ProfileEntries.tsx`'s other half), the `a` shortcut, the
  Brief, Memory, Routines and Actions tabs (Memory, Brief and Routines as `preloadable` chunks), and tracked work's
  "Remove from the list" and "Clear done" (`tasks.removeTracked`). The old `src/assistant.ts` hooks are
  `task/assistant.ts`. Calls are `rpc(host, "assistant.…" | "approvalRules.…" | "automations.…")`; the brief is
  `tasks.document` with label `brief` (its `items` beside it); routines are 6.5's `automationsAtom` for the profile.
- **Client.** `HostBoard.approvalRules` keeps the latest `approval_rules`/`approval_log` event per profile and
  `approvalSeqAtom(host, "rules" | "log", profile)` reads it, which the rules and the action log read again on (as
  `docsSeqAtom`); `ruleFor` and `RULE_DECISIONS` (over `@huntaway/shared`'s `decide`) are in `logic/assistant.ts`.
- **A routine's thread**, which the board's snapshot leaves out, is asked for with `tasks.get` from the connected hosts
  when its page or dialog opens and it isn't on the board (`task/view/useSoughtTask.ts`), until an event puts it there.
- **What the lint asked for.** Reads that follow an event or a time (the log, the rules, the brief, a file's history)
  go through `changes/git/useLoaded` with the trigger in the key; a memory file is read again through its `fetchFile`,
  which changes with the file's modified time; the Ctrl+S handler's ref is written in a layout effect; the rules
  dialog's rows have ids of their own, and a diff's lines are keyed by their text and its occurrence.
- **A profile's assistant on another host (7.4, HE-8).** `assistantHome`'s offline and no-profile notes, the settings
  card's uplink note, `assistant.get` with `here: true` on the host it found, and the Routines tab's "left behind"
  routines (`task/RoutinesLeftBehind.tsx`, the old `LeftBehind`, one line in `Routines.tsx`) are back.
- **Which host's assistant, on its page (HE-103).** `task/AssistantHostPicker.tsx` is a dropdown of where the
  assistant runs (the profile form's `AssistantHostSelect`: this host or a linked one, an offline one marked), in the
  assistant's header and on the page shown while it can't be opened. Picking one saves the board's host's profile's
  `assistant_host` at once (`profiles.update`), and the page follows it there. It's shown when the profile form shows
  the field: a linked host is connected, or one is picked. `assistantHost.test.mjs` moves it there and back.
- **Checks.** `tests/ui/assistant.test.mjs` (every old case; the held save is `assistant.writeMemoryFile` held with
  `routeRpc`, and "Ctrl+S on today's empty log saves nothing" counts the page's calls), `brief.test.mjs` (every old
  case; the brief and the ratings answered with `routeRpc`) and `routines.test.mjs` (both old cases, on
  `--fake-claude`: a run makes its thread only where agents run, so the report is the fake agent's, not a failure).
  `assistantHost.test.mjs` came with 7.4 (HE-8). Not ported: `reminders.test.mjs` (a task's reminders, not the assistant's).

### The task view's key items and Details tab (HE-31)

A change from the old client, asked for on this board: the column beside a task's thread held everything about the
task, most of it rarely used (the status list, the title, the description, labels, links to edit, the worktree).

- **Key items** (`task/view/details/KeyItems.tsx`) are what that column shows now, beside every tab that leaves it room
  (not a document, the changes, the terminals, the desktop, the memory or the brief): the status with when it last
  moved and what it has cost, and what it waits for (`StatusNotes`, out of `StatusSection.tsx`); the agent's todo list
  in full (`TodosSection.tsx`: the card has only its start); the assistant's tracked work; the pull request with its
  checks and _Fix broken checks_; the preview; the workflows; the plugins' panels (HE-34); the tasks from the same prompt and the ones it created;
  what it depends on, merges into, is merged into by and is stacked with; its branch, and a worktree that failed. Each
  only when there is one, so a task with none of them has just its status. A pens thread has no column.
- **Details** is a tab of every task, last, at any width (`"details"`, as the narrow layout already had). It has the
  title and the description, to read and to edit, and everything set by hand: the status list, Asana, labels,
  dependencies, the preview and pull request links, what it merges into, the worktree, the agent and _Delete task_.
  Where there's room the title and the description have the tab's main area (`DetailsTab`), with the composer under
  them as under every tab, and the rest takes the key items' place beside it (`DetailsSide`); narrower, it's one list
  with the status first, which also has the key items the view has no column for. The title and description are the
  same elements either way, so expanding a side panel keeps an edit.
- `openingTab` is as it was, and now holds at any width: a task not started yet (to do or backlog) opens on Details,
  where its description is, and the rest on the thread.
- `taskFacts.ts` has what kind of task it is (a group's, a scratch one, one that lasts, one with code) for both.
  `StatusSection` asks before a move to Done itself (`useConfirmDone`), no longer through `Details`.
- Checks: `tests/ui/taskDetails.test.mjs` (the key items beside the thread, the Details tab's two columns, and an edit
  kept as the panel expands); the checks that reach a section through the Details tab are as they were.
