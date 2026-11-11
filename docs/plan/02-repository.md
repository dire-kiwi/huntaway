# 2. Repository: layout, dependencies, toolchain

## Layout

A pnpm workspace with Vite+ (`vp`) as its toolchain and a Cargo workspace for the shim, as the old repository has.
The differences are the three packages under `packages/` and the desktop shell getting an app of its own.

```
apps/
  server/                 the server (package huntaway-server)
    bin/huntaway          the launcher: sh, carried over; keeps the PID, restarts on a crash, execs on exit 75
    src/
      bin.ts              entry point: the CLI
      Main.ts             composition root: every layer, in startup order
      cli/                one file per subcommand (serve, token, rpc, import-legacy, install-service, ssh-host, …)
      hooks/              approval-hook, gh-hook, gh-run: plain TypeScript, no effect import
      codex-run.ts        the adapter between a run's files and `codex app-server` (its own process, uses Effect)
      platform/           Db, Migrations, Events, KeyedLock, Proc, DataDir, ServerConfig, Secrets, Telemetry, Backup
      rpc/                one file per RPC group: handlers only
      http/               plain HTTP routes: health, pairing, webhooks, push answers, static UI, relay, terminal socket
      lifecycle/          rules that span areas: after a task changes, after a run ends, startup recovery
      <area>/             one folder per area; see 06-server.md for the list and each area's services
      prompts/            every prompt the board writes, as text, ported verbatim
    migrations/           named migrations: YYYY-MM-DD-a-few-words.ts
    tests/
      structure/          the structural tests (12-conventions.md)
      e2e/                whole-server tests against a fake agent
  web/                    the board's UI (package huntaway-web)
    src/
      main.tsx, App.tsx
      components/         carried over, a folder per feature, as they are now
      state/              atoms only this app needs (routing, layout, drafts, theme)
      platform/           the browser's side: storage, notifications, service worker, desktop bridge
      index.css
    tests/
      browser/            component checks in a headless Chromium (Vitest browser mode), on a fake board
      ui/                 whole-app checks against a test server (Playwright)
      unit/
  desktop/                the Electron shell (package huntaway-desktop), from apps/web/electron
    src/main/             main process: start or attach to the server, windows, shell updates (TypeScript, Effect)
    src/preload/          the bridge the page sees
  mobile/                 the phone app (Expo, React Native): its screens carried over, its state from packages/client
packages/
  contracts/              @huntaway/contracts: schemas, errors, RPC groups, HTTP endpoints, events, the thread protocol
  client/                 @huntaway/client: host sessions, atoms, queries and mutations, for web and mobile
  shared/                 @huntaway/shared: plain functions with no effect import, used by hooks, server and clients
  testing/                @huntaway/testing: fake agent CLIs, fake gh and GitHub, git and board fixtures, test layers
rust/
  shim/                   ia-shim, unchanged
scripts/                  test-server, ui-check, package-server, install scripts, release checks
docs/
  guide/                  the user guide, carried over and corrected as features land
  plan/                   this plan, the spike, and the inventory of the old code
  effect.md               the conventions (12-conventions.md), once M0 lands
```

### What goes in which package

| Package              | Holds                                                                                                                              | May import                              | Must not                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------ |
| `@huntaway/shared`   | Approval-rule matching, the shell-command reader the gh hook uses, task-key and slug helpers, text limits                           | nothing                                 | import `effect` (the hooks load it per tool call) |
| `@huntaway/contracts`| Branded ids, domain structs, tagged errors, the RPC groups, the HTTP endpoints, `BoardEvent`, the thread protocol and its pure reducer | `effect`, `@huntaway/shared`            | Node or DOM APIs; anything that runs at import    |
| `@huntaway/client`   | `HostSession` (one RPC connection), the session directory, board and thread atoms, queries, mutations, optimistic updates           | `effect`, `@effect/atom-react`, contracts, shared | Node, DOM or React Native APIs (the apps provide storage and sockets as layers) |
| `@huntaway/testing`  | Fakes and fixtures, including the recorded Claude and Codex sessions                                                                | anything                                | be imported by non-test code                      |

The packages ship their TypeScript sources (`"exports": "./src/index.ts"`), with no build step, as `packages/client`
does today.

## Dependencies

Exact versions go in the pnpm catalog. These are the ones checked by the spike.

### Runtime

| Package                         | Version  | Used by            | For                                                                                   |
| ------------------------------- | -------- | ------------------ | ------------------------------------------------------------------------------------- |
| `effect`                        | 4.1.4    | everything         | Core, `Schema`, `effect/rpc`, `effect/http`, `effect/sql`, `effect/process`, `effect/socket`, `effect/cli`, `effect/ai` (tool schemas), `effect/reactivity` |
| `@effect/platform-node`         | 4.1.3    | server, desktop    | `NodeRuntime`, `NodeHttpServer`, `NodeServices` (file system, path, child processes), `NodeSocket`, `NodeWS` |
| `@effect/sql-sqlite-node`       | 4.1.3    | server             | The SQLite client on Node's built-in `node:sqlite`. No native module                  |
| `@effect/atom-react`            | 4.1.3    | client, web, mobile | Hooks over atoms (`useAtomValue`, `useAtomSet`, `RegistryProvider`)                   |
| `@effect/platform-browser`      | 4.1.3    | web                | `BrowserKeyValueStore` (localStorage behind `Atom.kvs`), `BrowserSocket`, workers     |
| `sharp`                         | ^0.35    | server             | Document images to AVIF, as now                                                       |
| `@dire-kiwi/docs-render`        | 0.2.0    | server, web        | Rendering documents, as now                                                           |
| `react`, `react-dom`            | ^19.3    | web                | As now                                                                                |
| the web app's other dependencies | as now  | web                | `@xterm/*`, `shiki`, `mermaid`, `react-markdown`, `remark-gfm`, `lucide-react`, `clsx`, `qrcode-generator`, Tailwind 4 |
| `expo` 58, `react-native` 0.88  | as now   | mobile             | As now                                                                                |
| `electron`                      | ^45      | desktop            | As now                                                                                |

