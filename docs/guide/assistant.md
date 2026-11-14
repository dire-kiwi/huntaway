# The personal assistant

The assistant is a profile's personal mode, apart from its projects. This section covers its thread, memory, approval
rules and Google. The rest is elsewhere: its routines and the morning brief under _Automations_, running it on a
machine of its own under _An assistant host_, and push for its replies, reports and prompts under _Push notifications
on a phone_. Telegram, and the phone app's Assistant tab, are not in the new server.

Each profile has an **assistant**: one long-lived conversation outside every project,
opened with **Assistant** in the sidebar (above _Projects_), full width at `/assistant/<profile>`.
It's made the first time it's opened (the RPC `assistant.get`; `assistant.send` sends it a message) and can't be
deleted (it goes with its profile; `tasks.delete` and the `delete_task` tool refuse it), keyed `A-<n>` (no project can
use the key `A`), and its agent works in `<data dir>/assistants/<task id>`, which it can write without
asking and which lasts between conversations. It's told it's a personal assistant rather than a
coding agent: it has the global skills and MCP servers its profile switches on (its skills are written
to `<data dir>/profiles/<profile id>/agent`), on Claude Code and Codex alike, and the board tools, and
hands code work to project tasks with `create_task`. Your messages go to it as they are, with no
"start working on this task" around the first. It never goes to review or
merge: after each reply it's back in _To do_, and it can't be moved to _In review_, _Ready for
merge_, _Done_ or _Backlog_. It's off the boards, and out of `list_tasks` and the profile's task
lists unless they're asked for it (`include_assistant`). Other profiles' agents can't reach it,
whatever access their profile has.

Which agent it runs on is the profile's **Assistant agent** (Settings → Profiles): one of
the profile's agent configs, Claude Code or Codex, or its default. Its routines start on it too. A
conversation keeps the config it started with, so after changing it, send `/new` to start a new
conversation on the new one (the thread and its memory files stay).

