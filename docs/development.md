# Development

The repository is a [pnpm](https://pnpm.io) workspace (`pnpm-workspace.yaml`: `apps/*` and `packages/*`, one
`pnpm-lock.yaml`) with [Vite+](https://viteplus.dev) as its toolchain, and a Cargo workspace (the root's `Cargo.toml`)
for the Rust in `rust/`. [structure.md](structure.md) says where code goes inside each package.

| Package           | Name               | What it is                                                                       |
| ----------------- | ------------------ | -------------------------------------------------------------------------------- |
| `apps/server`     | `huntaway-server`  | the server, TypeScript run by Node 24+ from its sources (`bin/huntaway`)         |
| `apps/web`        | `huntaway-app`     | the UI (React, built by Vite) and the desktop app's Electron shell (`electron/`) |
| `apps/mobile`     | `huntaway-mobile`  | the mobile app (Expo, React Native)                                              |
| `packages/client` | `@huntaway/client` | the API client, linked into the UI and the mobile app with `workspace:*`         |
| `rust/shim`       | `ia-shim`          | the per-run supervisor agents run under                                          |
| `rust/broker`     | `huntaway-broker`  | the connection broker for hosts                                                  |

The web package keeps the name `huntaway-app`: Electron names the desktop app's storage and window after it when it runs
from a checkout.

## Setting up

```sh
pnpm install                        # Node 24+; pnpm is pinned in package.json (packageManager)
pnpm build                          # the UI (apps/web/dist), which the server serves
cargo build -p ia-shim              # debug is fine for development; the server takes the newer of target/{release,debug}
```

`pnpm install` again whenever `pnpm-lock.yaml` changes. Dependencies' install scripts only run when
`pnpm-workspace.yaml` allows them (`allowBuilds`); Electron downloads its binary the first time it starts.
Vite+ is the `vite-plus` package, at one version for every package (the catalog in `pnpm-workspace.yaml`), with the
Vite and Vitest it bundles standing in for any other copy (`overrides`). Inside package scripts `vp` is on the PATH;
elsewhere run it as `pnpm exec vp`, or install [the global `vp`](https://viteplus.dev/guide/).

## Checks and tests

| Command (at the top) | What it runs                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `pnpm check`         | `vp check`: Oxfmt, Oxlint and the type check (tsgolint, TypeScript 7) over every package, with each file's tsconfig.json |
| `pnpm fix`           | `vp check --fix`: formats, and applies lint fixes                                                                        |
| `pnpm typecheck`     | the type check alone (`vp check --no-fmt --no-lint`); `pnpm typecheck` in a package checks only its files                |
| `pnpm test`          | `vp test`: the server's and the UI's unit tests (Vitest; the root's vite.config.ts lists them as projects)               |
| `pnpm test:ui`       | the browser checks in `apps/web/tests/ui` (see below)                                                                    |
| `pnpm test:mobile`   | the mobile app's Jest tests (`pnpm typecheck` in `apps/mobile` is its `tsc`, with the TypeScript Expo uses)              |
| `cargo test`         | ia-shim's and the broker's tests                                                                                         |

The format and lint settings are in the root's `vite.config.ts` (lines of up to 160 characters; test fixtures aren't
formatted). Oxlint's warnings don't fail a check; its errors and type errors do.

One test file: `pnpm test src/agent/runs.test.ts` in `apps/server` (Vitest takes a file's path, or part of it, and
`-t <pattern>` for a test's name). The server's tests each run in a process of their own (Vitest's `forks` pool), with
a 60 s timeout. Give a test a folder with `testing.temp_dir()` (`apps/server/src/testing.ts`), which is removed when the
file's tests end (`IA_KEEP_TEST_DIRS=1` keeps it), and an `AppState` on an in-memory database with `testing.state()`.
Server code that needs to know it's in a test reads `IN_TEST` (`apps/server/src/util.ts`).

### Browser checks

`pnpm test:ui` builds the UI, then runs each file in `apps/web/tests/ui` against a test server of its own (with agents
switched off) in Chromium (`/usr/bin/chromium`, `$CHROMIUM`, or Playwright's: `pnpm exec playwright-core install
--no-shell chromium` in `apps/web`). It needs ia-shim built. Eight files run at a time (`IA_UI_TEST_JOBS` changes that),
and `pnpm test:ui --shard=2/3` runs a third of them, as CI does. One file, against the UI you last built:
`pnpm exec vp test --config tests/ui/vitest.config.ts <file>` in `apps/web`.

### CI

`.github/workflows/test.yml` runs on every pull request and on pushes to `master`: `check` (`vp check`), `server`,
`web`, `mobile`, `ui (1/3)` to `(3/3)` and `rust`. It sets up Node, pnpm and Vite+ with `voidzero-dev/setup-vp`. The
owner's own pull requests can use self-hosted runners for the `rust` and `ui` jobs (see the workflow's header).
`.github/workflows/release.yml` builds the desktop app, the server tarball and the Android APK when a release is
published.

## Trying changes

- `pnpm dev` serves the UI with hot reload at `localhost:5173`, with `/api` proxied to `127.0.0.1:7878`, or to
  `$IA_SERVER`. `pnpm --filter huntaway-app electron:dev` loads it in Electron.
- `scripts/test-server.sh --seed` starts a scratch server from this checkout on a free port with a fresh data dir (and
  `--demo`, `--fake-claude`, `--no-agents`); `scripts/test-server.sh stop` stops it. `scripts/ia-api` calls its API, and
  `scripts/ui-check.mjs` drives its board in Chromium for screenshots and checks. CLAUDE.md describes them in full.
- `scripts/release-update-e2e.sh` builds real release packages of this checkout and runs the desktop app through
  release updates against a fake GitHub (see [the desktop app and releases](guide/desktop.md)).

## Rust builds

Install [sccache](https://github.com/mozilla/sccache) (`cargo install sccache --locked`, or your package manager's) and
cargo builds through it (`.cargo/config.toml`), so each task worktree reuses the dependencies another one already
compiled. Without sccache, or where it can't start its server (a sandbox with no network), cargo runs rustc directly.
`RUSTC_WRAPPER= cargo …` or `SCCACHE_DISABLE=1` turns it off; `sccache -s` shows the hit rate. Debug builds leave
dependencies' debuginfo out, which keeps each worktree's `target/` smaller. `cargo test` runs each test binary with a
`TMPDIR` of its own on disk, `/var/tmp/ia-cargo-test-*` (or `$IA_CARGO_TEST_TMPDIR`), removed when it exits
(`.cargo/test-runner`), rather than in `/tmp`, which is often a tmpfs that tests' databases and repositories fill up.

## Releases and updates from a checkout

A checkout updates itself with **Rebuild & restart** (see _Restarting after a merge_ in
[Running a server](guide/server.md)): `pnpm install --frozen-lockfile` for the server and the UI, the UI's build and
`cargo build --release -p ia-shim`, then the server restarts under its running agents. `scripts/package-server.sh`
packages the server for releases: the server compiled to `.js` by tsrs, its production dependencies (from
`pnpm deploy`), Node, ia-shim and the UI. Inside a package the server keeps its old folder name, `server-ts/`, which
installed releases look for.