Leaving: `zustand` (atoms replace the store) and the server's direct dependency on `ws` (it comes with
`@effect/platform-node`). `effect` has no dependencies of its own.

### Development

| Package              | Version                | For                                                                                         |
| -------------------- | ---------------------- | ------------------------------------------------------------------------------------------- |
| `vite-plus`          | 1.5.0                  | `vp check` (Oxfmt, Oxlint, the type check on TypeScript 7), `vp test` (Vitest 5.1), `vp build` |
| `@effect/vitest`     | 4.1.3                  | `it.effect`, `layer(...)`, the test clock                                                   |
| `@effect/tsgo`       | 0.67.7                 | Effect's diagnostics inside `vp check` and the editor. Its list of supported Oxlint and tsgolint versions includes Vite+ 1.5.0's |
| `tsrs`               | 0.22.0-ts7.1.0-beta    | Compiling the server to JavaScript for a release package, as now                            |
| `playwright`         | 1.64.1                 | `tests/ui` and Vitest's browser mode                                                        |
| `electron-builder`   | ^26                    | Desktop packages                                                                            |
| `jest`, `jest-expo`  | as now                 | The mobile app's tests. Every ES-module-only package it loads has to be named in `transformIgnorePatterns`: `effect` and `@effect/*` join that list |

Rust: `ia-shim` keeps its one dependency (`libc`), edition 2024, Rust 1.89+.

### On the machine

Node 24 or newer (the server runs from its `.ts` files by type stripping; a release carries its own Node), `git`,
`claude` and/or `codex`, `tmux` for terminals, `gh` for GitHub, `ssh` for SSH links, `python3` for the pty helper
until it is replaced ([06-server.md](06-server.md#terminal)).

## TypeScript settings

One `tsconfig.base.json`, extended by each package:

```jsonc
{
  "compilerOptions": {
    "target": "es2024",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "erasableSyntaxOnly": true, // Node runs the sources: no enums, namespaces or parameter properties
    "verbatimModuleSyntax": true,
    "allowImportingTsExtensions": true, // imports name the file: "./Tasks.ts"
    "noEmit": true,
    "skipLibCheck": true
  }
}
```

The old server had `noImplicitAny: false` and `useUnknownInCatchVariables: false`; both are gone. The web app adds
`"jsx": "react-jsx"` and DOM libs; `packages/contracts`, `packages/client` and `packages/shared` have neither DOM nor
Node types, which is how the type check keeps them portable.

## Scripts

| Command             | What it does                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| `pnpm check`        | `effect-tsgo vp check`: format, lint, type check and Effect's diagnostics over the workspace      |
| `pnpm fix`          | The same with fixes applied                                                                      |
| `pnpm typecheck`    | Type check only                                                                                  |
| `pnpm test`         | `vp test`: server, packages, the web app's unit tests and component checks                       |
| `pnpm test:e2e`     | The server's whole-process tests against a fake agent                                            |
| `pnpm test:ui`      | Builds the UI and drives test servers in Chromium                                                |
| `pnpm test:mobile`  | Jest                                                                                             |
| `pnpm dev`          | The UI with hot reload against a server (`HUNTAWAY_SERVER`, default the test server last started) |
| `pnpm build`        | The UI, which the server serves                                                                  |
| `pnpm desktop`      | The Electron shell from the checkout                                                             |
| `cargo test`        | The shim's tests                                                                                 |

Formatting stays Oxfmt at 160 columns and linting stays Oxlint with type-aware rules, both configured in the root
`vite.config.ts`. Markdown under `docs/` is wrapped at 120.

## CI

`.github/workflows/test.yml`, with the same shape as the old one because the same things make it fast: a `tree` job
that skips the rest when exactly these files have already passed, then `check`, `server`, `packages`, `web`,
`mobile`, `ui (1/3 to 3/3)`, `e2e` and `rust` in parallel, then `green` to record the pass. Self-hosted runners for
the owner's branches. Release and preview workflows are in [13-milestones.md](13-milestones.md) (M9).

## Names that stay, and names that change

Some names are baked into things that outlive a server or live outside this repository. They stay:

- `ia-shim`, and every file name in a run's folder.
- The branch prefix `ia/` and the refs under `refs/huntaway/` (existing branches, worktree folders and CI rules use
  them).
- The variables given to a project's setup, teardown and status scripts (`IA_TASK_KEY`, `IA_WORKTREE_PATH`…), which
  users' scripts read. Each is also set as `HUNTAWAY_…`.
- `HUNTAWAY_TASK_ID` in an agent's environment.
- The board's MCP server name `huntaway`, and tool names as they are (agents' prompts, approval rules and old
  threads name them).
- The data folder an existing install already has (`~/.local/share/issue-agent` on machines from before the rename).

Everything else takes the product's name: the server's own environment variables become `HUNTAWAY_*` (`IA_PORT` is
`HUNTAWAY_PORT`), the test scripts' variables too, and the `issue-agent` command, `issue_agent` MCP server name and
`IA_*` server variables are not carried. [14-dropped-and-open.md](14-dropped-and-open.md) lists this with the
other things left behind.
