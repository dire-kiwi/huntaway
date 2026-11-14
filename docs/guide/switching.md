# Switching from the old server

This server is Huntaway written again. It doesn't read the old server's database, and it has a data folder and a
port of its own (`~/.local/share/huntaway-effect` and 7879, where the old one has `~/.local/share/issue-agent` or
`~/.local/share/huntaway` and 7878), so the two can run side by side on one machine without touching each other.

A machine is moved over once, with `huntaway import-legacy`, which fills the new folder from the old one. This page
is how to do that: what the import copies, how to rehearse it while the old board is still in use, the switch itself,
how to go back, and what to do with several hosts. Below, `huntaway` is the new server's launcher (a release's
`…/huntaway-effect-server/current/huntaway`, see _Updating the desktop app_ in `desktop.md`, or
`apps/server/bin/huntaway` in a checkout); a command of the old server is marked as the old build's.

## What the import copies, and what it leaves

The importer **copies and never moves**. It reads the old folder and writes nothing under it, so the old server can
be started on it again as it was.

| In the old folder                                                  | What the import does                                                                                                        |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| The database (`huntaway-2.db`, or an older name)                   | Reads it, read-only, into the new folder's `board.db`. Every row is checked against the schema the new server reads it with |
| `host_id`, `auth_token`, `hub_token`, `ssh/`                       | Copies them, so the board's token, bookmarked board URLs and the links between hosts stay valid                             |
| `attachments/`, `skill-sources/`                                   | Copies them                                                                                                                 |
| `runs/`                                                            | Copies the folders of runs that ended in the last 14 days (their token counts and failure tails are read from them)         |
| Worktrees, scratch folders, document folders, assistant workspaces | **Leaves them where they are.** Every path the board stores is made absolute, so it points into the old folder              |
| `backups/`, `app/`, `gh-shim/`, `cua-driver/`, `outgoing.bundle`   | Not carried: the new server makes its own                                                                                   |

Paths are kept rather than files moved because an agent's session is found by the folder it ran in (a thread whose
folder moved gets "No conversation found"), and a git worktree is registered in its repository by its absolute path.
So **the old folder has to stay on disk after the switch**: its database and server files are no longer used, but its
worktrees and work folders are. New worktrees of an imported project still go to that project's worktree folder in
the old folder; a project made on the new server uses the new one.

Outside both folders nothing changes: repositories, `ia/…` branches, refs under `refs/huntaway/`, and agent config
folders and their sessions.

**Terminals start afresh.** The new server keeps its terminals on a tmux server of its own folder
(`tmux -S ~/.local/share/huntaway-effect/tmux.sock`), not on the old server's (`tmux -L ia-<host>`). So after the
switch a task's terminal opens a new shell, and whatever ran in the old one (a dev server, a long command) is still
running on the old tmux server, which the board no longer shows: `tmux -L ia-<the first 12 characters of host_id> ls`
lists those sessions, and `… attach -t <session>` or `… kill-server` deals with them. Finish or note what runs in
terminals before the switch.

