# Effect conventions

How code is written in this repository. It started as [the plan's conventions page](plan/12-conventions.md) and is the
one to keep up to date from here on. Every rule was checked against `effect` 4.1.4 in [the spike](plan/spike/README.md),
in HA-408's spike, or in M0 (HE-3).

## Read the package's own documentation first

`node_modules/effect/AGENTS.md` and `node_modules/effect/ai-docs/src/` describe version 4, and the sources are in
`node_modules/effect/src/`. Most examples on the web, and most of what a model remembers, describe version 3. The
names that changed and that the spike or HA-408 tripped over:

| Version 3 (wrong here)                                                        | Version 4                                                                                                                                                                          |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@effect/platform`, `@effect/rpc`, `@effect/sql`, `@effect/cli`, `@effect/ai` | Inside `effect`: `effect/http`, `effect/http-api`, `effect/rpc`, `effect/sql`, `effect/cli`, `effect/ai`, `effect/process`, `effect/socket`, `effect/reactivity`, `effect/testing` |
| `Context.Tag`, `Effect.Service`                                               | `class X extends Context.Service<X, { … }>()("huntaway/area/X") {}`                                                                                                                |
| `Effect.catchAll`                                                             | `Effect.catch`                                                                                                                                                                     |
| `Effect.either`                                                               | `Effect.result`                                                                                                                                                                    |
| `Effect.fork`, `Effect.forkDaemon`                                            | `Effect.forkChild`, `Effect.forkDetach`; in a layer or handler, `Effect.forkScoped`                                                                                                |
| `Effect.async`                                                                | `Effect.callback`                                                                                                                                                                  |
| `Effect.makeSemaphore`                                                        | `Semaphore.make`, `Semaphore.withPermits`                                                                                                                                          |
| `Schema.Literal("a", "b")`, `Schema.Union(a, b)`                              | `Schema.Literals(["a", "b"])`, `Schema.Union([a, b])`                                                                                                                              |
| `Command.make` from `@effect/platform`                                        | `ChildProcess.make("git", ["status"])` run by `ChildProcessSpawner` (`effect/process`)                                                                                             |
| `Stream.scan(initial, f)`                                                     | `Stream.scan(() => initial, f)`                                                                                                                                                    |
| `@effect-rx/rx-react`, `@effect-atom/atom-react`                              | `Atom`, `AtomRpc`, `AsyncResult` from `effect/reactivity`; hooks from `@effect/atom-react`                                                                                         |
| `DateTime.unsafeMake`                                                         | `DateTime.makeUnsafe`                                                                                                                                                              |

Use the barrel imports the package's own docs use: `import { Effect, Layer, Schema } from "effect"` and
`import { RpcServer } from "effect/rpc"`. The three hook commands are the exception: they import nothing from
`effect` (see [06-server.md](plan/06-server.md#hook-commands)).

Versions are exact in the pnpm catalog. `effect/http`, `effect/rpc`, `effect/sql`, `effect/ai`, `effect/process`,
`effect/reactivity` and `effect/cli` are tagged unstable, so a minor release may break them. Upgrading `effect` is a
task of its own, with the whole suite as its check.

## Services

- **A capability is a method of a service.** Websocket handlers, HTTP routes, MCP tools, scheduled work and the CLI
  only decode, call one method and map errors. Anything else belongs in the service, where the other four can reach
  it. This is the rule that keeps a board tool and a button doing the same thing.
- **One service to a file, named for it**: `Tasks.ts` holds `class Tasks`. In order: the errors it adds, the
  `Context.Service` class with its interface written inline, and `static readonly layer`. A service too large for one
  file keeps its class and layer in `Tasks.ts` and puts the methods' bodies in `tasks/*.ts` as functions that take
  what they need.
- **Methods are written with `Effect.fn("Tasks.create")`**, which names the span and the stack frame. Hot paths
  (one call per line of agent output) use `Effect.fnUntraced`.
- **Dependencies come from the environment**, taken once when the layer is built (`const sql = yield* SqlClient.SqlClient`),
  not passed as parameters and not looked up inside a method.
- **`static readonly layer` needs its dependencies; nothing provides them locally.** The composition root
  (`apps/server/src/Main.ts`) is the one place that wires layers, so a test can replace any of them.
- **No runtime inside a service.** `Effect.runPromise`, `Effect.runFork`, `ManagedRuntime.make` and
  `NodeRuntime.runMain` appear in entry points only: `apps/server/src/bin.ts`, the web app's `main.tsx`
  (through the atom registry), Electron's main process, and test helpers. A structural test holds this.
- **Pure code stays plain.** A function with no I/O, no clock and no failure worth a tag is an ordinary exported
  function beside the service (the thread reducer, the diff parser, the workflow graph checks, the approval-rule
  matcher). It is tested without a layer.

## Errors

- **Tagged, with fields, never matched on message text**:
  `class TaskNotFound extends Schema.TaggedError<TaskNotFound>()("TaskNotFound", { id: TaskId }) {}`. Fields are
  bounded: ids, names, counts and short reasons, never a prompt, a token or a file's contents.
- **Errors that cross the wire live in `packages/contracts`** and are listed on the RPC or endpoint that can fail
  with them. A service may fail with more than its transport declares; the handler maps the rest with
  `Effect.catchTags` or lets them die.
- **Expected failures are in the type; bugs are defects.** `SqlError` and `SchemaError` from our own database are
  defects (`Effect.orDie` at the repository), as in the package's SQL example. A defect reaches the client as an
  opaque internal error and is logged with its cause.
- **No `try` around a `yield*`.** A failed Effect ends the generator; it is not thrown into it. Recovery is
  `Effect.catchTag`/`Effect.catch`; cleanup is `Effect.ensuring`, `Effect.onExit` or `Effect.acquireRelease`.
  `try`/`catch` is for a synchronous call that throws (`JSON.parse`), and better written as `Effect.try`.
- **Always `return yield*` when failing** (`return yield* new TaskNotFound({ id })`), so the type checker knows the
  generator stops.

## Schemas

- **Everything that crosses a boundary has a schema**: RPC payloads and results, HTTP bodies, events, rows read
  from SQLite, JSON columns, files in a run's folder, lines from an agent's stdout, settings, what the importer reads
  from the old database. No `as`, no `any`, no hand-written `isRecord`.
- **Wire types are `Schema.Struct`s whose decoded and encoded forms are the same** (plain JSON: strings, numbers,
  booleans, arrays, objects, `null`). Timestamps are ISO strings, ids are branded strings. The React components
  build and spread these values freely, and structural sharing between events keeps unchanged rows from redrawing;
  both break with class instances or decoded `DateTime`s. Inside the server, convert at the point of use
  (`DateTime.makeUnsafe(task.created_at)`).
- **Field names on the wire stay snake_case**, as the old API has them (`worktree_path`, `claude_config_id`). The
  kept components read thousands of them. Everything else is ordinary TypeScript naming: camelCase functions and
  variables, PascalCase types, services and files that hold one.
- **Ids are branded** (`TaskId`, `ProjectId`, `RunId`, `ProfileId`, `HostId`…), so a function that wants a project
  id does not take a task id. Brands are erased on the wire.
- **Unions are tagged with `type`** where the old wire format has it (events, thread items, workflow nodes), using
  `Schema.Union([...])` of structs with a literal `type`, so the components' `switch (e.type)` keeps working.
  New internal unions use `_tag` and `Schema.TaggedStruct`.
- **Unknown input is preserved where the old code preserves it**: a thread item's `metadata`, an agent's tool input
  and result are `Schema.Unknown`/`Schema.Record` and are stored as given.

## Concurrency and state

Effect's default scheduler lets a fiber switch at any `yield*`, including between a check and the call that acts on
it (HA-408 measured it). The old server relied on code between two `await`s being atomic. This codebase does not
rely on that anywhere. Instead:

- **A change to stored state is one transaction** (`sql.withTransaction`). The SQLite client holds its one
  connection for the whole transaction, so no other fiber's statement runs inside it. A transaction contains
  database statements and pure code only: no process, no network, no file system, no sleep.
- **A read followed by a write that depends on it is in one transaction, or under the entity's lock.** Work on one
  task that spans I/O (start a run, merge, remove a worktree) holds that task's lock from `KeyedLock`
  ([06-server.md](plan/06-server.md#keyedlock)): `locks.withLock(["task", id])(effect)`. Locks are taken in a fixed
  order (project, then task, then run) and never across a wait for the user.
- **In-memory state is a `Ref`, `SynchronizedRef` or `SubscriptionRef` owned by one service**, changed through that
  service's methods. No module-level `let`, no exported `Map`.
- **Every `Effect.all`, `Effect.forEach` and `Stream.mapEffect` states its `concurrency`**, `1` included. The default
  is sequential, which is the opposite of `Promise.all`. A structural test holds this.
- **Background work is a fiber tied to a scope.** A loop that lives as long as the server is
  `Layer.effectDiscard(loop.pipe(Effect.forkScoped))` in its service's layer. Work that belongs to an entity (a
  run's follower, a link's connection, a terminal) lives in a `FiberMap` keyed by the entity's id, so starting it
  twice replaces the first and removing the entity interrupts it.
- **Interrupting a fiber never signals an agent.** Agents run under `ia-shim` and outlive the server by design.
  Stopping an agent is an explicit method (`Runs.stop`), never a finalizer.
- **Timeouts, retries and polling are `Effect.timeout`, `Effect.retry` and `Effect.repeat` with a `Schedule`**, and
  durations are written as strings (`"20 seconds"`). No `setTimeout`, `setInterval` or `Date.now()` in server code
  (lint errors): time comes from `Clock`/`DateTime.now`, so tests run on `TestClock`.
- **Emit after commit.** A method that changes state publishes its events after its transaction commits, in the
  order it committed (the `Events` service does both; see [06-server.md](plan/06-server.md#events)).

## Transports

- **The contract is in `packages/contracts` and nowhere else.** The server implements it and the clients derive
  their calls from it. A change that the two ends disagree on does not type-check.
- **A handler is three lines**: take the decoded payload, call one service method, map errors that are not on the
  contract. Authorisation that depends on the session (a paired device, a profile's access) is RPC middleware or a
  check in the service, never in the handler body.
- **Streams over RPC are finite or interruptible.** A subscription ends when the client goes away; the handler's
  scope closes and its fibers stop.

## Frontend

- **Components do not call the server.** They read atoms (`useAtomValue`) and trigger mutations (`useAtomSet`).
  Atoms, queries and mutations are in `packages/client`.
- **Server state arrives by subscription and is folded into atoms.** A component never refetches because it thinks
  something changed. Optimistic changes use `Atom.optimistic`, not a copy in component state.
- **Local UI state stays in React** (`useState`) when one component owns it. State that outlives the component or
  is shared (drafts, the open task, a board's filter) is an atom; state that survives a reload is `Atom.kvs` over
  the browser's storage, with a schema.
- **No `useEffect` to fetch.** An effect in a component is for the DOM (focus, measurement, a terminal). Data
  loading is an atom mounted by the component that needs it.
- **How, as built** (docs/plan/09-frontend.md, Step 2 as done): a read is `useAtomValue(query("git.status", host,
  payload, { refresh?, focus? }))` from `@huntaway/client`, drawn with `<Loading>` or `resultValue`/`resultError`; it is
  read again when a mutation of its group runs on its host, or when what `triggers` in `packages/client/src/invalidate.ts`
  picks from the host's board changes. A change is `useMutation("tasks.update")` or, for a few calls in order,
  `useAction()` running an `Effect` of `mutate(...)` (`apps/web/src/state/mutation.ts`): their state (busy, the failure
  by tag) is the component's, their run the page's, so a dialog closed mid-save doesn't interrupt the call. Module code
  that isn't a component uses `runExit`. The time now is `useNow(step)`/`nowMillis()` (`state/clock.ts`), a DOM timer
  `after`/`every` (`state/timers.ts`).

## Tests

- **`@effect/vitest`**: `it.effect` for anything in Effect, on the test clock; `layer(TestLive)("…", (it) => …)` to
  share a built layer across a file. `it.live` only for a test that needs a real process or socket.
- **No sleeps, no polling, no wall-clock assertions.** Wait on what the code produces: a `Deferred`, an event from
  the `Events` stream, a row, the end of a fiber. Advance time with `TestClock.adjust`.
- **A dependency is replaced with a layer**, never with an environment variable read inside the code under test.
  The fakes are in `packages/testing` (a fake agent CLI, a fake `gh`, a fake GitHub, a git repository in a temp
  folder, a fake link).
- **A fixed bug gets a test that fails without the fix.**

## Linting

The code base starts strict and stays strict: **every rule that is on is an error, and a warning fails the check too.**
There is no backlog of warnings to grow, which is what the old repository ended up with. The configuration below was
run against a file that breaks it ([spike/lint](plan/spike/lint/README.md)): 13 errors from 24 lines, exit code 1.

`pnpm check` is `effect-tsgo vp check`: Oxfmt, Oxlint with type-aware rules, the type check, and the Effect rules
that `@effect/tsgo` adds to Oxlint as the `effecttsgo` plugin. The configuration is the root
[`vite.config.ts`](../vite.config.ts): `@effect/tsgo`'s `strict` preset (97 Effect rules at error), the Effect-native
rules it leaves off (time, timers, randomness, the environment, logging, JSON, `fetch`, Node's modules, promises), the
TypeScript rules above, `import/no-cycle`, and the package boundaries as `no-restricted-imports` per folder.
`denyWarnings` makes any warning fail. The overrides: the Effect-native rules are off for plain TypeScript
(`packages/shared`, `apps/server/src/hooks`, and the desktop shell's frame, preload and shared decisions in
`apps/desktop/src/{boot,preload,shared}`) and for config files; `strict-effect-provide` and `process-env` are off for
entry points, tests and `packages/testing`; the components get the React hook rules and are otherwise as strict as the
rest (step 2 of docs/plan/09-frontend.md): their times are `DateTime` (`components/ui/dates.ts`, `state/clock.ts`), their
DOM timers `state/timers.ts`, their handlers start mutations rather than being `async`. The one exception is
`components/docs/docFrame.ts`, whose comment script runs as source inside a document's sandboxed frame, where there is
no Effect: `global-timers` is off for it.

`tsconfig.base.json` holds the language service's options, which the lint reads too: `allowedUnstableApis` names every
unstable module this code base builds on (anything else unstable is an error, so a new one is a reviewed change to
that list), and `keyPatterns` makes service and error keys `<package name>/<path under src>/<Name>`.

### Checked in M0

`pnpm check` was run on files that break the configuration (HE-3): `effecttsgo/*` (async function, deterministic keys,
floating Effect, console, `Date`, `JSON`, `Math.random`, timers, Node builtin import, `process.env`, `Effect.provide`,
`try` around `yield*`), `typescript/no-explicit-any`, `typescript/no-non-null-assertion`, `import/no-cycle` (it needs
the `import` plugin listed in `plugins`, which then lists Oxlint's defaults too) and `no-restricted-imports` with
ESLint's `{ patterns: [{ group, message }] }` shape each reported an error, and the check exited 1. The `react/*`
rules were checked with the web app (M1).

Rules for living with it:

- **A rule is switched off for a line, with its reason**, never for a file or a folder outside the `overrides`
  above: `// @effect-diagnostics-next-line globalDate:off -- the DOM event carries a wall-clock time`. A structural
  test counts the suppressions and fails when the count grows without the list in `docs/effect.md` growing with it.
- **Service and error keys are the ones `deterministic-keys` computes** from the package's name and the file's path
  under `src/` (its quick fix writes them): `"huntaway-server/tasks/Tasks"`, `"@huntaway/contracts/session/Session"`.
  The plan's examples write `"huntaway/tasks/Tasks"` for short.
- **A rule is never lowered to `warn`.** If a rule is wrong for this code base it is turned off in the config, in a
  change that says why.
- **`@effect/tsgo` supports listed versions** of Oxlint and tsgolint (0.67.7: Oxlint 1.89 to 1.93; Vite+ 1.5.0 bundles
  1.91.0). An upgrade of Vite+ checks that list first.

## Structural tests

`apps/server/tests/structure/` holds the rules a reviewer would otherwise repeat. Each reads the sources with the
type checker or a pattern and fails with the file and line:

1. Nothing outside the entry points and `packages/testing` runs an Effect or makes a runtime.
2. No `yield*` inside a `try` block.
3. Every call that takes a `concurrency` option passes it.
4. The number of lint suppressions (`@effect-diagnostics`, `oxlint-disable`) matches the list in
   [Suppressions](#suppressions) below.
   (Timers, the clock, randomness and `process.env` are lint rules now, not a test.)
5. `packages/contracts` imports only `effect` and itself; `packages/client` does not import `apps/*` or Node
   modules; nothing in `apps/web/src/components` imports `effect/rpc`, `effect/http` or a `packages/client`
   internal (only its public atoms and types).
6. The hook commands' import graphs do not reach `effect`.
7. No source file passes 1,000 lines (tests, fixtures and generated files excepted).
8. Every RPC in the contract has a handler and states the scope it needs, and every board MCP tool has a schema and
   a handler (the layer would also fail to build; this gives a readable message).
9. Imports under `apps/server/src` follow the dependency order in [06-server.md](plan/06-server.md#dependency-order): an
   area imports the platform and the areas above it, never one below.
10. A repository (`*Repo.ts`, `*Store.ts`) imports no process, network or file-system service, so a transaction
    cannot contain a wait.
11. `ReadOnlyMain`'s import graph reaches nothing under `lifecycle/` and no loop's layer
    ([06-server.md](plan/06-server.md#a-read-only-server)). A loop's layer is told from the sources: a class's static
    whose initialiser forks as it is built.

These cover what a lint rule cannot see. Everything a rule can see is in [Linting](#linting).

## Suppressions

Every lint suppression in the code base, with its reason. The structural test `suppressions.test.ts` counts the
suppressions in the sources and fails when the count differs from the number of rows here.

None. The last one (`type Any = any` in the thread's rows) went with step 2 of the frontend, which gave the rows their
types (`components/task/thread/fields.ts`).

| File | Rule | Why |
| ---- | ---- | --- |
