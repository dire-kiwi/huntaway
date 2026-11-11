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
  which is not in the contract yet, and the host's restart state (`admin.status`): 8.1. A row's version line shows
  `protocol` where it showed the API number. Copying a login between hosts is on the host page and Agent configs, which
  are 6.12's (its RPC, `hub.hosts.copyConfig`, is 7.5's).
- **Checks**: `packages/client/test/hosts.test.ts` (an in-memory hub with two hosts; the relay socket's new ticket per
  connection), and `tests/ui/hosts.test.mjs`: the Hosts page on one server, and two test servers linked through the
  page, the linked host's projects and tasks on the board, one opened and moved, the host stopped (its board stays,
  marked offline) and started again, and forgotten. The harness's servers have `kill()` and `restart()` for it.

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
                 pane, IPC, menu, relaunch), urls.ts, errorPage.ts
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
- **What the shell reads of the server**: `HUNTAWAY_READY {"port","token"}`, and `HUNTAWAY_BACKUP_FAILED {reason, why,
  dir}` for the error page's "Start without a backup". The server does not print the second yet (its `Backup` fails
  the start with a `StartupError`); until it does, a failed backup shows as a server that exited.
- **The package update** asks the board for the release status with `admin.status` over `POST /api/rpc` (a one-method
  group with the contracts' `Auth`), where the old shell called `GET /api/admin/server`. It reads only
  `release.latest.version` and `release.shell.outdated`. It hashes the download after writing it (Effect's `Digest`
  has no streaming hash), still before the rename.
- **Tests**: the old `desktop-versions`, `desktop-boot` and `desktop-shell-update` cases, and `Servers.test.ts`, which
  runs stand-in launchers (shell scripts) on a free port: the ready line, an installed version that exits and is
  blamed once the next is up, a failed backup, attaching to a server already there, remote mode, and windows sharing
  one start.

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
