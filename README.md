# Huntaway

A kanban board for orchestrating Claude Code and Codex agents. Every task is an agent thread
(`claude -p`, or `codex app-server` for Codex) that moves through **To do → In progress → Needs attention → In review →
Ready for merge → Done**, usually in its own git worktree. Click a card to see the full thread, reply to the agent,
approve tool calls, and review, stage and commit its changes (lazygit-style).

- **Agents in worktrees.** Each task gets a branch and a worktree of its own, a temp folder and the board's tools over
  MCP. Agents run under a small supervisor (`ia-shim`), so they keep going while the server restarts or updates.
- **Review and merge.** A finished task is reviewed by other agents, summarized, and merged through a queue, one at a
  time. Pull requests, failed checks and preview deployments show on the card.
- **One board, many machines.** Every machine runs `huntaway serve` and keeps its own data; boards link to each other
  over SSH, the LAN or a broker, so one board shows them all.
- **Profiles.** Each Claude login (work, personal) has its own board, projects and settings, shown side by side.
- **Desktop and phone.** A desktop app (Linux, macOS) that updates itself from releases, and a phone app (Android,
  iOS) for your boards' prompts, threads and notifications.
- **A personal assistant**, routines and automations that start tasks on a schedule or from webhooks, Telegram, and
  Asana tasks.

## Install

- **Desktop app:** download the AppImage, the pacman package or the dmg from the
  [latest release](https://github.com/dire-kiwi/huntaway/releases/latest). It starts its own server and updates itself
  ([docs/desktop.md](docs/desktop.md)).
- **From source** (Linux, macOS; needs git and Node 24+, and Rust or a release's prebuilt `ia-shim`):

  ```sh
  curl -fsSL https://raw.githubusercontent.com/dire-kiwi/huntaway/master/scripts/install.sh | bash
  ```

- **A server on its own**, for another machine on your board: the server tarball from a release, with
  `huntaway serve --release-updates dire-kiwi/huntaway` (`scripts/install-release-host.sh` sets one up; see
  [docs/hosts.md](docs/hosts.md)).

## Run from a checkout

```sh
npm ci                                    # the workspace's dependencies, at the root (Node 24+)
cargo build --release -p ia-shim          # the Rust supervisor agents run under
npm run build                             # the UI, which the server serves
apps/server/bin/huntaway serve            # 0.0.0.0:7878: open the printed URL in any browser
apps/server/bin/huntaway token            # the access token
npm run electron -w huntaway-app          # …or the desktop app, which starts the server if none is running
```

[docs/development.md](docs/development.md) has the rest: hot reload, tests, the linter and the scripts.

## Repository layout

One npm workspace with [Vite+](https://viteplus.dev), and one Cargo workspace:

```
apps/server/      the server: TypeScript on Node 24+ (node:sqlite), run from its .ts files. API, events, agent runner,
                  worktrees, MCP, hosts and updates (see apps/server/README.md and docs/structure.md)
apps/web/         the board's UI (React, built with Vite+), and the Electron desktop app around it (electron/)
apps/mobile/      the phone app (Expo, React Native, Expo Router): your paired boards on Android and iOS
packages/client/  the board's API client, plain TypeScript, shared by the web and phone apps
crates/shim/      ia-shim (Rust): the per-run supervisor that keeps agents alive across restarts
crates/broker/    huntaway-broker (Rust): public connection setup for hosts, with managed tunnels or a relay
scripts/          test servers, ia-api, ui-check, and the install and packaging scripts
docs/             the guides below; structure.md (where code goes), threads.md, and dated notes in notes/
```

## Guides

| Guide | What's in it |
|---|---|
| [The board](docs/board.md) | profiles, projects, groups, favorites, starred tasks, labels (plans, artifacts, diagrams), scratch tasks |
| [Concepts](docs/concepts.md) | agent configs, tasks and their statuses, steering, reviews, worktrees, changes, checkpoints, terminals, permissions |
| [Running a server](docs/server.md) | `huntaway serve`'s options, restarts, the database file, rebuilding after a merge, network access, push |
| [Hosts](docs/hosts.md) | linking machines into one board, an assistant host, Telegram, reaching a host from anywhere |
| [The desktop app and releases](docs/desktop.md) | its config, installing it, release builds, and how it updates |
| [The mobile app](docs/mobile.md) | pairing a phone with your boards, and building the app |
| [The personal assistant](docs/assistant.md) | the assistant, its routines and its Google access |
| [Codex agents](docs/codex.md) | running tasks with Codex rather than Claude Code |
| [Agent tools (MCP)](docs/agent-tools.md) | the board's tools agents get, GitHub accounts, and how runs reach them |
| [GitHub, Asana and automations](docs/integrations.md) | pull requests, failed checks, preview URLs, Asana tasks, automations and webhooks |
| [Development](docs/development.md) | building, testing and linting the workspace |

## The old name

Huntaway used to be called Issue Agent. A machine that ran it under that name keeps its data where it was
(`~/.local/share/issue-agent`, `issue-agent.db`, `~/.config/issue-agent/desktop.json`), and there's still an
`issue-agent` command that starts `huntaway` beside it (`apps/server/bin/issue-agent`, in release packages too, and the
`issue-agent` binary of Rust releases), so hosts updating from an older build, SSH host commands and desktop configs
that name it keep working. Board tools from before the rename (`mcp__issue_agent__…`) still show as board tools in old
threads.

## License

MIT; see [LICENSE](LICENSE).