The assistant **remembers** you in files in its workspace: `USER.md` (who you are, your
preferences), `MEMORY.md` (lasting facts) and a log for each day, `memory/YYYY-MM-DD.md` (in the
host's time zone). The board, not the CLI, puts them into the instructions of every run, so it's the
same on Claude Code and Codex and always what the files say now: `USER.md` and `MEMORY.md` up to
8,000 characters (and 16 KB) each (with a note to the assistant when one is cut), today's and
yesterday's logs (their ends, if longer), and how to remember, forget and keep the log. Claude Code
is given these instructions in a file (`--append-system-prompt-file`, in the run's folder) rather
than as an argument, which can't be longer than 128 KiB. The workspace has a git history: after each
of the assistant's turns that changed it, the board commits it as _Assistant_. Its git folder is
`<data dir>/assistants/<task id>.git`, next to the workspace rather than in it, so the assistant
can't set the config, hooks or filters the board's git runs with. A workspace that still has its own `.git` inside it
(one the old board never opened after its history moved out) keeps it: the board leaves it alone and starts a new
history beside it. The board's git also ignores your own git config. What the
workspace's `.gitignore` lists (made with common downloads, build output and secrets) and files over
1 MB aren't committed, nor is a repository in the workspace (a `git clone`, say): it's never a
gitlink in the history, as git would look in it with its own config, which the assistant can write.
The assistant's **Memory** tab lists the files (those loaded into every run highlighted, with their
length against the cap), edits them (committed as _You_; a save over what the assistant wrote
meanwhile asks whose to keep), shows each file's history with what each commit changed, and restores
a version. A restore or a save over the assistant's edit first commits that edit, as the
assistant's, if it isn't yet, so it's always in the history; a file the history leaves out is only
written over (even when forced) if it's what the editor opened. Its **Import** gives a prompt to
paste into another assistant (ChatGPT, Claude.ai…) for what it knows about you, and sends its answer
to your assistant, as data, to fold into `USER.md` and `MEMORY.md`. The RPC methods are `assistant.memory`,
`memoryFile`, `writeMemoryFile`, `memoryHistory`, `memoryDiff`, `restoreMemory` and `importMemory`, and only reach
files in that profile's assistant's workspace: paths with `..`, in `.git` or through a symlink are refused, and so
is a workspace (or `assistants` folder) that's been replaced by a symlink, whose memory isn't loaded or committed
either.

**Tracked work** is what the assistant is doing or following for you, listed under _Working on_ at the top of
its details panel: the tasks it created, its subagents' research, and plans or questions waiting on you. It keeps the list
with board tools of its own, which its instructions tell it to use: `track_work` adds an item when it takes on a request
that goes on in the background, or changes one by its id as things change, and marks it done (or failed) when it reports
back; `untrack_work` takes items off (by id, or the done ones); `list_tracked_work` reads the list back after a restart
or a compaction. An item has a title, a note, a status (_working_, _waiting on you_, _waiting on a task_, _done_ or
_failed_), its times, and can follow a board task (by id or key, on any board the assistant can use, `work:SD-3` for
another profile's) and link a document or pull request. One that follows a task shows its key and live status, and follows it
where the assistant hasn't said since: it shows as done once the task is done (merged or closed), unless it failed, and
one left working or waiting on its task shows as waiting on you once the task needs your attention or is in review, with
where the task is in place of its note (the assistant's note is still in its tooltip). The list is kept on the assistant's task
(`tracked`, so the board's task events keep it live), at most 100 items; its routines' threads read and change
the same list, and other threads can't use the tools. There, click an item to open its task (in a dialog over the page) or link,
right-click it to remove it, collapse the list with its heading, and hide or clear the done items
(`tasks.removeTracked` with `{"id", "ids": […]}`); whether it's collapsed and hides done items is kept in the browser.
The assistant's details are otherwise short: no description or labels, its _Rules_ and _Agent_ collapsed until opened,
and its Google in Settings → **Assistant**. Its model and effort, like any thread's, are picked in its
message box, beside the permission mode.

**Approval rules** say what the assistant may do outside the board (_allow_), asks you
first each time (_ask_) or never does (_never_), whatever its thread's permission mode. Edit them
under _Rules_ in its details (collapsed until opened), or with the RPCs `approvalRules.get` and
`approvalRules.set`. A rule names a tool (`mcp__google__send_gmail_message`, `Bash`), an MCP server for all its
tools (`mcp__google`), or a pattern with `*` (`mcp__google__*delete*`), without regard to case; when several match, never beats
ask and ask beats allow. A tool or pattern can have only one rule. They hold for the assistant and
the threads under it, from their next run. A profile starts with rules for a Google Workspace MCP
server named `google`: reading, searching and drafting are allowed; sending mail, making, changing
or deleting events, sharing files or handing them over, changing files, mail filters and labels, and
anything `manage_*` ask; deleting or trashing mail and files is never. A switch adds an _ask_ on the
board's `create_task`.

- **Claude Code** gets a PreToolUse hook (`huntaway approval-hook`, `apps/server/src/hooks/approval.ts`) that
  allows, asks or denies the calls a rule matches. Its _ask_ goes to the board's permission prompt in every mode,
  Bypass included (checked with Claude Code 2.1.317), so the assistant's runs in Bypass get the prompt tool too; in
  _Don't ask_ what a rule asks about is denied. Tools a rule names exactly as _never_ are left out of the run
  (`--disallowedTools`). The hook is only installed when a rule is for a tool other than the board's, and its
  matcher only matches the MCP servers the rules name (an anchored, case-insensitive regular expression, see
  `claudeMatcher` in `apps/server/src/agents/rules.ts`), or every tool when a rule names one that isn't an MCP
  server's; `bin/huntaway` starts it from its own entry file (`apps/server/src/hooks/approval-hook.ts`),
  without loading the server. It fails closed: while any rule asks or refuses, a call it can't check (its rules or input
  unreadable, the hook failing, or its binary missing) is refused. A rule on `Bash` holds for a `wait`'s command
  too, even in _Auto_, where Claude's classifier reviews the wait.
- **Codex** can't hold an _ask_ with a hook (its PreToolUse `ask` fails open, checked with Codex
  0.166), so an MCP server a rule may match asks the board about each of its calls
  (`default_tools_approval_mode = "prompt"`), and the board answers by the rules. In _Auto_ its own
  reviewer would answer, so the assistant's Codex runs in Auto have you answer instead, as in _Ask_.
  In _Bypass_ and _Don't ask_ Codex can't ask at all: what a rule asks about is refused, as is a tool
  only a pattern allows. Its own tools (`Bash`, `ApplyPatch`) can't be stopped before they run: an
  _ask_ rule on them launches it with the approval policy `untrusted` (and never full access), so it
  asks about every command and file change in any mode, except commands it takes as safe (reading,
  listing), which it runs without asking; a _never_ rule on them (or `*`) can't hold, so the run is
  refused, saying so.
- **The board's own tools**, `wait` included, are held by the board as it runs them, for both, under
  the server's current name or an older one (`mcp__issue_agent__…`). Deleting tasks, adding projects
  and changing automations always ask you with their own card, so an _ask_ rule doesn't ask about
  them again: their own card is the rule's asking, and goes in the action log (a _never_ rule still
  refuses them).

A prompt raised in the assistant or a thread under it by a **routine run** (one a routine started,
in a thread of its own or with a message to the assistant, with nobody there: its message is marked
`routine`, which a message that waits in the queue keeps, unless something of yours is queued with
it) is denied if nobody answers it within the profile's expiry (30 minutes by default;
`expiry_minutes`, 0 for never), and the agent is told to carry on without it. Prompts raised before
this, ones the user's own turns raise, and project tasks' (even ones an automation started) wait as
they always did. Each call a rule asked about or blocked goes in the assistant's **Actions** tab
(`approvalRules.log`): what it was called with, the rule, how it ended (allowed, denied, expired or blocked) and who
answered (you on the board, nobody in time, the mode, the rule, or its run ending first; an entry from the old board
can also say a notification or Telegram).

