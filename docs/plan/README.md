# Huntaway on Effect: the plan

HE-2, 11 November 2026. Old code: `dire-kiwi/huntaway` at `f2298f0c`. Effect 4.1.4.

**The plan is to write Huntaway again as one Effect program, keeping its React components, its shim and its data,
and to switch each machine over by importing its database.** HA-408 planned converting the old server in place, one
area at a time. This replaces it: a new repository, written for Effect from the first file, with the old code as the
specification of behaviour and not of structure.

## In one page

- **Server**: one Node process per machine, as now, built as Effect services and layers. SQLite through
  `@effect/sql-sqlite-node`. Agents still run under `ia-shim` (Rust, unchanged) and still outlive the server.
- **Protocol**: one Effect RPC contract in `packages/contracts`, served over a websocket per host and over HTTP for
  scripts. It replaces 183 REST routes, the unsequenced event socket and the three formats hosts spoke to each
  other. Subscriptions start with a snapshot and resume by sequence number.
- **Frontend**: the 298 component files are kept. The store, the event feed and the hand-written client are replaced
  by atoms (`@effect/atom-react`) in `packages/client`. Components move in two steps:
  a mechanical one that gets the whole UI running, then a feature at a time.
- **Rules of the server**: every change is _decide (pure), commit (one transaction), publish, reconcile_. Work that
  spans a wait holds its task's lock. What must survive a restart is in the database or the run's folder. These
  replace the old server's reliance on nothing running between two awaits.
- **Quality from the first commit**: `@effect/tsgo`'s strict preset and the Effect-native rules, every rule an
  error, warnings failing the check. Run in a spike: 13 errors from a 24-line file.
- **Data**: a data folder and port of its own, so the new server runs beside the live board until the switch. A
  one-off importer then converts the old database and copies what it needs; the old folder is never written and is
  the way back. An imported board is the old host, so the importer runs for the switch or as a rehearsal that only
  a read-only server will open. Subprojects, Telegram and every compatibility layer are left behind. The phone app
  is left for later.
- **Work**: about 65 tasks in ten milestones. After M4 a task can go from To do to Done on the new server, and this
  repository's own work can move onto it.

## The pages

| Page                                               | What it settles                                                                                     |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [01-architecture.md](01-architecture.md)           | What runs, the layers of the server, the five patterns every area follows                           |
| [02-repository.md](02-repository.md)               | Directory layout, what goes in which package, dependencies with versions, TypeScript settings, scripts, CI, which names stay |
| [03-domain.md](03-domain.md)                       | The shapes of the types: ids, the task in full, thread kinds, the thread protocol, events, wire errors |
| [04-database.md](04-database.md)                   | The file, access and transactions, the migration runner, the schema as changes to the old one       |
| [05-protocol.md](05-protocol.md)                   | Sessions and scopes, every RPC group, the three subscriptions, the plain HTTP paths, versions        |
| [06-server.md](06-server.md)                       | Every service by area, the dependency order, the reactor, hooks, startup, the CLI                    |
| [07-agents.md](07-agents.md)                       | Runs and the run folder, the two drivers, how a run ends, threads, board tools, permissions, prompts |
| [08-hosts.md](08-hosts.md)                         | Links, the relay, tools across hosts, discovery, settings sync                                       |
| [09-frontend.md](09-frontend.md)                   | `packages/client`, the web app's state, moving the components, the desktop shell                     |
| [10-testing.md](10-testing.md)                     | How parity is checked, the test tiers, `packages/testing`, the tools agents use, measurements        |
| [11-migration.md](11-migration.md)                 | The importer table by table, the switch on one machine and on several, going back                    |
| [12-conventions.md](12-conventions.md)             | How code is written here: Effect 4 names, services, errors, schemas, concurrency, linting, structural tests |
| [13-milestones.md](13-milestones.md)               | The tasks, what each needs and reads, what "done" means                                             |
| [14-dropped-and-open.md](14-dropped-and-open.md)   | What is left behind, the decisions taken, open questions, risks, what was not verified               |
| [inventory/](inventory/README.md)                  | What the old code does, area by area: eleven notes, the checklist the port is held to               |
| [spike/](spike/README.md)                          | Code that was run against Effect 4.1.4: contracts, a server, clients, atoms, an MCP server, a test, the lint configuration |

An implementer reads 12 first, then the page for their area, then the inventory note that page names.

## What was checked, and how

- **Effect 4.1.4's actual API**, from the sources and the documentation inside the package, not from memory. The
  names that differ from version 3 are in [12-conventions.md](12-conventions.md).
- **A spike** ([spike/](spike/README.md)) that ran: an RPC group with a stream, typed errors and auth middleware
  over a websocket and over HTTP; `@effect/sql-sqlite-node` on `node:sqlite` with a migrator and a transaction; the
  typed client from Node and from `curl`; Effect's MCP server with per-caller tools; `@effect/vitest` on the test
  clock. It type-checked the atom pattern for the frontend and the central domain schemas.
- **The lint configuration**, run under Vite+ 1.5.0 ([spike/lint](spike/lint/README.md)).
- **The old code**, read by eleven survey agents to one brief ([inventory/](inventory/README.md)): about 200,000
  lines across the server, web app, phone app, client and tooling. One board's database was opened read-only for its
  schema, row counts and the names of its settings keys.

[14-dropped-and-open.md](14-dropped-and-open.md) lists what was not verified. The two that matter most are the
relay's signed session and the cost of the whole server on Effect, each with a task that checks it before anything
is built on it.

## Settled on review

- Subprojects' rows are kept as ordinary tasks.
- The phone app is left out for now.
- The new server gets a data folder of its own.

What is still open is in [14-dropped-and-open.md](14-dropped-and-open.md#open-questions).
