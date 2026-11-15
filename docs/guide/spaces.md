# Spaces

A Space is a Linux desktop in a Docker container on one of your hosts, which you watch and use from the board. It has
[Cua Driver](https://github.com/trycua/cua) for driving its apps, and Claude Code and Codex installed and signed in with
the agent configs you choose. It is Huntaway's version of [Cua Spaces](https://cua.ai/docs/spaces), and runs on Cua's
own daemon, **spacesd**, which streams the desktop as H.264 video.

## Making one

On a host's page (Settings → Hosts → the host), **Spaces** → **New Space**:

- **Name**: what the board shows.
- **Claude Code signed in as** and **Codex signed in as**: the host's agent configs whose sign-ins, settings and
  `CLAUDE.md` go into the Space's home. Leave either as _Not signed in_.
- **Direct link**: the Space's spacesd port is open on the host's network, not only to the host itself, so a browser on
  the same network can reach it without going through the board's server.

The host needs Docker. The first Space pulls Cua's image (`ghcr.io/trycua/linux:24.04`, about 1.4 GB to download and
5 GB on disk) and builds Huntaway's on it, with Claude Code and Codex added. That takes a few minutes, and the row says
what it's doing. Later Spaces start in seconds.

## Using it

**Open** shows the Space's desktop in a dialog, through the host's own server: it works wherever the board does, with
nothing else to open on the network. You use it as you would any desktop: click, type, open the terminal in its dock
and run `claude` or `codex`. The viewer's toolbar (at the top of the desktop) has full screen, scaling, keys the browser
would take (Ctrl+Alt+Del, say), the clipboard, uploads to `~/Downloads`, and stats.

- **New window** opens the same view in a tab of its own.
- **Direct** (a Space made with a direct link) opens it straight from the container, without the board's server in
  between.

The video is decoded by the browser (WebCodecs), which browsers only allow over `https` or on `localhost`. A board
opened over plain `http` on another machine falls back to still frames: put the board behind https (a reverse proxy, or
Tailscale's certificates) for full speed.

## Sign-ins

Sign-ins are copied in **without their refresh tokens**: Anthropic and OpenAI replace a refresh token each time it is
used, so a Space that refreshed one would sign the host out. A Space's Claude Code and Codex use the access token they
were given until it expires (hours), then ask to sign in again. **Sign-ins** on its row copies a fresh one in; starting
a stopped Space does too. Hooks and status lines in the config's `settings.json` are left out (they run the host's
programs), and a proxy the config uses on the host's `localhost` is reached as `host.docker.internal`.

## Stopping and deleting

**Stop** stops the container; its files stay, and **Start** brings it back. **Delete** removes the container and
everything in it. Spaces are Docker containers named `huntaway-space-<id>`, so `docker ps` shows them too, and one
removed with `docker rm` is gone from the board.

## Agents and Spaces

A task's agent can make and use Spaces too, as Cua Spaces' own agent tools do. On the host's page, under **Spaces**,
turn on **Let agents on this host make and use Spaces**: from their next run, agents on the host get a `spaces` MCP
server (while Docker is there), and their system prompt says so. It's off by default.

| Tool                                    | What it does                                                                                       |
| --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `list_spaces`                           | The host's Spaces                                                                                  |
| `create_space {name, reuse?}`           | Makes a Space and waits until it's running; with `reuse` (the default) uses one of that name       |
| `start_space`, `stop_space`             | Starts or stops one                                                                                |
| `delete_space`                          | Deletes one, and always asks you first                                                             |
| `space_bash {space, command, timeout?}` | Runs a command in it as its desktop user (at most 10 minutes; the end of long output)              |
| `space_list_tools {space, tool?}`       | Its Cua Driver's tools, or one tool's arguments                                                    |
| `space_call_tool {space, tool, args?}`  | Calls one: `get_desktop_state` for a screenshot, `get_window_state`, `run_steps` to click and type |
| `space_view {space}`                    | A link for you to watch it, good for an hour                                                       |

A Space is named by its id or its name. Spaces an agent makes have no sign-ins; one you made from the host's page with
sign-ins can be reused by its name. Reviewers and threads in plan mode can only look: list Spaces,
take screenshots and read windows, not run commands, click or make Spaces. The tools that change something ask as any
tool does, by the thread's mode and your approval rules.

## Settings

| Variable                | What it does                                                         |
| ----------------------- | -------------------------------------------------------------------- |
| `HUNTAWAY_DOCKER`       | The Docker CLI to run (default `docker` on PATH)                     |
| `HUNTAWAY_SPACES_IMAGE` | The image Spaces are built on (default `ghcr.io/trycua/linux:24.04`) |

spacesd and its viewer are Cua's, under the FSL-1.1-MIT licence (source-available; MIT two years after each release).
Huntaway runs them from Cua's published image and doesn't ship them.