## Google for the assistant

The assistant reaches Gmail, Calendar and Drive through a Google Workspace MCP server on
the host it runs on, [workspace-mcp](https://github.com/taylorwilsdon/google_workspace_mcp), signed
in with an OAuth client of your own. Not the claude.ai connectors for Gmail, Calendar and Drive: those
come with the Claude login, so every agent on it, project tasks included, would have your mail. The
Google server is a global MCP server of the host named `google`, which only the assistant and its
routines get: a project's agents never do, whatever its switches say. It works the same for Claude
and Codex (a stdio server; Codex gets two minutes to start it, as `uvx` fetches it the first time).
Its tools are `mcp__google__…`.

1. **Install uv** for the host's user (`curl -LsSf https://astral.sh/uv/install.sh | sh`), so `uvx`
   is on the host's `PATH`. The server runs `uvx workspace-mcp@2.3.0 --single-user --tools gmail
   calendar drive --tool-tier extended`: a pinned version, so a new release is picked rather than run
   with your mail the day it's out (change it in Settings → Skills and MCP).
2. **Make an OAuth client** in [Google Cloud's console](https://console.cloud.google.com/), in a
   project of your own:
   - APIs & Services → **Library**: enable the Gmail API, Google Calendar API and Google Drive API.
   - **OAuth consent screen**: user type _External_ (or _Internal_ in a Workspace organisation), your
     address as a test user. Then **Publish app** to _In production_: while it's _Testing_, Google's
     refresh tokens last 7 days, and the assistant would be signed out each week. You'll see the
     "Google hasn't verified this app" warning when you sign in (it's your own app); continue past it.
   - **Credentials** → Create credentials → OAuth client ID → application type **Desktop app**. A
     Desktop app client takes a redirect to any port on `127.0.0.1`, which the sign-in below uses.
   - Download its JSON to `~/.google_workspace_mcp/client_secret.json` on the host, readable by that
     user alone: `chmod 600 ~/.google_workspace_mcp/client_secret.json`.

   It asks for these scopes (what workspace-mcp's Gmail, Calendar and Drive tools need): `openid`,
   `userinfo.email`, `userinfo.profile`, `gmail.readonly`, `gmail.send`, `gmail.compose`,
   `gmail.modify`, `gmail.labels`, `gmail.settings.basic`, `calendar`, `calendar.readonly`,
   `calendar.events`, `drive`, `drive.readonly` and `drive.file`. The morning brief's run is told to
   only read and draft; the scopes don't hold it back.

3. **Add the server**: Settings → **Assistant** → the profile's **Google** → **Add the Google server**. It adds the
   `google` server to the host (with the paths above) and switches it on for the profile.
4. **Sign in.** A headless host has no browser, so the consent step runs there and the browser on your
   machine reaches it through SSH. From your machine, forward the port:

   ```sh
   ssh -N -L 8765:127.0.0.1:8765 <host>
   ```

   and on the host, as the user the board runs as:

   ```sh
   huntaway google-auth --client-secret ~/.google_workspace_mcp/client_secret.json
   ```

   (`apps/server/bin/huntaway google-auth` from a checkout.) It listens on `127.0.0.1:8765` there
   (`--port` for another, `--credentials-dir` for another folder) and prints Google's consent URL.
   Open it in your browser, sign in, tick every box and allow; Google sends the browser back to
   `http://127.0.0.1:8765/`, which the tunnel brings to the host. It swaps the code for tokens (with
   PKCE) and writes them where workspace-mcp reads them,
   `~/.google_workspace_mcp/credentials/<your address>.json`, readable by the host's user alone (in a
   `0700` folder). Run it again to sign in afresh, or to give scopes you left unticked.