A few things change shape on the way: subprojects become ordinary tasks (subprojects are gone; a task that still
merges into a subproject's branch is named in the report, to be given `merges_into` by hand), a queued message
becomes the task's queue, a task that was in progress becomes **Needs attention** ("Interrupted by the move to the
new server"), a pending permission prompt becomes expired, and Telegram settings are dropped. The phone app's paired
devices wait for the phone app (see `mobile.md`).

## The rehearsal

Rehearse first, while the old board is in use. A rehearsal answers two questions: does this board's data convert,
and does the result look right. It reads a snapshot of the old database beside the running server, never stops it
and never writes to its folder.

1. Import into a spare folder of its own (one that doesn't exist yet, or is empty):

   ```sh
   huntaway import-legacy --from ~/.local/share/issue-agent --data-dir ~/huntaway-rehearsal --rehearsal --check
   ```

   (`--from` is wherever the old folder is.) It prints what it wrote per table and a summary line, and exits with
   status 1 when the report has a failure in it.

2. Read `~/huntaway-rehearsal/import-report.json` (below) and deal with what it says.

3. Look through the board it made:

   ```sh
   huntaway serve --data-dir ~/huntaway-rehearsal
   huntaway token --data-dir ~/huntaway-rehearsal    # its own token, not the old board's
   ```

   and open `http://127.0.0.1:7879/?token=<that token>` (`--port` if 7879 is taken). A rehearsal folder only ever
   opens **read-only**: the server listens on 127.0.0.1 unless given `--host`, starts no agent, terminal, automation
   or watcher, dials no link and calls nothing on the network, and refuses every change. A banner names the board and
   when it was imported. Open tasks, read their threads, look at their Changes tabs and history, settings, workflows
   and automations.

4. To try again (after updating the old server or this one), delete the spare folder and start from step 1: the
   importer refuses a folder that already has a `board.db`.

Repeat until the report has no failure. The rehearsal has an identity of its own and none of the old board's
credentials (links, push subscriptions, automation tokens and webhook secrets, telemetry and sign-ins are converted
and checked but not written), so nothing it does can reach the old board's agents, links or services. A rehearsal
folder is thrown away afterwards, never switched to.

### The report

`import-report.json`, in the folder imported into, says:

- `tables`: per table, how many rows the old database had, how many were written, and how many were converted but
  withheld (a rehearsal's credentials).
- `failures`: rows that weren't written, each with its table, its key and why (the old row or the new one didn't
  decode, or it points at something that isn't there). These are what `--check` fails on.
- `json`: stored values (settings, a task's JSON fields) the new server doesn't read. The row is written and the
  server reads the value as its default. `--check` fails on these too.
- `notes`: things to know that aren't failures: a worktree or work folder the old board says is there that isn't on
  disk (the old board has the same gap), a task that merges into a subproject's branch, and the like.
- `messages`: old thread messages that were never moved onto items, per task: converted into items, or kept as one
  "A message the old board could not show" notice with its contents whole.
- `check`: what `--check` found comparing the old database with the new one: row counts per table, and per task its
  key, its item and request counts, its first and last items and its cost.

A failure or an unread value is a bug in the importer, or old data it doesn't know yet. Don't switch with one in the
report: report it with the lines of the report it's on.

### When the import refuses

The importer says why it won't go ahead, and names the tasks and runs a reason is about:

- **The old server has the database open** (a normal import, not a rehearsal): stop the old server, then import.
- **The old database is at another schema version**, or **has named migrations the importer doesn't know**: update
  the old server to its last release (or, for unknown migrations, this one to a release that knows them), let it start
  once, and try again.
- **Runs are live**: wait for them to end. `--force` records them as interrupted instead.
- **Tasks' threads are not yet items**, or **threads stopped on a fault** (listed by key): the new server reads a
  thread only as items. Start the old server once and let it settle: at every start it moves each quiet task onto
  items, and its log ends with how many are left. For a task it couldn't move (the log names it), stop the old server
  and run `huntaway threads-rebuild <key>` with the old build, which rebuilds that one thread and says why it fails.
  Once it passes, start the old server again so the task moves. A task still listed after that has history the old
  server can't read: that's a bug to fix in the old repository, as the importer has no way to drop a thread. `--force`
  doesn't override this.
- **The new folder already has a `board.db`** (a board tried out there, or used before the switch): move it aside
  first, or replace it with `--replace` (see _Switching onto a board already in use_). An import is never merged into
  another board.
- **The new server has its `board.db` open**, or **runs of the board being replaced are live** (with `--replace`):
  stop the new server, and wait for its agents to finish (`--force` records them as interrupted).
- **The old folder has more than one database file**: name the one the old server used with `--db huntaway-2.db`.

## A throwaway switch

A rehearsal can't show the things that would be acting: a session resuming, a terminal, a worktree being made, a
merge. Try those once on a board made to be thrown away, before the real switch on each machine:

1. In a checkout of the old repository, start a test server: `scripts/test-server.sh --seed` (its own port and data
   folder, a test project on a fresh repository).
2. Run one real task on it, on a cheap model, until it has made a change and finished.
3. Stop that server by its PID (`kill $IA_TEST_PID`; not `scripts/test-server.sh stop`, which deletes its data
   folder).
4. Import it for real (not as a rehearsal), into a scratch folder:

   ```sh
   huntaway import-legacy --from <its data folder> --data-dir <scratch folder> --check
   ```

5. Start the new server on it, `huntaway serve --data-dir <scratch folder> --host 127.0.0.1 --port <a free port>`,
   and open it with its token (`huntaway token --data-dir <scratch folder>`: the test server's, which the import
   copied). It has the test server's identity and repository, so this is a real switch in miniature.
6. Open the task and send a message: the agent should answer knowing the conversation, which means its session
   resumed. Open its terminal, and look at its Changes tab.
7. Stop it, and delete both folders.

## The switch, on one machine

Pick a quiet moment: the board is down from step 3 until step 7.

1. **Install the new desktop app**, if this machine uses the desktop app: a release package of this repository, or
   `scripts/install.sh` (see `desktop.md`). Before you open it, give it the old port: write
   `~/.config/huntaway-effect/desktop.json` (`~/Library/Application Support/huntaway-effect/desktop.json` on a Mac)
   with `{ "port": 7878 }`. Otherwise it looks for its server on 7879 and, finding none, starts one of its own on the
   new data folder beside the one you start below. If it has already made a board in `~/.local/share/huntaway-effect`,
   move that folder aside before step 4.
2. **Wait until no agent is running**: nothing in progress on the board, no run going.
3. **Stop the old server**: `systemctl --user disable --now huntaway.service` if it runs as a service (the old server
   named its unit `huntaway-<port>.service` on a port other than 7878), or quit the old desktop app, or stop the
   process that runs `huntaway serve`.
4. **Import**:

   ```sh
   huntaway import-legacy --from ~/.local/share/issue-agent --check
   ```

   (or wherever the old folder is: `~/.local/share/huntaway` unless the machine has had Huntaway since it was called
   issue-agent, or the old server's `--data-dir`). It fills
   `~/.local/share/huntaway-effect`. On a big board (thousands of tasks, a gigabyte of database) this takes minutes.
   If it refuses, see _When the import refuses_; if the report has a failure, go back to the old server (start it
   again) rather than switching.

5. **Start the new server on the old server's port**: `huntaway serve --port 7878`, with the other flags the old one
   had (`--host`, `--name`, `--hub`…; `IA_*` variables are now `HUNTAWAY_*`, see `server.md`). A browser keeps its
   storage per address, so on the same address the board's token (the import copied it), drafts and preferences are
   still there; on another port the board asks for its token again and starts with empty drafts. The new desktop
   app keeps its windows' storage in a folder of its own, so drafts typed in the old app's windows aren't carried.
6. **Install the new service**, if the machine ran the old server as one: stop the server from step 5, then
   `huntaway install-service --port 7878 [the same flags]`, which writes `huntaway-7878.service`, enables it and
   starts it. (Or skip step 5 and do this instead.) The new server names its unit after the port on every port, so on
   7878 it doesn't touch the old `huntaway.service`; on another port the new unit has the old one's name and replaces
   it, so keep a copy of the old unit file for going back.
7. **Check it works**: open a task and send a message (the agent's session resumes), open its terminal (a new
   shell in the task's worktree, see _Terminals start afresh_ above), look at the Changes tab, and check that a webhook automation fires (Settings →
   Automations shows its runs).

## Switching onto a board already in use

If this machine has run the new server for a while, `~/.local/share/huntaway-effect` has a board of its own: profiles,
projects and tasks made there. The switch **replaces** that board with the old one; nothing of the two is merged.
`scripts/switch-board.sh`, in a checkout of this repository (after `pnpm install`), does it in one go:

1. **Rehearse**, beside both running servers: `scripts/switch-board.sh --rehearse` imports a snapshot of the old
   board into a fresh folder under `$TMPDIR` as a [rehearsal](#the-rehearsal) and stops there. Read its report.
2. **Stop both servers**: the old one for good, and the new one (quit both desktop apps, or stop their `huntaway
   serve`), once no agent of either board is running.
3. **Switch**: `scripts/switch-board.sh` (`--from` and `--data-dir` if the folders are elsewhere; it asks before
   going ahead, `--yes` doesn't). It runs

   ```sh
   huntaway import-legacy --from ~/.local/share/issue-agent --data-dir ~/.local/share/huntaway-effect --check --replace
   ```

   which refuses while either server has its database open or runs of either board are live (`--force` records them
   as interrupted), then sets the new folder's board aside in `~/.local/share/huntaway-effect/replaced-<time>/`
   (`board.db`, `import.json`, the identity files, `ssh/`, `attachments/`, `skill-sources/`, `runs/`) and imports the
   old board in its place. If the import fails, the board is put back as it was.

4. **Start the new server** (its desktop app, or `huntaway serve`). It is now the old host: the old board's tasks,
   projects, profiles, identity and **board token**. The tasks of the replaced board are not on it; their branches,
   pull requests and worktrees (`~/.local/share/huntaway-effect/projects/…`, registered in their repositories) stay
   as they were.

To go back to the board that was replaced: stop the new server and run
`scripts/switch-board.sh --undo ~/.local/share/huntaway-effect/replaced-<time>`, which removes the import and puts the
set-aside files back. The old server's folder was never written, so it starts as it was too.

## Going back

Stop the new server (and `systemctl --user disable --now huntaway-7878.service` if you installed its service), and
start the old one on its folder (`systemctl --user enable --now huntaway.service`, or the old desktop app). The old
folder wasn't written, so the old board is as it was at step 3.

What was done on the new server since is not in it: tasks created, messages sent, runs and their costs, settings
changed. Worktrees the new server made for imported projects are in the old folder's worktree folders, and need
removing by hand (`git worktree remove`). Leave the new folder alone or delete it: the new server won't start on it
while the old server has the old database open (see _After the switch_), and to switch again later, move it aside
and import afresh.

## Several hosts

The old and new servers can't link to each other, so a board of several hosts is moved together:

1. Rehearse on each host first.
2. Stop every host's old server.
3. Import on each host, as in _The switch, on one machine_.
4. Start each.

The links between hosts are imported with the tokens they hold and each host keeps its identity, so the hosts find
each other again without being linked anew. A host that can't be moved at the same time can't connect to the board
until it is: it shows as offline on the hub (the old server and the new one don't speak to each other), and its tasks
aren't on the board in the meantime.

## After the switch

- **Keep the old folder.** Its worktrees, work folders and agents' sessions are still in use, as above. Its database,
  `backups/` and `app/` aren't, but nothing needs them deleted.
- **`import.json`** in the new folder records where the board came from, when, the old host's id, and whether it was a
  rehearsal. The server reads it at every start:
  - after a real import, it **refuses to start while any process has the old database open**, and says to stop the
    old server, or to go back properly. So the two can never run as the same host, say after going back to the old
    server and then starting the new one too.
  - after a rehearsal, it **starts read-only**, and no flag changes that. A rehearsal folder is never switched to:
    import again, for real, with the old server stopped.
- `huntaway import-legacy --from <old folder> --check`, run again on the imported folder, checks it against the old
  database without importing anything.
