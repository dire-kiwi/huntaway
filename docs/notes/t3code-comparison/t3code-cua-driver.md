# T3 Code and Cua Driver

How [T3 Code](https://github.com/pingdotgg/t3code) uses (or is going to use) [Cua Driver](https://cua.ai/docs/cua-driver), and what
that would mean for Huntaway (task HA-273). Read from T3 Code's `main` at `202d5b5` (2026-11-06), the branches of its open pull
requests, and `trycua/cua`'s `libs/cua-driver` on the same day. Nothing was built or run.

## In short

- **Not shipped yet.** T3 Code's `main` has no Cua Driver code. It's a stack of six draft pull requests by Julius Marminge,
  plus one fix-up PR, all still open: #16527 → #16528 → #16529 → #16530 → #16531 → #16532, then #16975. They pin **Cua Driver
  0.38.0** and its TypeScript SDK `@trycua/cua-driver` 0.38.0. The setting is off by default.
- **What it does:** every agent session, whatever the provider, gets a stdio MCP server named `cua-driver`. Through it the agent
  sees and uses native apps on the computer that runs the T3 environment, in the background (it doesn't take the cursor or
  focus). The server is also an SDK client of the same driver, which it uses to stream a live preview of the window the agent
  is driving and to list installed apps for `@app` mentions.
- **"Computer use" on `main` is a different thing.** `COMPUTER_USE_TOOL_SOURCE` and the `computer-use` rows in `main`
  (`packages/shared/src/toolActivity.ts`, `apps/server/src/provider/CodexToolPresentation.ts`) present **Codex's own bundled
  Computer Use plugin** (OpenAI's). Merged PRs #13307 and #18865 ("fix(cua): show call titles…") are about that plugin, not
  trycua's driver. The Cua stack reuses that presentation for Cua's calls.
- **For Huntaway:** Huntaway can already give agents Cua Driver with no code changes: add `cua-driver mcp` as a global or
  project MCP server (Settings → Skills and MCP servers). It works the same for Claude and Codex runs. What T3 Code adds on top
  is a managed install, a setup flow for the OS's permissions, readable tool rows with app icons, and the live window preview.
  See [What Huntaway could take](#what-huntaway-could-take).

## History

| PR                                                                                                                 | By             | When          | State                                  | What                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------ | -------------- | ------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [#4354](https://github.com/pingdotgg/t3code/pull/4354)                                                             | injaneity      | 2026-07-23    | closed                                 | First "opt-in cua-driver computer use"                                                                                                                                                                                                                             |
| [#5533](https://github.com/pingdotgg/t3code/pull/5533)                                                             | f-trycua (Cua) | 2026-08-06    | closed                                 | Cua's own PR: bundled driver, Codex only                                                                                                                                                                                                                           |
| [#10899](https://github.com/pingdotgg/t3code/pull/10899)                                                           | f-trycua (Cua) | 2026-09-09    | closed (stale)                         | #5533 redone on newer `main`: driver 0.24.0, desktop hosts it, Codex only, live preview card. Closed in a stale-PR sweep (conflicts in 28 files)                                                                                                                   |
| [#11709](https://github.com/pingdotgg/t3code/pull/11709)                                                           | juliusmarminge | 2026-09-14    | closed                                 | Temporary test PR of #10899 with Effect-convention fixes                                                                                                                                                                                                           |
| [#14523](https://github.com/pingdotgg/t3code/pull/14523), [#15006](https://github.com/pingdotgg/t3code/pull/15006) | t3dotgg        | 2026-10-01/03 | closed (superseded)                    | macOS only. User installs Cua Driver (0.31.0) with Cua's installer; attached to Claude, Cursor, ACP and OpenCode 1.x (not Codex, OpenCode 2 or Pi); a per-thread proxy that ended Cua's session at every turn end; plus "Agent browser tabs" (Chrome DevTools MCP) |
| [#16527–#16532](https://github.com/pingdotgg/t3code/pull/16527)                                                    | juliusmarminge | 2026-10-06    | **open, drafts** (16530 isn't a draft) | The current stack: macOS, Linux and Windows; every provider. Supersedes #10899 and #15006                                                                                                                                                                          |
| [#21694–#21697](https://github.com/pingdotgg/t3code/pull/21694)                                                    | juliusmarminge | 2026-10-19    | closed                                 | A rebuild of #16527 as four smaller layers (driver 0.34.1). Closed on 2026-10-28 in favour of #16527, reopened and rebased with driver 0.38.0                                                                                                                      |
| [#16975](https://github.com/pingdotgg/t3code/pull/16975)                                                           | juliusmarminge | 2026-10-07    | **open, draft**                        | On top of the stack: steadier window previews (Linux and Windows), Windows app names and icons, `@app` mentions in the composer                                                                                                                                    |
| [#28050](https://github.com/pingdotgg/t3code/pull/28050)                                                           | t3dotgg        | 2026-10-31    | **open, draft**                        | A rival path: `agentcast`, Theo's private MCP server for remote desktops over SSH, built on the same Cua 0.38 engine (see [agentcast](#agentcast))                                                                                                                 |

Cua's people are involved: `f-trycua` (Francesco Bonacci) is in T3 Code's `.github/VOUCHED.td`, and the stack says it was
"ported from #10899 by Francesco Bonacci". Upstream fixes found by the stack went into Cua: Linux window capture and
`get_window_state`'s `display_only` (trycua/cua#4895, in 0.34.1), and a Windows console window (trycua/cua#5136, in 0.35.4).

The stack was last pushed on 2026-11-05. Its PR descriptions list what hasn't been checked by hand: 0.38.0 on macOS (only 0.34
was checked), installed 0.38.0 builds on GNOME and Windows, Windows icons, the preview in a running client (#16531), and a
real browser connection for browser tabs (#16532). Windows test builds (9007, 9009) were tried interactively.

## How it works (the stack)

### 1. Hosting the driver (#16527)

Cua Driver is a Rust daemon (`cua-driver-rs`) with a UniFFI SDK. T3 Code doesn't run `cua-driver mcp` by itself: it starts
the daemon through the SDK's `EmbeddedCuaDriverHost`, which returns an **MCP descriptor** (a command, its arguments and
environment, which proxy MCP over stdio to the daemon) and the daemon's **socket path**.

- **Desktop app (Electron):** bundles the driver for every target (one universal macOS executable, per-arch Linux and Windows
  archives) and starts it inside the Electron process, so macOS grants Accessibility and Screen Recording to T3 Code itself
  rather than to a second app. The Electron main process hands the descriptor to its backend over the existing private control
  pipe (`apps/desktop/src/cua/DesktopCuaDriver.ts`, `makeDesktopHostFactory` in `apps/server/src/cua/CuaDriver.ts`).
- **Standalone server (`npx t3`):** downloads the same release from GitHub into T3's home on first use, checking size and
  SHA-256 and refusing unsafe archive entries (`apps/server/src/cua/CuaDriverInstallation.ts`). `T3CODE_CUA_DRIVER_PATH`
  points at your own build instead.
- One table, `packages/shared/src/cuaDriverRelease.ts`, holds each archive's name, size and SHA-256 (darwin-universal,
  linux-x64/arm64, win32-x64/arm64), so the desktop build script and the server can't disagree.
- Host options (`packages/shared/src/cuaDriverHostOptions.ts`): no capability manifest, no approval bypass
  (`dangerouslyBypassApprovals: false`), overlay cursor on, and on Linux with `WAYLAND_DISPLAY` set,
  `CUA_DRIVER_RS_ENABLE_WAYLAND=1`. That's Cua's `standard` permission mode, which is promptless.
- One driver per environment, started lazily the first time a session wants it, with a 30 s start and 5 s stop timeout. Turning
  the setting (`enableCua`) off stops it at once; existing sessions keep their tools until restarted.
- To load the SDK's native library from inside the Electron archive, they patch `@ubjs/node` (the SDK's loader) so `dlopen`
  looks in `.asar.unpacked`.

### 2. Attaching it to agents (#16528)

`ProviderSessionManager` calls `CuaDriver.acquire` when it prepares each thread's MCP session, and records the descriptor on it.
Each adapter then passes it to its harness as a stdio MCP server called `cua-driver`:

| Provider                      | How                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------ |
| Claude (Agent SDK)            | `mcpServers` (`localStdioMcpServers`); the query reopens when the set changes                    |
| Codex (`app-server`)          | the thread's `mcp_servers`, unless the user's own Codex config already has a `cua-driver` server |
| Cursor                        | SDK `mcpServers`                                                                                 |
| Grok, Antigravity, Devin, ACP | ACP `mcpServers`                                                                                 |
| OpenCode 1.x / 2              | `mcp.add` / a per-thread, per-directory registration with permission rules                       |
| Pi                            | no MCP client, so T3's Pi extension bridges the stdio server and passes screenshots on as images |

Sessions that have it get a `<computer_use>` block in their system prompt (`COMPUTER_USE_INSTRUCTIONS` in
`packages/provider-core/src/server/runtimeInstructions.ts`). In summary: use the GUI only when shell or other tools can't do
the job; keep the default `delivery_mode: "background"` and use `"foreground"` only after a background action didn't land;
don't `bring_to_front` just to look (`get_window_state` captures without raising); target windows by pid and window id; and
leave the desktop as it was found (close your windows, not the user's, and re-activate the window that was in front).

#15006's per-thread proxy, which ended Cua's session at every turn end, was dropped: Stop ends the provider's turn, and Cua's
idle timeout hides the agent cursor.

### 3. Showing the calls (#16529)

Raw `mcp__cua-driver__click` rows become Codex-style computer-use rows: "Clicked in Safari", with the app's icon
(`packages/provider-core/src/server/cuaToolPresentation.ts`, about 570 lines). A finished call teaches the thread which app owns
each pid, so later calls that name only a pid or window still name the app. A test pins the title table to every tool Cua
0.38 has. App icons are looked up per OS: Spotlight and `sips` on macOS, `.desktop` entries and the hicolor theme on Linux,
the executable's icon through PowerShell on Windows.

### 4. Setup (#16530)

Settings → Devices → Computer → **Computer use**, per environment (host). On macOS the setup asks for Accessibility and Screen
Recording, which someone at that Mac has to grant. On Windows someone must be signed in to the desktop. On Linux there must be
a signed-in graphical session, and on Wayland someone may have to approve a screen-capture prompt. The status refreshes while
Settings is open (starting, running, failed). Mobile has a toggle too. The user doc is `docs/user/computer-use.md` on the
stack's branch.

### 5. Live preview (#16531, #16975)

While a turn with Cua runs, the web and desktop clients float the window the agent last targeted over the chat. The server
connects its own SDK client to the daemon's socket (`CuaDriver.connect(socketPath)`) and calls `get_window_state` for frames,
streamed over a `subscribeCuaWindowPreview` RPC (`apps/server/src/cua/CuaWindowPreview.ts`). It only captures while a client
watches and a Cua turn is in flight: up to 4 frames a second, dropping to 1 when the window doesn't change, and with
`display_only` where the driver supports it. The composer shows **Using your computer** with a Stop button. #16975 also uses
the SDK's `listApps` for `@app` mentions in the composer.

### 6. Browser tabs (#16532)

Separate from Cua: **Agent browser tabs** attaches Chrome DevTools MCP (pinned 1.10.1) to the user's own Chromium-family
browser (Chrome, Edge, Brave, Helium, Chromium), with its tabs and sign-ins, beside `cua-driver`. The user turns on remote
debugging in the browser, and the browser asks before each connection.

## agentcast

Theo's draft #28050 attaches `agentcast`, an MCP server in a private repository (`t3dotgg/agentcast`), to Claude and Codex
sessions when `T3CODE_AGENTCAST_MAIN` is set. agentcast drives another PC's desktop over SSH, refuses on a locked PC or a UAC
prompt, and journals actions so a lost reply doesn't run twice. Its read-only tools are pre-approved; `act`, `launch`,
`clipboard`, `files` and `exec` go through the provider's approval unless the thread has full access. The PR reports that, with
the same Cua 0.38 engine underneath, agentcast took 17–43% fewer calls and 26–54% less time than `cua-driver mcp`, and says
#16528 could later attach `agentcast mcp` in place of `cua-driver mcp`. So T3 Code may end up keeping Cua as the engine but
not its MCP server.

## Cua Driver itself

- MIT, from [trycua/cua](https://github.com/trycua/cua) (`libs/cua-driver`). An optional perception extension is AGPL.
- `cua-driver mcp` is the agent interface (MCP over stdio); `cua-driver call` is for shell use; the Python and TypeScript SDKs
  are for applications, not agents.
- Permission modes are fixed when the daemon starts: `standard` (promptless, the default), `bounded` (only a reviewed
  manifest's tools) and `unrestricted` (`--dangerously-bypass-approvals`). Attaching to a signed-in Chromium profile needs
  `--grant existing-profile`.
- Linux: X11 and Wayland through AT-SPI, with CI on X11, Sway and nested niri, and a desktop suite for GNOME and KDE logins. **Hyprland** (this machine's compositor,
  Omarchy) is handled, but background input there needs an experimental plugin built for the exact Hyprland version, which is
  off by default. Without it, background input there is refused, and an agent has to ask for foreground delivery, which moves
  focus and the cursor (Cua never falls back to it on its own).

## What Huntaway could take

> **Since done (HA-273's second part):** Huntaway now has computer use. The host's page installs Cua Driver, one
> `cua-driver mcp` per host is run by the server, and runs get our own `desktop` MCP server (agentcast's shape, with a
> lock gate, one task at a time and a journal), with a viewer in the task panel. See _Computer use_ in
> [docs/guide/agents.md](../../guide/agents.md). What's below is the analysis from before.

1. **Today, with no code:** install Cua Driver on the host and add a global MCP server
   `{"type": "stdio", "command": "cua-driver", "args": ["mcp"]}` (Settings → Skills and MCP servers), switched on for the
   projects that want it. Claude and Codex runs both get it. Not tried here. Things to check if we do:
   - Huntaway's agents run detached under `ia-shim`, started by the daemon. The daemon has to be started from the graphical
     session, with `DISPLAY` or `WAYLAND_DISPLAY` and the session bus in its environment, or the driver can't see the desktop.
     A daemon started as a systemd service may not have them.
   - Tasks run in parallel, and each run would start its own `cua-driver mcp` (whether they share one daemon wasn't checked).
     Several agents driving one desktop at once would fight over it. T3 Code has one daemon per environment, and I didn't see
     anything in its stack that keeps two agents off the desktop at once either.
   - Cua's `standard` mode doesn't ask before acting. Huntaway's permission prompts would still cover the MCP tools unless the
     server is set to auto-allow, which it shouldn't be.
2. **Cheap additions if it's used:** a `<computer_use>` paragraph like T3 Code's in the run's prompt when the server is
   attached (background delivery, leave the desktop as found), and nicer thread rows for `mcp__cua-driver__*` calls (app name
   and an action title, instead of the raw tool name).
3. **What's most of T3 Code's work, and less useful to us:** the managed download, macOS permission setup, the Electron-hosted
   driver and the live window preview. Huntaway's agents mostly work in worktrees on a server, often with nobody at the
   screen, so for Huntaway a sandboxed desktop (Cua's VMs, or a nested compositor like the Sway session Cua's CI uses) would
   probably suit better than the user's own. That's a separate, bigger question.

Worth checking again once the stack merges: what T3 Code ships (the driver version, whether `agentcast` replaces
`cua-driver mcp`), and whether Hyprland background input leaves the experimental plugin.
