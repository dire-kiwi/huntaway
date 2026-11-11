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
packages/
  contracts/              @huntaway/contracts: schemas, errors, RPC groups, HTTP endpoints, events, the thread protocol
  client/                 @huntaway/client: host sessions, atoms, queries and mutations, for the web app
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
| `@effect/atom-react`            | 4.1.3    | client, web        | Hooks over atoms (`useAtomValue`, `useAtomSet`, `RegistryProvider`)                   |
| `@effect/platform-browser`      | 4.1.3    | web                | `BrowserKeyValueStore` (localStorage behind `Atom.kvs`), `BrowserSocket`, workers     |
| `sharp`                         | ^0.35    | server             | Document images to AVIF, as now                                                       |
| `@dire-kiwi/docs-render`        | 0.2.0    | server, web        | Rendering documents, as now                                                           |
| `react`, `react-dom`            | ^19.3    | web                | As now                                                                                |
| the web app's other dependencies | as now  | web                | `@xterm/*`, `shiki`, `mermaid`, `react-markdown`, `remark-gfm`, `lucide-react`, `clsx`, `qrcode-generator`, Tailwind 4 |
| `electron`                      | ^45      | desktop            | As now                                                                                |

Leaving: `zustand` (atoms replace the store) and the server's direct dependency on `ws` (it comes with
`@effect/platform-node`). `effect` has no dependencies of its own.

### Development

