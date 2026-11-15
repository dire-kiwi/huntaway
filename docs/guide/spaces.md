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

## Settings

| Variable                | What it does                                                         |
| ----------------------- | -------------------------------------------------------------------- |
| `HUNTAWAY_DOCKER`       | The Docker CLI to run (default `docker` on PATH)                     |
| `HUNTAWAY_SPACES_IMAGE` | The image Spaces are built on (default `ghcr.io/trycua/linux:24.04`) |

spacesd and its viewer are Cua's, under the FSL-1.1-MIT licence (source-available; MIT two years after each release).
Huntaway runs them from Cua's published image and doesn't ship them.
