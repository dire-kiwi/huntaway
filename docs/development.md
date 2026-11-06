# Development

The repository is one npm workspace with [Vite+](https://viteplus.dev) (the `vite-plus` package: Vite, Rolldown and
Oxlint behind one `vp` command) and one Cargo workspace. Everything runs from the root unless it says otherwise.

```sh
npm ci                                    # every package's dependencies (Node 24+); npm ci -w <name> for one
cargo build -p ia-shim                    # the Rust supervisor the server runs agents under (debug; --release for daily use)
npm run build                             # the UI (apps/web/dist), which the server serves
apps/server/bin/huntaway serve            # the server, on 0.0.0.0:7878
```

| Command | What it does |
|---|---|
| `npm run dev` | the UI with hot reload (`vp dev` in `apps/web`), proxying `/api` to `127.0.0.1:7878` (`IA_SERVER` changes it) |
| `npm run electron -w huntaway-app` | the desktop app from the checkout, which starts the server if none is running (`electron:dev` loads the dev server) |
| `npm run typecheck` | every package's typecheck (`vp run -r typecheck`): [tsrs](https://github.com/oxc-project/tsrs) for the server, UI and client, `tsc` for the phone app |
| `npm test` | every package's unit tests (`vp run -r test`): `node --test` for the server and UI, Jest for the phone app |
| `npm run lint` | Oxlint over the whole repository (`vp lint`, settings in `vite.config.ts`); CI runs it with `--deny-warnings` |
| `npm run test:ui -w huntaway-app` | the UI's browser checks (`apps/web/tests/ui`), which build the UI and start test servers |
| `cargo test` | ia-shim's and the broker's tests |

The packages are `@huntaway/server` (`apps/server`), `huntaway-app` (`apps/web`: Electron names the desktop app's
storage after it, so it keeps its old name), `@huntaway/mobile` (`apps/mobile`) and `@huntaway/client`
(`packages/client`). `npm run <script> -w <name>` runs one package's script from the root, or run it in the package's
folder. `vp run <name>#<script>` does the same through Vite+.

The code is formatted by hand (lines of up to about 160 characters): there's no formatter, and `vp check` is set not to
format (`vite.config.ts`). `CLAUDE.md` has the conventions agents follow, test servers and how to check UI changes.

## The server

The server runs on Node 24+ straight from its `.ts` files, so there's nothing to build for it but the workspace's
dependencies. It finds `ia-shim` in `target/release/` or `target/debug/` (the newer one), beside `bin/huntaway`, or at
`$IA_SHIM_BIN`. `apps/server/README.md` has more, and `scripts/test-server.sh` starts a scratch server on a free port for
trying a build.

## The UI

Run the UI's unit tests with `npm test` in `apps/web`, and its browser regression tests (which build the UI and start
test servers, so run `npm ci` and `cargo build -p ia-shim` first, and have Chromium at `/usr/bin/chromium`) with
`npm run test:ui` (Node.js 24+), which runs 8 files at a time (`IA_UI_TEST_JOBS=<n>` changes that).

## Faster Rust builds

Install [sccache](https://github.com/mozilla/sccache) (`cargo install sccache --locked`, or your package manager's) and
the crates build through it (`.cargo/config.toml`), so each task worktree reuses the dependencies another one already
compiled rather than building them again. Without sccache, or where it can't start its server (a sandbox with no
network), cargo runs rustc directly. The server is started with `$XDG_RUNTIME_DIR` (or `/tmp`) as its `TMPDIR` rather
than the build's, which may be a task's temp folder that goes when the task is done. `RUSTC_WRAPPER= cargo …` or
`SCCACHE_DISABLE=1` turns it off; `sccache -s` shows the hit rate. Debug builds also leave dependencies' debuginfo out,
which keeps each worktree's `target/` smaller. `cargo test` runs each test binary with a `TMPDIR` of its own on disk,
`/var/tmp/ia-cargo-test-*` (or `$IA_CARGO_TEST_TMPDIR`), removed when it exits (`.cargo/test-runner`), rather than in
`/tmp`, which is often a tmpfs in memory that tests' databases and repositories fill up.

## Scripts

| Script | What it's for |
|---|---|
| `scripts/test-server.sh` | a scratch server on a free port for testing a worktree's build |
| `scripts/ia-api` | calls to a test server's API (polling, approving prompts); its tests are `scripts/ia-api-test.py` |
| `scripts/fake-claude` | a stub `claude` for test servers (`test-server.sh --fake-claude`) |
| `scripts/ui-check.mjs` | drives a test server's board in Chromium, for screenshots and checks |
| `scripts/ui-profile.mjs` | the UI's main-thread time on loads and live events, to compare builds |
| `scripts/copy-live-board.sh` | a scrubbed copy of the live board's database for a test server |
| `scripts/event-loop-probe.mjs` | how long the server's heavy reads hold up its one thread |
| `scripts/clean-worktree.sh` | removes a done task's worktree build output |
| `scripts/install.sh` | installs the desktop app from source (Linux, macOS) |
| `scripts/install-release-host.sh` | installs a host from a release's server tarball |
| `scripts/package-server.sh` | puts a release's server together (the release workflow runs it) |
| `scripts/release-update-e2e.sh` | builds releases of the checkout and runs the desktop app through updating between them |
