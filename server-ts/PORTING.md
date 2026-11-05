# The server's conventions (ported from Rust, HA-174)

`server-ts/` is the `huntaway` server. It was ported to TypeScript from the Rust server crate (`server/src/`), which
the port replaced in every release, checkout and test server, and which was removed in HA-179. It runs on Node 24+
straight from the `.ts` files (Node strips the types; there's no build step): `bin/huntaway serve …` takes the same
arguments the Rust binary did. `ia-shim` and `huntaway-broker` stay in Rust, in the `server/` workspace (they're
separate binaries, and the shim's 1 MB per agent run is far below any Node process's); the server runs the Rust
`ia-shim` (see `agent/runs.ts`).

The code keeps the shape and the names of the Rust it came from, and new code follows the same conventions (below):
there's no plan to rename things to TypeScript's usual camelCase. A file's first line says which Rust file it's a port
of (`// Port of server/src/agent/runner/queue.rs.`). That Rust is in git history: the parent of the commit that removed
it has it (`c136b11`, for one), so `git show c136b11:server/src/agent/runner/queue.rs` reads it. Branches from before
the removal that changed the Rust server (HA-117's personal mode, HA-173's workflow automations, HA-128 and HA-143's
agent threads) are ported by HA-190, HA-189 and HA-191, by reading those changes against the same paths here.

Scope: the whole server, including linking hosts (hub links, relay, SSH, broker: the broker's side of its protocol is
`hosts/broker/proto.ts`, from `server/broker/src/proto.rs`, and tests run the Rust broker as a process, see
`hosts/broker/test_broker.ts`), Web Push, restarts, self-update from a checkout and release updates (`bin/huntaway` execs
for the server, see `update/admin.ts`'s `exec`).

## Conventions (keep to them: code calls other modules by these rules, and they keep it matching the Rust it came from)

- **One TS file per former Rust file, at the same path**: `server/src/agent/runner/queue.rs` →
  `server-ts/src/agent/runner/queue.ts`, and new modules are laid out the same way. A module with parts (`runner.rs` +
  `runner/*.rs`) is `runner.ts` + `runner/*.ts`, and `runner.ts` re-exports every part with
  `export * from "./runner/queue.ts";` (as Rust's `pub use queue::*`), so callers import from `runner.ts`.
  A folder module's root (`agent.rs`, `git.rs`, …) has no TS file: import from the module itself (`../agent/runner.ts`).
- **Same names as Rust**: functions, constants and struct fields keep their Rust names, snake_case included
  (`db.get_task(c, id)`, `runner.send_message(s, …)`, `task.project_id`). Types and classes keep their CamelCase names.
  New code names things the same way.
- **Imports** use the `.ts` extension, relative paths, and namespace imports for modules from other areas, as Rust paths
  read: `import * as db from "../db.ts"; import * as runner from "../agent/runner.ts";` → `db.get_task(s.db(), id)`.
  `import type` for type-only imports (`verbatimModuleSyntax` is on). Circular imports are fine for functions, but don't
  call another module's code at module load time (top-level statements), and don't `export const x = otherModule.y`.
- **Methods**: rows and other serialized structs stay plain objects, so a method in an `impl` block
  (`impl Project { pub fn preview_for(&self, pr) }`) is an exported free function of the same name taking the value
  first: `db.preview_for(p, pr)`, `db.is_scratch(t)`. Where two types in one module have a method of the same name,
  it's `<type_snake>_<method>`. Associated functions without `self` (`Task::new`) are `<Type>_<fn>` (`Task_new`).
  Types that are only state (not serialized: a `PushState`, `Releases`, a `Relocations`) can be classes with methods.
  A Rust function's `&[(&str, Value)]` fields list is `Array<[string, any]>`.
- **Only erasable TypeScript** (Node strips types and nothing else): no `enum`, no `namespace`, no constructor parameter
  properties (`constructor(public x)`), no `import x = require()`. Use string unions and plain objects.
- **Types**: interfaces for structs, matching their serde JSON exactly (field names, `skip_serializing_if`, renames,
  `#[serde(flatten)]`): a TS object is serialized with `JSON.stringify`, so build the object the API returns as serde
  would. `Option<T>` is `T | null` (serde writes `null`; use `undefined` only where serde skips the field).
  `serde_json::Value` is `any`. Loose typing (`any`) is fine where precise types would cost time.
- **Sync stays sync, async stays async.** A Rust `async fn` is an `async function`; a plain `fn` is a plain function.
  `tokio::spawn(fut)` is calling the async function without awaiting it, with a `.catch` that logs.
  `tokio::time::sleep` is `await sleep(ms)` from `util.ts`. Timers: `setTimeout`/`setInterval`, `.unref()` on loops that
  shouldn't keep a test process alive.
- **Errors**: `anyhow::Result<T>` is `T` with exceptions (`throw new Error(…)`); `.context("x")` is
  `throw context("x", e)` from `util.ts`; `format!("{e:#}")` is `err_str(e)`. `ApiResult<T>` handlers throw
  `ApiError` (`ApiError.bad(msg)`, `.not_found(what)`, `.conflict(msg)`, `new ApiError(status, msg)`) from `http.ts`;
  any other exception is a 500 with `{"error": err_str(e)}`, as `From<anyhow::Error> for ApiError` does.
- **Database**: `node:sqlite`'s `DatabaseSync`, synchronous like rusqlite. `s.db()` returns the connection (there's one
  thread, so there's no lock and no guard to drop). Query with the helpers in `db.ts`: `one(c, sql, ...params)` (a row
  or `undefined`, as `.optional()`), `all(c, sql, ...params)`, `run(c, sql, ...params)` (`{changes, lastInsertRowid}`),
  `value(c, sql, ...params)` (the first column of the first row, or `undefined`). `?1`, `?2` parameters work as in
  rusqlite. They turn booleans into 0/1 and `undefined` into NULL; rows come back with INTEGER columns as numbers, so
  convert 0/1 to booleans where the Rust struct has a `bool`. Transactions: `tx(c, () => …)`.
- **Processes**: `std::process::Command`/`tokio::process::Command` → `node:child_process` (`execFile`/`spawn`, or the
  helpers `run_cmd`/`run_ok` in `proc.ts`). Keep the same arguments and environment.
- **HTTP handlers** (axum `async fn x(State(s), Path(id), Query(q), Json(b)) -> ApiResult<Json<Value>>`) are
  `export async function x(s: AppState, r: Req): Promise<any>` (see `http.ts`): `r.params.id`, `r.query` (an object of
  the query string's values, last one wins), `r.body` (the parsed JSON body, `{}` when empty), `r.headers`, `r.raw`
  (the body's bytes). Return the JSON value for a 200, or `new Reply(status, body, headers)` for anything else
  (a `Buffer` or string body is sent as is). Websocket routes are `(s, r, ws) => void`, with `ws` a `ws` package
  WebSocket. Add the handler to `api.ts`'s route table (`host_routes`).
- **Events**: `s.emit(ev)` broadcasts to `s.events` (this host's) and the hub forwards them to `s.hub_events`
  (the UI's). `s.events.subscribe(fn)` returns an unsubscribe function. A Rust `broadcast::Receiver` loop is a
  subscription.
- **Shared state** in `AppState` (`state.ts`) keeps Rust's field names; `Mutex<HashMap<…>>` is a `Map`.
- **Tests**: a module's tests are `<module>.test.ts` beside it (`git/worktree/tests.test.ts` for the ported
  `git/worktree/tests.rs`, `<module>.test.ts` for an inline `mod tests`), with `node:test` (`import { test } from "node:test";
  import assert from "node:assert/strict";`) and the same test names. `testing.ts` has `state()` (an `AppState` on an
  in-memory database with a temp data dir) and `temp_dir()` (removed when the test file's tests end).
  Run one file: `node --test src/path/file.test.ts`; all: `npm test`. Async tests can just be `async` (node:test times out at 60 s with `npm test`).
- **Style**: lines up to about 160 characters, 2-space indents, double quotes, no Prettier/ESLint. Keep Rust's doc
  comments (as `/** … */`) where they explain something; drop ones that only describe Rust mechanics.
- Check with `npm run typecheck` (from `server-ts/`), which should be clean.

## Notes

- `AppState.exe` is `server-ts/bin/huntaway` (the command agents' MCP helpers run with `IA_MCP_STDIO=1`: `huntaway
  mcp`). The Rust `ia-shim` is found by `runs.ts`'s `shim_path`: `$IA_SHIM_BIN`, else
  `server/target/{release,debug}/ia-shim` in this checkout (the newer one), else `ia-shim` beside `bin/huntaway`.
- Server code must not import `testing.ts` (it imports `node:test`, which turns a process into a test run). The race
  hooks `when`/`reached` are in `util.ts` (`testing.ts` re-exports them for tests).
- db: fields serde never writes (`api_key`, `asana_token`, `queued_user_text`, `Project.repo_root`,
  `Link.token`, …) are non-enumerable properties (`db.hidden(obj, key, value)`): readable, but `JSON.stringify` and
  spreads leave them out, so copy them by name. `Option` fields serde skips when empty are left off the object.
  `<Type>_from_json(v)` in `db/task_data.ts` does serde's deserialization of each struct there (defaults, shape checks);
  `de_str`, `de_opt_str`, `de_vec`, … read single fields. `check_resolution` and `check_dependencies` throw
  `ApiError.bad` rather than returning an error. `Queued::then` is `queued_then` (a module exporting `then` becomes a
  thenable).
