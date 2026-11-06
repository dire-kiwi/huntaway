# Huntaway

A kanban board for orchestrating Claude Code and Codex agents. Every task is an agent thread (`claude -p`, or
`codex app-server` for Codex) that moves through **To do → In progress → Needs attention → In review → Ready for merge →
Done**, usually in its own git worktree. Click a card to see the full thread, reply to the agent, approve tool calls,
and review, stage and commit its changes.

- **Tasks are agents.** Starting a task starts its agent in a worktree of its own; it asks when it needs you (the
  card moves to *Needs attention*), opens a pull request when it's done, and merges when you move it to *Ready for
  merge*. Reviews, a merge queue, subprojects, plans and documents build on that.
- **Agents survive restarts.** Each run is supervised by `ia-shim`, so the server can restart (or update itself) under
  running agents.
- **One board, several machines.** Each machine runs `huntaway serve` and keeps its own data; boards link to each
  other directly, over SSH or through a broker, and show every host's projects together.
- **Profiles** keep separate Claude (or Codex) logins apart, each with its own projects, and a personal assistant with
  memory, routines, Google and Telegram.
- **Everywhere:** a desktop app (Linux, macOS), any browser, push notifications, and a mobile app (Android, iOS).

## Install

- **The desktop app:** download the AppImage, Arch package or dmg from the
  [latest release](https://github.com/dire-kiwi/huntaway/releases/latest). It updates itself from releases.
- **From source** (Linux, macOS), as a desktop app that updates from its checkout:

  ```sh
  curl -fsSL https://raw.githubusercontent.com/dire-kiwi/huntaway/master/scripts/install.sh | bash
  ```

- **A server on its own**, for a machine you reach from another board: `scripts/install-release-host.sh` installs a
  release's server tarball, which updates itself from releases (see *Release builds* and *Updating the desktop app* in
  [the desktop app and releases](docs/guide/desktop.md), and [Hosts](docs/guide/hosts.md)).

Agents need `claude` (Claude Code) or `codex` on the machine's `PATH`, and task terminals need `tmux`.
[The desktop app and releases](docs/guide/desktop.md) has the details.

## Run from a checkout

You need Node.js 24+, [pnpm](https://pnpm.io) (or `npx pnpm`) and Rust 1.89+ (for `ia-shim`, the supervisor agents run
under).

```sh
pnpm install                        # the whole workspace
pnpm build                          # the UI, which the server serves
cargo build --release -p ia-shim

apps/server/bin/huntaway serve      # 0.0.0.0:7878; open the URL it prints
apps/server/bin/huntaway token      # the access token
pnpm electron                       # …or the desktop app, which starts the server if it isn't running
```

The server runs on Node straight from its TypeScript sources, so there's nothing else to build.
[Running a server](docs/guide/server.md) lists its options.

## Repository

A pnpm workspace with [Vite+](https://viteplus.dev) (`vp`) as its toolchain: Vite builds the UI, Vitest runs the tests,
Oxlint and Oxfmt lint and format everything, and Vite+'s type check (TypeScript 7) covers every package.

```
apps/server/      the server, in TypeScript on Node 24+ (node:sqlite): API, live events, agent runner, worktrees,
                  MCP tools, hosts and the hub; bin/huntaway runs it (see apps/server/README.md)
apps/web/         the board's UI (React, Vite) and the desktop app's shell (Electron, in electron/)
apps/mobile/      the mobile app (Expo, React Native): your paired boards on Android and iOS
packages/client/  the board's API client, plain TypeScript, shared by the UI and the mobile app
rust/shim/        ia-shim: the small per-run supervisor that keeps agents alive across restarts
rust/broker/      huntaway-broker: public connections to hosts, with managed tunnels
scripts/          the install scripts, release packaging, and tools for testing (test servers, ia-api, ui-check)
docs/             the guide (docs/guide/), design notes, and dated research and reviews (docs/notes/)
```

| Command | What it does |
|---|---|
| `pnpm check` | format, lint and type checks over the workspace (`vp check`); `pnpm fix` formats and applies fixes |
| `pnpm typecheck` | type checks only |
| `pnpm test` | the server's and the UI's tests (`vp test`, Vitest) |
| `pnpm test:ui` | the browser checks: builds the UI and drives test servers in Chromium |
| `pnpm test:mobile` | the mobile app's tests (Jest) |
| `pnpm dev` | the UI with hot reload, against the server on `127.0.0.1:7878` (`IA_SERVER` changes it) |
| `cargo test` | ia-shim's and the broker's tests |

[Development](docs/development.md) covers the workspace, the tests and CI, and how to try changes on a test server.
[CLAUDE.md](CLAUDE.md) is the same for agents working on this repository.

## Documentation

- [Using the board](docs/guide/board.md): profiles, projects, groups and favorites, the sidebar, the board and its
  views.
- [Concepts](docs/guide/concepts.md): agent configs, threads, worktrees, reviews and merging, subprojects, plans and
  documents, permissions, status scripts, temp folders, the Changes tab, and the rest of what the board is made of.
- [Agents](docs/guide/agents.md): Codex agents, and the board's tools that agents get (MCP).
- [Pull requests and checks](docs/guide/github.md): pull requests, failed checks and preview URLs.
- [Asana and automations](docs/guide/integrations.md): Asana tasks, and automations (scheduled and triggered runs).
- [The personal assistant](docs/guide/assistant.md): its thread, memory, approval rules, Google, a machine of its
  own, and Telegram.
- [Running a server](docs/guide/server.md): server options, agents across restarts, the database file, restarting
  after a merge, and network access.
- [Hosts](docs/guide/hosts.md): one board across several machines, and reaching a host from anywhere.
- [The desktop app and releases](docs/guide/desktop.md): its config, installing it, release builds and updates.
- [Phones](docs/guide/mobile.md): push notifications, and the mobile app and its builds.

Design notes: [structure.md](docs/structure.md) (where code goes), [threads.md](docs/threads.md) and
[threads-api.md](docs/threads-api.md) (how threads are stored and served).

## Formerly Issue Agent

Huntaway used to be called Issue Agent. A machine that ran it under that name keeps its data where it was
(`~/.local/share/issue-agent`, `issue-agent.db`, `~/.config/issue-agent/desktop.json`), and there's still an
`issue-agent` command that starts `huntaway` beside it (`apps/server/bin/issue-agent`, in release packages too, and the
`issue-agent` binary of Rust releases), so hosts updating from an older build, SSH host commands and desktop configs
that name it keep working. Board tools from before the rename (`mcp__issue_agent__…`) still show as board tools in old
threads.

## License

MIT; see [LICENSE](LICENSE).
