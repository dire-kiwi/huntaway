# 9. Frontend

The web app, the shared client, the desktop shell and the phone app. The React components are kept: their markup,
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

Shared by the web and mobile apps. No DOM, Node or React Native APIs: each app gives it a websocket constructor and a
key-value store as layers.

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
alive while something shows it and for ten seconds after, as now. `olderItems` pages back with `threads.page`. The
text streamed for the reply being written is its own atom (`threadPreviewAtom`), flushed once per animation frame,
so a token does not re-run anything that reads the thread. `itemModel.ts` keeps turning items into rows with stable
identity.

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

## The phone app: `apps/mobile`

Expo 58, React Native 0.88, expo-router. Its screens and components are kept. Its state modules (`boards.ts`,
`live.ts`, `load.ts`, `inbox.ts`, `boardData.ts`, `tasks.ts`, `thread.ts`, `session.tsx`) are replaced by
`packages/client`, with three platform layers of its own: a key-value store on `expo-secure-store`, the global
`WebSocket`, and the notification handlers. One client per paired board, each with its device token.

- Push keeps its security shape (inventory 11): Allow and Deny from the lock screen work without the keychain, with
  a one-time token posted to `/api/push-answer`; a tap is handled once across the listener, the background task and
  a relaunch.
- **Effect on React Native is the one unproven platform in this plan.** T3 Code ships an Expo 58 app on Effect 4,
  which is good evidence. M0 proves it here: a screen that subscribes to `board.watch` on a device and in Jest, with
  `effect` and `@effect/*` added to Jest's `transformIgnorePatterns`.
- The phone is where the size of the board snapshot is measured ([05-protocol.md](05-protocol.md#the-board)).

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
