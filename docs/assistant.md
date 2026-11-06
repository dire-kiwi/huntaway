# The personal assistant

The assistant is a profile's personal mode, apart from its projects. This section covers its thread, memory, approval
rules and Google. The rest is elsewhere: its routines and the morning brief under [Automations](integrations.md#automations), running it on a
machine of its own under [An assistant host](hosts.md#an-assistant-host), talking to it from Telegram under [Telegram](hosts.md#telegram), push for its replies,
reports and prompts under [Push notifications on a phone](server.md#push-notifications-on-a-phone), and the phone app's Assistant tab under [The mobile app](mobile.md#the-mobile-app).

Each profile has an **assistant** (API 109): one long-lived conversation outside every project,
opened with **Assistant** in the sidebar (above *Projects*), full width at `/assistant/<profile>`.
It's made the first time it's opened (`GET /api/profiles/<id>/assistant`; `POST` with
`{"text": …}` sends it a message), keyed `A-<n>` (no project can use the key `A`; one that had it
moves to `AP`), and its agent works in `<data dir>/assistants/<task id>`, which it can write without
asking and which lasts between conversations. It's told it's a personal assistant rather than a
coding agent: it has the global skills and MCP servers its profile switches on (its skills are written
to `<data dir>/profiles/<profile id>/agent`), on Claude Code and Codex alike, and the board tools, and
hands code work to project tasks with `create_task`. Your messages go to it as they are, with no
"start working on this task" around the first. It never goes to review or
merge: after each reply it's back in *To do*, and it can't be moved to *In review*, *Ready for
merge*, *Done* or *Backlog*. It's off the boards, and out of `list_tasks` and the profile's task
lists unless they're asked for it (`include_assistant`). Other profiles' agents can't reach it,
whatever access their profile has.

The assistant **remembers** you (API 111) in files in its workspace: `USER.md` (who you are, your
preferences), `MEMORY.md` (lasting facts) and a log for each day, `memory/YYYY-MM-DD.md` (in the
host's time zone). The board, not the CLI, puts them into the instructions of every run, so it's the
same on Claude Code and Codex and always what the files say now: `USER.md` and `MEMORY.md` up to
8,000 characters (and 16 KB) each (with a note to the assistant when one is cut), today's and
yesterday's logs (their ends, if longer), and how to remember, forget and keep the log. Claude Code
is given these instructions in a file (`--append-system-prompt-file`, in the run's folder) rather
than as an argument, which can't be longer than 128 KiB. The workspace has a git history: after each
of the assistant's turns that changed it, the board commits it as *Assistant*. Its git folder is
`<data dir>/assistants/<task id>.git`, next to the workspace rather than in it, so the assistant
can't set the config, hooks or filters the board's git runs with. A workspace from before gets a new
one, into which its old `.git`'s objects and refs are copied and written again by git, and the old
`.git` goes; one with a `commondir`, `gitdir` or alternates, or whose history isn't whole, is left
as it is and the history starts again; the board's git also ignores your own git config. What the
workspace's `.gitignore` lists (made with common downloads, build output and secrets) and files over
1 MB aren't committed, nor is a repository in the workspace (a `git clone`, say): it's never a
gitlink in the history, as git would look in it with its own config, which the assistant can write.
The assistant's **Memory** tab lists the files (those loaded into every run highlighted, with their
length against the cap), edits them (committed as *You*; a save over what the assistant wrote
meanwhile asks whose to keep), shows each file's history with what each commit changed, and restores
a version. A restore or a save over the assistant's edit first commits that edit, as the
assistant's, if it isn't yet, so it's always in the history; a file the history leaves out is only
written over (even when forced) if it's what the editor opened. Its **Import** gives a prompt to
paste into another assistant (ChatGPT, Claude.ai…) for what it knows about you, and sends its answer
to your assistant, as data, to fold into `USER.md` and `MEMORY.md`. The API is under
`/api/profiles/<id>/assistant/memory` (`file`, `history`, `diff`, `restore`, `import`), and only
reaches files in that profile's assistant's workspace: paths with `..`, in `.git` or through a
symlink are refused, and so is a workspace (or `assistants` folder) that's been replaced by a
symlink, whose memory isn't loaded or committed either.

**Approval rules** (API 115) say what the assistant may do outside the board (*allow*), asks you
first each time (*ask*) or never does (*never*), whatever its thread's permission mode. Edit them
under *Rules* in its details, or with `GET`/`POST /api/profiles/<id>/approval-rules` (`{"rules":
[{"tool", "decision"}], "expiry_minutes"}`, or `{"reset": true}`). A rule names a tool
(`mcp__google__send_gmail_message`, `Bash`), an MCP server for all its tools (`mcp__google`), or a
pattern with `*` (`mcp__google__*delete*`), without regard to case; when several match, never beats
ask and ask beats allow. A tool or pattern can have only one rule. They hold for the assistant and
the threads under it, from their next run. A profile starts with rules for a Google Workspace MCP
server named `google`: reading, searching and drafting are allowed; sending mail, making, changing
or deleting events, sharing files or handing them over, changing files, mail filters and labels, and
anything `manage_*` ask; deleting or trashing mail and files is never. A switch adds an *ask* on the
board's `create_task`.

- **Claude Code** gets a PreToolUse hook (`huntaway approval-hook`, `apps/server/src/agent/approval_rules/hook.ts`) that
  allows, asks or denies the calls a rule matches. Its *ask* goes to the board's permission prompt in every mode,
  Bypass included (checked with Claude Code 2.1.317), so the assistant's runs in Bypass get the prompt tool too; in
  *Don't ask* what a rule asks about is denied. Tools a rule names exactly as *never* are left out of the run
  (`--disallowedTools`). The hook is only installed when a rule is for a tool other than the board's, and only
  matches `mcp__.*` unless a rule names another tool; `bin/huntaway` starts it straight from its own module, without
  loading the server. It fails closed: while any rule asks or refuses, a call it can't check (its rules or input
  unreadable, the hook failing, or its binary missing) is refused. A rule on `Bash` holds for a `wait`'s command
  too, even in *Auto*, where Claude's classifier reviews the wait.
- **Codex** can't hold an *ask* with a hook (its PreToolUse `ask` fails open, checked with Codex
  0.166), so an MCP server a rule may match asks the board about each of its calls
  (`default_tools_approval_mode = "prompt"`), and the board answers by the rules. In *Auto* its own
  reviewer would answer, so the assistant's Codex runs in Auto have you answer instead, as in *Ask*.
  In *Bypass* and *Don't ask* Codex can't ask at all: what a rule asks about is refused, as is a tool
  only a pattern allows. Its own tools (`Bash`, `ApplyPatch`) can't be stopped before they run: an
  *ask* rule on them launches it with the approval policy `untrusted` (and never full access), so it
  asks about every command and file change in any mode, except commands it takes as safe (reading,
  listing), which it runs without asking; a *never* rule on them (or `*`) can't hold, so the run is
  refused, saying so.
- **The board's own tools**, `wait` included, are held by the board as it runs them, for both, under
  the server's current name or an older one (`mcp__issue_agent__…`). Deleting tasks, adding projects
  and changing automations always ask you with their own card, so an *ask* rule doesn't ask about
  them again: their own card is the rule's asking, and goes in the action log (a *never* rule still
  refuses them).

A prompt raised in the assistant or a thread under it by a **routine run** (one a routine started,
in a thread of its own or with a message to the assistant, with nobody there: its message is marked
`routine`, which a message that waits in the queue keeps, unless something of yours is queued with
it) is denied if nobody answers it within the profile's expiry (30 minutes by default;
`expiry_minutes`, 0 for never), and the agent is told to carry on without it. Prompts raised before
this, ones the user's own turns raise, and project tasks' (even ones an automation started) wait as
they always did. Each call a rule asked about or blocked goes in the assistant's **Actions** tab
(`GET /api/profiles/<id>/approval-log`): what it was called with, the rule, how it ended (allowed,
denied, expired or blocked) and who answered (you on the board, a notification, nobody in time, the
mode, the rule, or its run ending first).

