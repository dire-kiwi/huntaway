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
               Sessions.ts      which hosts there are (from the hub) and a runtime for each
               relay.ts         a relayed session: ticket, then the socket through the hub
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
had, marked stale, which is the old "a failed request must not empty a host's board".

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
  Nothing else is optimistic.
- **Reads across hosts** (analytics, token statistics, disk usage, docs, pens): one query per host, combined by a
  derived atom, in place of the hand-written fan-outs.

## The web app's own state: `apps/web/src/state/`

| File               | Holds                                                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `board.ts`         | `useBoard(selector)` and `board.get()`: the read surface over `boardAtom`                                                        |
| `rpc.ts`           | `useRpc()`: call any method on a host and get a promise, for event handlers                                                      |
| `route.ts`         | The route as an atom over the History API, with the old router's `parse` and `href`. The 14 routes and their query parameters stay |
| `drafts.ts`        | Composer, new-task, line-comment and plan-answer drafts as `Atom.kvs` atoms over the browser's storage, under their old keys     |
| `prefs.ts`         | The other persisted keys (view toggles, collapsed groups, theme, active profile…), the same way, each with a schema              |
| `selection.ts`, `terminalTools.ts`, `subagents.ts`, `narrow.ts`, `shortcuts.ts`, `clock.ts` | The small stores and `useSyncExternalStore` sources, as atoms             |
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
  summary and the review's dot (M4); workflows' tabs and list (6.6); the terminal and its tools, the browser pane and
  the desktop view (M6); documents and plan tabs, document links (M6: links are plain external links); the assistant's
  memory, brief, routines and action log, and finding a routine's thread on other hosts (M6); Asana links (6.11);
  approval rules in Details (3.6, 6.12); worktree set-up and tear-down (4.1); "Stacked on" and "Landing after" in
  Details (4.8); fix-checks buttons (4.5, 4.6); the context breakdown's lists and "carry on" (2.8); Codex config models
  (M5); a review thread's own view (M4). The Agents pill (`layout/AgentsPill`) is still HE-3's cut. Subprojects are a
  legacy branch, deleted.
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

### Step 1 as done for `changes/` (4.2, HE-5)

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
  narrow; it expands a side panel), the details column giving way. The browser's splitter isn't on this server, so the
  share is fixed. The old capability check (`hostHas(host, DESKTOP)`) is gone.
- Checks: `tests/ui/desktop.test.mjs` (`--fake-claude --fake-desktop`: a run's desktop calls over its own server, then
  the pane shows the window and what it did; no button with computer use off) and `tests/ui/driver.test.mjs` (the old
  checks of `scripts/ui-check.mjs`; its sandboxed frame is a page of the check's own until documents come, 6.2).

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
  ended. `task/Terminal.tsx` is the old pane: the socket is `/api/terminal/<ticket>` on the page's own server, with a
  ticket from `terminal.open` asked for each connection (a ticket that can't be had is retried as a dropped socket is).
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
  host picker and making the profile on another host are M7's: the project goes on the page's own host, in one of its
  profiles.
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
  (`tasks.skills`, kept a minute per task and config as before; `/compact`, `/plan` for a task, `/new`). Calls are
  `rpc(host, "agentTools.…")`, read again after a change, as the old ones were. The project settings' Agents tab had no
  agent-tools part.
- **Changed.** Every host has sources, subfolders, `/plan` and `/new`, so the API checks are gone; the host picker waits
  for M7 (the page's own host); the menu's state is adjusted during render and its list keyed by task and config
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
  6.11: gh's accounts in `GithubAccountSelect` (`profiles.githubAccounts`, a stub that lists none), `CopyLoginModal`,
  config archives, and connecting Asana (`AsanaAccount`). The host page's Settings sync, version, Server and Remove for a
  linked host, and the service (`admin.*`, `hub.hosts.*`: M7 and M8, board task HE-6), Terminal tools (6.1), Telemetry
  (6.9) and Desktop (6.10) are `Slot`s; Settings → Server shows what `host.info` says, and its restart, update, release,
  shell and service parts and the sidebar's `UpdateButton` are HE-6's.
- **Dropped.** Settings → Server's database line and Copy again, and the threads' batch rebuild (docs/plan/14: the
  two-file database scheme, moving threads onto items). `Devices.tsx` and the paired phones under Network access, with
  device pairing (14, Deferred).
- **Checks.** `tests/ui/projectSettings`, `proxyConfig` (on `--fake-claude`: Agent configs need a host that runs
  agents), `reviewerOptions`, `summarizers`, `systemPromptPreview`, `guide`, `settingsPanels` (the old `confirmErrors`'
  refused profile delete through `routeRpc`, a shortcut's key, onboarding) and the unarchive half of `archiveProjects`.
  Changed from the old checks: a tab of another area is waited for by its heading; `reviewerOptions` types its skills;
  `summarizers` no longer reads the single `summarizer`; `guide` opens the workflows page by its address (the old check
  followed the Workflows tab's link, 6.6's); the shortcut moved is the search field's (Triage isn't on this server).
  Not ported: `databaseFile` (dropped), `worktreeSetup` (the board's setup thread, not a settings panel), `devices`
  (deferred), and the settings checks of other areas (`hostRelease`, `hostUpdate`, `release-update`, `nearbyHosts`,
  `telemetry`, `skillSources`, `agentTools`, `automations`, `workflows*`, `githubClone`, `githubCreate`).
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

Step 2 is not a condition of switching over to the new server. Its tasks run in parallel with the server's later
milestones and after the switch, largest files first: `settings/Server.tsx`, `task/Approvals.tsx`,
`settings/TokenStats.tsx`, `changes/Compare.tsx`, `task/Questions.tsx`, `task/Document.tsx`, `task/TaskView.tsx`,
`task/Memory.tsx`, `task/Review.tsx`, `thread/Composer.tsx`, `task/Terminal.tsx`. A file leaves the lint override
when it is done, and the override is deleted when the last one has.

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

## The desktop shell: `apps/desktop`

The Electron shell (six CommonJS files, 1,687 lines) becomes TypeScript, with its main process an Effect program
(`NodeRuntime.runMain`): find or start a server through the launcher and read its `HUNTAWAY_READY` line, watch its
health, open windows, update itself. What it does, and the rules that make it safe, are unchanged (inventory 10,
section 9): only `ECONNREFUSED` means "no server"; a failed start is blamed on the new build only after another
server came up; AppImage and pacman installs are done by the shell; `app/state.json` is shared with the server's
`Releases` service and keeps its format; the preload exposes the same six members on `window.huntawayDesktop`, to
the main frame only, with origin checks.

## The phone app

Not part of this plan. The old Expo app speaks the old API and keeps working against machines that have not
switched; it cannot reach one that has. When it is taken up again, its screens are kept and its state modules are
replaced by `packages/client` with a key-value store on `expo-secure-store`, and three server pieces come with it:
device pairing, Expo push, and answering a prompt from the lock screen. Effect on React Native would be the first
thing to prove (T3 Code ships an Expo 58 app on Effect 4, which is good evidence).

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
