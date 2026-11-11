# Reference spike

Small files that exercise every Effect module the plan leans on. They were type-checked and run on
11 November 2026 against the versions in `package.json` here (Node 26.13, TypeScript 7.0.2). They are the
shapes to copy when in doubt about a v4 API: each is the smallest thing that worked, not a design.

| File              | What it shows                                                                                              | Checked by                              |
| ----------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `contracts.ts`    | Branded ids, `Schema.Class`, tagged errors, a tagged event union, an RPC group with a streaming method, RPC middleware that provides a `Session` | type check |
| `server.ts`       | `@effect/sql-sqlite-node` (on `node:sqlite`) with a migrator, two services with layers, a transaction, a `PubSub` event bus, the RPC group served over a websocket (`/ws`) and over plain HTTP (`/rpc`) beside an ordinary route | ran it |
| `client.ts`       | The typed RPC client over a websocket in Node: a stream subscription, two calls, a typed error caught by tag, the token sent by client middleware | ran it: `task done`, `events TaskUpserted#1,TaskUpserted#2`, `not found: nope`; a bad token fails with `Unauthorized` |
| `client-http.ts`  | The same client over HTTP POST (what a script or `curl` uses)                                                | ran it; `curl` with one NDJSON line also answered |
| `web.tsx`         | The frontend pattern: `AtomRpc.Service`, a board read model folded from the event stream in an atom, a per-task `Atom.family`, a mutation, `useAtomValue`/`useAtomSet` in a component | type check |
| `mcp.ts`          | Effect's MCP server over HTTP: two toolkits, a caller taken from headers by middleware, a tool hidden from reviewers with `McpServer.visibility`, a child process run inside a tool | ran it: `initialize`, `tools/list` as a task (2 tools) and as a reviewer (1), `tools/call` |
| `domain.ts`       | The central wire types as [03-domain.md](../03-domain.md) declares them: branded ids, enumerations, the task, the thread protocol, events, wire errors, a JSON column read leniently | type check |
| `lint/`           | The strict lint configuration and a file that breaks it: [lint/README.md](lint/README.md) | ran it: 13 errors, exit 1 |
| `server.test.ts`  | `@effect/vitest`: the real services on an in-memory database behind `RpcTest.makeClient` (no socket), and twenty minutes passing at once on `TestClock` | `vitest run`: 3 passed |

To run them again:

```sh
cd docs/plan/spike
npm install
npx tsc -p .                                  # type check
npx vitest run server.test.ts
PORT=47811 node server.ts &                   # Node 24+ runs the .ts files as they are
PORT=47811 node client.ts
PORT=47811 node client-http.ts
PORT=47813 node mcp.ts &
```

What they do not show: Effect in React Native, Electron's IPC, a pty, or anything under load. The plan's
_Not verified_ list has those.