## Google for the assistant

The assistant reaches Gmail, Calendar and Drive (API 113) through a Google Workspace MCP server on
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
   with your mail the day it's out (change it in Settings → Skills and MCP servers).
2. **Make an OAuth client** in [Google Cloud's console](https://console.cloud.google.com/), in a
   project of your own:
   - APIs & Services → **Library**: enable the Gmail API, Google Calendar API and Google Drive API.
   - **OAuth consent screen**: user type *External* (or *Internal* in a Workspace organisation), your
     address as a test user. Then **Publish app** to *In production*: while it's *Testing*, Google's
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
3. **Add the server**: the assistant's Details → **Google** → **Add the Google server**. It adds the
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
5. **Check**: the Google card says *Connected as <your address>*, and **Test** asks Google whether its
   refresh token still works. Until then it says what's missing: no server, switched off for the
   profile, `uvx` not found, no OAuth client, not signed in, no refresh token; and warns of files others
   can read, scopes not granted, or several accounts signed in (set `USER_GOOGLE_EMAIL` in the server's
   env to pick one). `GET /api/profiles/<id>/assistant/google[?check=1]` is the same on the API, and
   `POST` adds the server.

On a test server, `scripts/stub-google-mcp.py` stands in for workspace-mcp: an MCP server over stdio
with a few of its tools by name and canned mail, events and files for today (one mail a prompt
injection), which logs each call to `$STUB_GOOGLE_LOG`. Make it the Google server's command
(`{"command": "python3", "args": ["-I", "<path>/scripts/stub-google-mcp.py"]}`) in Settings → Skills and
MCP servers.