| Package              | Version                | For                                                                                         |
| -------------------- | ---------------------- | ------------------------------------------------------------------------------------------- |
| `vite-plus`          | 1.5.0                  | `vp check` (Oxfmt, Oxlint, the type check on TypeScript 7), `vp test` (Vitest 5.1), `vp build` |
| `@effect/vitest`     | 4.1.3                  | `it.effect`, `layer(...)`, the test clock                                                   |
| `@effect/tsgo`       | 0.67.7                 | Effect's lint rules inside `vp check` (the `effecttsgo` Oxlint plugin and its `strict` preset) and the editor's language service. Its list of supported Oxlint and tsgolint versions includes Vite+ 1.5.0's |
| `typescript`         | 7.0.2                  | Its `tsc` compiles the server to JavaScript for a release package ([Releases](#releases)); `tsrs` is not needed |
| `playwright`         | 1.64.1                 | `tests/ui` and Vitest's browser mode                                                        |
| `electron-builder`   | ^26                    | Desktop packages                                                                            |

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
| `pnpm dev`          | The UI with hot reload against a server (`HUNTAWAY_SERVER`, default the test server last started) |
| `pnpm build`        | The UI, which the server serves                                                                  |
| `pnpm desktop`      | The Electron shell from the checkout                                                             |
| `cargo test`        | The shim's tests                                                                                 |
| `pnpm test:scripts` | The install scripts' tests, on fakes in a temp folder (`scripts/install*-test.sh`)               |

Formatting stays Oxfmt at 160 columns. Linting is Oxlint with type-aware rules plus `@effect/tsgo`'s strict preset,
with every rule at error and warnings failing the check: [12-conventions.md](12-conventions.md#linting) has the
configuration, which was run in [the spike](spike/lint/README.md). Markdown under `docs/` is wrapped at 120.

## CI

`.github/workflows/test.yml`, with the same shape as the old one because the same things make it fast: a `tree` job
that skips the rest when exactly these files have already passed, then `check`, `server`, `packages`, `web`,
`ui (1/3 to 3/3)`, `e2e` and `rust` in parallel, then `green` to record the pass. Self-hosted runners for
the owner's branches. `.github/workflows/release.yml` builds a release ([Releases](#releases)).

## Releases<a id="releases"></a>

As the old repository makes them (task 8.5), less the phone app. Publishing a GitHub release whose tag is its version
(`v1.2.3`, semver) runs `release.yml`; running it by hand with a tag builds that release again and replaces its files.
For Linux x64 and macOS arm64 it:

1. `scripts/package-server.sh release-server`: the server for the desktop app's resources and for hosts, a folder
   that runs on its own. `huntaway` (the launcher), `build.json` (`{ "version", "commit" }`, what the server reports),
   `ia-shim` (`cargo build --release`), `ui/` (`pnpm build`), `node/bin/node` (the Node the job runs on, copied as
   the old script did, never a version manager's shim), and `server/`: `src/` and `migrations/` compiled to `.js`
   without tests, `package.json`, and the production `node_modules` from `pnpm deploy --prod` (hoisted, copied so
   that nothing is a symbolic or hard link). `@huntaway/shared` and `@huntaway/contracts` ship TypeScript, which Node
   will not strip under `node_modules`, so they are compiled too and their `exports` point at the `.js`. What Node
   never loads is left out: `.ts`/`.d.ts` files and source maps under `node_modules`, `@types`.
   The compiler is TypeScript 7's own `tsc` (the workspace's `typescript`), with `rewriteRelativeImportExtensions`;
   it type-checks the server as it compiles it, so a type error fails the package. Beside the folder go
   `huntaway-server-<v>-<os>-<arch>.tar.gz`, one top folder of that name, and its `.sha256`; the script checks the
   tarball as installing a release does (one top folder, no absolute or `..` entries, only files and folders,
   `huntaway`, `ia-shim` and `ui/index.html` in it) and that `huntaway --version` says `huntaway <v>`.
2. `scripts/release-check.sh release-server <v>`: the package starts on 127.0.0.1 on a free port with a fresh data
   folder and no agents, `/api/health` reports the version and `build.json`'s commit, `/` serves the UI, and the
   approval hook answers through the packaged launcher; then it is stopped by its PID.
3. `pnpm --filter huntaway-desktop run dist`: the desktop packages, into `apps/desktop/release/`, whose resources'
   server is checked as the old workflow did.
4. The server tarball for hosts: `scripts/package-server.sh` again into `release/`, with `HUNTAWAY_SHELL_DIR` set
   to the built desktop shell, which adds `electron/` (its `*.cjs` and `shell.json` `{ electron, boot: 1 }`).
5. On Linux, `huntaway-<v>-release.json` `{ version, shell, electron }`, `shell` printed by apps/desktop's `stamp`
   script.

The `attach` job, the only one with `contents: write`, uploads every file to the release; GitHub's own sha256 digest
of each asset is what `Releases` and `scripts/install-release-host.sh` check. Nothing needs a secret.

To try a change to the packaging before a release ships it, run the first two steps in a checkout (`VERSION=x.y.z`
to stamp another version), and `pnpm test:scripts` for the install scripts. Measured on the reference machine (HE-6,
Node 26.8.1, ia-shim already built): the package took 8 s (the type-checking compile under 1 s); 173 MB unpacked,
of which `node/` 144 MB and `server/` 25 MB (`effect` most of it); the tarball 53 MB. The approval hook through the
packaged launcher: 36 ms with an empty compile cache, 23–30 ms after (from a checkout: 61, then 24–29).

**Installing.** `scripts/install-release-host.sh` installs a host from a release's tarball (checked against GitHub's
digest, unpacked into `~/.local/share/huntaway-effect-server/<v>/`, `current` pointed at it) and prints the
`install-service`, `serve` and SSH forced-command lines with `HUNTAWAY_RELEASE_UPDATES` set, on
`~/.local/share/huntaway-effect` and port 7879 unless told otherwise; it installs no service itself.
`scripts/install.sh` installs the desktop app from source into `~/.local/share/huntaway-effect-app`, with a launcher
`huntaway-effect-desktop` and a `huntaway-effect.desktop` entry ("Huntaway Effect.app" on macOS), so that it sits
beside the old app until the switch. Their tests run them on fakes (`curl`, `systemctl`, `loginctl` on PATH, a HOME
of their own) and never touch the machine.

**Pull request previews** are not in this repository, as they were not in the old one: the old previews were
deployed from a private repository (huntaway-deploy) that holds the hosts and domains, and are paused there. A
preview is a release package (or a checkout) started with `serve --demo --open-token`, so any browser that opens it
is signed in ([05-protocol.md](05-protocol.md)); bringing them back is a change in that repository, which builds from
`scripts/package-server.sh`.

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

The data folder is new: `~/.local/share/huntaway-effect`, with a default port of 7879, so the new server runs beside
the old board on one machine until the switch ([11-migration.md](11-migration.md#a-data-folder-of-its-own)).

The phone app is not part of this plan ([14-dropped-and-open.md](14-dropped-and-open.md#deferred)). `packages/client`
stays free of DOM, Node and React Native APIs so that one can be built on it later.

Everything else takes the product's name: the server's own environment variables become `HUNTAWAY_*` (`IA_PORT` is
`HUNTAWAY_PORT`), the test scripts' variables too, and the `issue-agent` command, `issue_agent` MCP server name and
`IA_*` server variables are not carried. [14-dropped-and-open.md](14-dropped-and-open.md) lists this with the
other things left behind.