5. **Check**: the Google card says _Connected as <your address>_, and **Test** asks Google whether its
   refresh token still works. Until then it says what's missing: no server, switched off for the
   profile, `uvx` not found, no OAuth client, not signed in, no refresh token; and warns of files others
   can read, scopes not granted, or several accounts signed in (set `USER_GOOGLE_EMAIL` in the server's
   env to pick one). The RPC `assistant.google` (with `check` for the test) is the same, and `assistant.setupGoogle` adds
   the server.

On a test server, the old repository's
[`scripts/stub-google-mcp.py`](https://github.com/dire-kiwi/huntaway-legacy/blob/master/scripts/stub-google-mcp.py) (not in
this one) stands in for workspace-mcp: an MCP server over stdio
with a few of its tools by name and canned mail, events and files for today (one mail a prompt
injection), which logs each call to `$STUB_GOOGLE_LOG`. Make it the Google server's command
(`{"command": "python3", "args": ["-I", "<path>/scripts/stub-google-mcp.py"]}`) in Settings → Skills and MCP.

## An assistant host

Each profile's **assistant** (the sidebar's _Assistant_) can run on another machine, such as a
home server or a small VPS, rather than on the hub. Its credentials then never sit where project
agents run, and its agents can't read the hub's files or database. Set it up like this:

1. **Install a host there** from a release, as the user the assistant should run as:

   ```sh
   curl -fsSLO https://raw.githubusercontent.com/dire-kiwi/huntaway/main/scripts/install-release-host.sh
   sh install-release-host.sh
   ```

   It prints the command that runs the host with release updates as a user systemd service
   (`huntaway install-service`, see [Running a host as a service](hosts.md#running-a-host-as-a-service)): run it. It also
   prints the forced command for SSH.
   The host's data dir is made private at start (`0700`, and its database files `0600`; every host
   does this), so other users of that machine can't read the assistant's threads.

2. **Link it over SSH** from the board: Settings → Hosts → **Add host** → **Over SSH**, with
   `user@machine` and the path the script printed. Add the line the dialog shows to that user's
   `~/.ssh/authorized_keys` on the machine, with the forced command the script printed:

   ```text
   restrict,port-forwarding,permitopen="127.0.0.1:7879",command="HUNTAWAY_RELEASE_UPDATES=dire-kiwi/huntaway '/home/me/.local/share/huntaway-effect-server/current/huntaway' ssh-host --port 7879 --data-dir '/home/me/.local/share/huntaway-effect'" ssh-ed25519 AAAA… huntaway-hub@<hub>
   ```

   The hub tunnels to the host through that command, so it listens on its own localhost only and
   never needs to reach the hub. When the hub's machine sleeps or changes network,
   the link drops and comes back by itself; the assistant keeps running there meanwhile.

3. **Give it a Claude login.** Settings → Agent configs → **Copy login** copies the config's login
   and settings to the new host (or log in there with `claude` as that user). Then add a profile of
   the same name there: Settings → Profiles shows **Not set up on: <host>** under the profile.
4. **Move the assistant there**: Settings → Profiles → **Edit** the profile on the board's own host
   and pick the host under **Assistant host**. The sidebar's _Assistant_ then opens the assistant on that
   host (the page asks that host for it, through the hub), and says so while the host is offline or has no
   profile of that name. Removing the host puts the
   assistant back on the board's own host. Its routines are that host's: make them in its Routines
   tab there. Routines made on the board's own host before the move stay there and don't run (each
   run fails, saying where the assistant is, and new ones can't be made there); the Routines tab on
   the assistant host lists them, to delete.
5. **Let it use your board**, if it should hand work to your projects or read what needs your
   attention: Settings → Hosts → **Let this host's agents use this board** for that host. Agents
   there in the profiles whose assistant runs on it then act on your boards with that profile's access
   (see _Hosts_ above); other profiles on that host stay out. Settings → **Assistant**
   shows the host it runs on.
6. **Google** is set up on the assistant host only (see _Google for the assistant_ above).
