# Huntaway: UI feature inventory (what the README leaves out)

Detail behind [huntaway-features.md](huntaway-features.md), the Huntaway inventory.

Source: `app/src` (React 19 + Vite + Tailwind 4 + zustand, xterm.js, Mermaid, react-markdown) and
`app/electron/main.cjs`, at commit `90bb99b`. Paths below are relative to `app/src` unless they start
with `app/`. "(README)" marks something the README already describes; those get one line. Many
features are gated per host by API version (`hostSupports(host, N)`): on an older linked host they're
simply hidden.

## 1. Routes and pages (`router.ts`, `App.tsx`)

| Path | Page |
|---|---|
| `/` | Redirects to the board of the active profile (the one picked last, saved in the browser). |
| `/profile/<name>` | Profile board: every task of that profile across projects and hosts, plus its group and scratch tasks (README). |
| `/p/<project>` | Project board (README). `/p/<project>/settings`: project settings page (section 9). |
| `/g/<host>/<group>` | Group board: all tasks of a group's projects plus its group tasks (README). |
| `/t/<task>` | A task's own page; once the task is loaded it redirects to its board with the task open in the side panel (its subproject's, group's or profile's board as fits). |
| `/t/<task>/board` | A subproject's own board (README). |
| `/settings`, `/analytics`, `/hosts/<host>` | Settings, Analytics, a host's page. |
| `?task=<id>[&expanded]` | On any board: the task open in the side panel, or expanded into a dialog. |

- There is **no inbox route, no separate list route** (list is a per-browser view toggle on every
  board), no command palette and no search across boards. `App.tsx`
- Before anything loads: a **token screen** ("Access token required", paste `huntaway token`) on a
  401, and an **onboarding** card on a board with no profiles (create a profile; a board-only hub
  instead shows the Hosts panel to link a machine that can run agents). `components/Settings.tsx`
- A project or task link that can't be found says so ("Project not found", "Task not found");
  an archived project's old link says it's archived and links to Settings. `components/Board.tsx`

## 2. Sidebar (`components/Sidebar.tsx`)

- Header: logo, "Huntaway", and a **connection dot** (green; red and pulsing with "Reconnecting…"
  while the event socket is down).
- Profiles list with a per-profile **status bar** of coloured segments (README); Analytics link.
- *Starred* and *Reminders* sections (README). Reminders show a relative label and turn amber with a
  bell-ring when due; the heading counts due ones. Right-click a row: Star/Unstar, the reminder
  presets, *Remind me at…*, *Clear reminder*. `components/Reminders.tsx`, `reminders.ts`
- Projects of the active profile, grouped by host when there are several (README). Each row shows the
  key's first 3 letters as an icon, a **running dot** if any agent runs, a purple badge counting tasks
  **in review and ready to check** (review passed or none, agent not running) and an amber badge
  counting **needs attention**. Collapsed groups and the *N hidden* row roll those counts up.
- Host sub-headings (multi-host only) show an online/offline dot, "· offline" or "· needs update",
  and link to the host's page.
- Drag/Alt+Arrow reorder, groups, pin, hide, archive (README). Screen-reader announcements for
  reorders (`aria-live`).
- Project right-click menu: *Group <name> in* → each existing group (checked), *New group…*, *No
  group*; *Pin to every profile*/*Unpin*; *Hide from sidebar*/*Show in sidebar*; *Archive…*.
  Group menu: *Rename group…*, *Ungroup*, *Pin*/*Unpin*, *Hide from sidebar*.
- Footer: **Usage left** panel (README; collapsible, refresh button, bars filled by what's left, red
  under 10%, amber under 30%, reset countdown, plan name; `components/Usage.tsx`), **"New version ·
  Reload"** when the server serves a newer UI build than the page runs (`uiVersion.ts`), **"N new
  commits · Restart"** (README) which turns into a live build-phase indicator, and Settings.

## 3. Boards (`components/Board.tsx`, `components/BoardControls.tsx`, `boardQuery.ts`)

### Columns and views
- Columns: Backlog, To do, In progress, Needs attention, In review, Ready for merge, Done (README);
  each host's own set of statuses decides which show. **Backlog** is a 40px vertical strip at the
  start until opened (state kept per browser; still takes drops).
- Per-column count, a **+** (new task in that column) on To do and Backlog, and empty-state hints
  ("Drop a task here to start its agent", "…to have its agent merge it").
- Done column ends with an **"N archived"** link that switches to the list view and scrolls to the
  *Archived* section (README covers archiving).
- **Board/List toggle** in every board header (one setting for all boards, per browser). The list
  view has collapsible sections per status, then *Archived*.
- A plain mouse wheel scrolls the kanban sideways when it overflows (unless a column under the
  pointer can still scroll vertically).
- Search, Filter (statuses, task kinds, projects, flags: running/starred/has PR/has reminder) and Sort
  (manual, latest activity, newest, oldest, title, cost) (README). Below 1180px wide they move to a
  row under the header; a filter bar shows "N of M" and removable filter chips.
- Board headers: project name + repo path (+ host name), settings gear, *New task*; group boards list
  their projects as links; a subproject board has a breadcrumb, its branch, a **Thread** button (with
  a running dot) to its own agent, and *New task*; a profile board lists its hosts and project count.

### Card contents (`TaskCard`)
One non-wrapping top row (badges that don't fit are cut; extra words appear only when the card is
≥280px wide, via container queries), then the title, then a footer row:
- Top row, left to right: **key** (`IA-12`, `G-3`, `S-4`); **subproject** badge (done/total, or
  "merged" in green when all merged); **group task** badge; **type** badge (plan/artifact/diagram/scratch,
  plan shows created-task progress); **queued to merge**; **dependency** badge (queued, or how many
  unmerged deps); **fan-out model** badge (CPU icon + the model/config this sibling runs; tooltip names
  the siblings); **review** badge (pulsing "reviewing 1/2", ✓ "reviewed", ⚠ "N issues", "review
  failed/stopped", "review waiting"), which is a button that opens the review thread; **star** and
  **reminder** marks; right-aligned **state + time**: amber "!" when needs attention, a pulsing dot and a
  live **elapsed timer** while working ("Merging since…" during a merge), an hourglass while the agent
  `wait`s, the resolution icon/label for done tasks, else "5m ago".
- Title (greyed for *Won't fix*); an amber box with the **attention reason** (the agent's question,
  the permission it wants, the failure) clamped to 3 lines; the **wait reason** under it while waiting.
- Footer: subproject **Board** icon button, **preview dot** (README), **branch icon** (hover shows the
  branch, click copies it, ✓ flash; dimmed until the worktree is ready), **PR icon** (README), **Asana**
  marks (README), **cost** (`$1.23`, right-aligned).
- A 3px **progress bar** along the bottom edge for subprojects, plans and group tasks.
- Border tint: amber for needs attention, violet while being reviewed; the open task has an accent ring.
- Cards are keyboard-focusable buttons (Enter/Space opens). Not shown on cards: model (except fan-out),
  host, diff size, last message.

### List rows (`TaskRow`)
Status icon, key, title (+ attention or wait reason), then marks, subproject badge + *Board* button,
type/group badges, run state ("working"/"merging"/"waiting"), queued-to-merge, deps, fan-out model,
review, **resolution badge**, preview, branch, PR, Asana, cost and activity time.

### Drag and drop
- Cards and rows drag between columns/sections and reorder within one (manual sort only); a drop line
  in the target column's colour shows where. With another sort, a drop only changes the column (to its
  end). Dropping below a filtered column's last shown card goes after it (README).
- Side effects: into **In progress** sends an empty message to start a never-started agent (if the
  host can run agents); into **Done** sets resolution *Done*; an archived task dropped into Done is
  un-archived (README). Ready for merge, dependencies and queues are server-side (README).
- Optimistic: the board moves the card at once and rolls back with a red dismissible banner on failure.

### Right-click on a card or row
Menu titled "Complete KEY-N as": **Done / Not done / Won't fix** (current one checked; moves it to the
end of Done), then **Star/Unstar**, **Remind me in 1 hour / in 3 hours / tomorrow at 9:00 / next
Monday at 9:00**, **Remind me at…** (date-time + "what for" note dialog), **Clear reminder**. Hosts
before API 19 keep the browser's own menu. The menu is keyboard navigable (arrows, Home/End, Escape).
`components/ui.tsx` `ContextMenu`, `components/Reminders.tsx`

- **No multi-select or bulk actions** anywhere on the boards.

## 4. New task dialog (`NewTaskModal` in `components/Board.tsx`, `taskTokens.ts`, `harnesses.ts`)

The README describes `!model` fan-out and (now outdated) type tabs and a project picker. The dialog is
actually a single **token-driven editor** (IA-220): everything is typed into the description.

- Tokens: **`/type`** (`/task`, `/subproject`, `/plan`, `/artifact`, `/diagram`, `/scratch`),
  **`@where`** (a project key, qualified by host/profile when ambiguous, `@group` for a group task,
  `@none` for a scratch task in no project), **`!model`** (one task per `!`; README), **`^effort`**
  (`^high`, `^default`), **`#KEY-N`** (depends on that task; several allowed). Tokens inside code spans
  are ignored, and all known tokens are stripped from what the agent is given.
- Inline **highlighting** behind the textarea (accent for recognised tokens, amber for unknown ones)
  and an **autocomplete popup at the caret** for the token being typed (arrows, Enter/Tab picks, Escape
  closes just the list; exact match first, then prefix, then label match; up to 8). An `@` that could
  still grow into a longer key is held back so the task doesn't jump projects mid-typing.
- A **"Reads as" row** of chips showing what will be created: type, where, one chip per model (with
  "default model (opus)" when inherited), effort, "after IA-212" for each dependency; each chip's ×
  removes its token (or resets the remembered model/effort). Dashed chips are defaults.
- A clickable **legend** under the editor (`/plan type`, `@IA where`, `!opus model`, `^high effort`,
  `#IA-3 waits for`) inserts a prefix at the caret; the placeholder text changes per type.
- Toggles/controls: **Own git worktree** (code tasks), **Start agent now** (remembered per
  project), agent **config select** when several, **Link Asana task** (README), **Attach files**
  (README), and per-type explanation text (what a group/scratch/plan/subproject task does).
- **Add another** toggle: keeps the dialog open after creating, shows "Created IA-41", and keeps the
  tokens for the next task (or brings back a draft already saved for where the tokens now point).
- **Drafts**: the text, uploaded files, Asana links and a half-made fan-out set are saved per
  project/subproject/group in localStorage as you type, so closing the dialog or reloading keeps them.
- Remembers, per destination, the last model, effort, config, start-agent choice and the last project
  picked on a multi-project board.
- Fan-out details: if some tasks of a set fail to create, the made ones are removed from the text and
  "Made IA-4, IA-5, but not the one with …" offers retrying the rest as part of the same set; it waits
  for Codex model lists to load ("…created once they're in") and refuses fan-out for subprojects, group
  tasks and non-git projects with an explanation.
- Submit button reads "Create task", "Create & start", "Create & queue" (has deps) or "Create & start
  3"; Ctrl/Cmd+Enter submits from anywhere in the dialog.

## 5. Task panel (`components/TaskView.tsx`)

### Modes
- **Side panel** sliding in over the right half of a board (below its header), **expanded** into a
  large dialog (≤1400px) with a backdrop (button, or `&expanded` in the URL), or a full page.
- The same element in both, so expanding keeps thread scroll, terminals and edits.
- Closes on **Escape** (unless typing or a dialog is open) or a **click outside**, except when a field
  in it holds an unsaved draft (composer text, description edit), a dialog/menu is open, or the click
  selected text or navigated. Opening a terminal tab from the side panel auto-expands it.
- Opens on the most useful tab: a plan/artifact/diagram on its document once it's ready, an unstarted
  task on its details (when narrow), otherwise the thread (`openingTab.ts`).

### Header
Breadcrumb (project / group / profile → subproject key → task key) with links back to the board (keeping
the task open beside it), type badge, **title** (double-click to rename; a pin icon when renamed by
hand, click to let it follow messages again; README), **star** toggle, then: subproject **Board**
button with progress, **reminder bell** (README), **Agents** pill (README), **Context** pill (README;
mini bar, amber at 85% of the compaction point, dialog with the `/context` breakdown;
`components/Context.tsx`), the **tabs**, **terminal tool** buttons (green dot when one is open; README),
and **Stop** / "Queued" / **Start**. Expand/collapse and close buttons. Below 880px wide the controls
wrap to a second row and the details become a tab.

### Tabs
`<document type>` (doc tasks), **thread**, **changes** (code tasks), **review** (code tasks, with a
pulsing violet dot while reviewing and an amber one when it found issues or waits), **terminal**,
**details** (narrow only).

### Details sidebar (320px column; a tab when narrow)
- **Status**: every column as a clickable list (moves the task; unlike dragging, moving to In progress
  here doesn't start the agent), running dot, a **Resolution** segmented control (Done / Not done /
  Won't fix) for done tasks, notices for queued-to-merge and waiting-for-dependencies, the attention
  reason, the reminder with its note and *Clear*.
- **Description**: rendered markdown with attachment thumbnails; *Edit* opens a textarea (Ctrl/Cmd+Enter
  saves) that warns if the description changed meanwhile.
- **Asana** (README), **Same prompt** (fan-out siblings with status, model label, running/waiting icon
  and cost, to compare; README), **Tasks** (those a plan or group task created, with "Outside the group"
  listed apart), **Document** (file path with copy), **Scratch** (its folder).
- **Depends on**: list with status icons and "merged" tags, remove on hover, and an "Add a task it
  depends on…" select of unmerged tasks in the project.
- **Preview** URL field with its live dot, **Pull request** URL field with a `#12` link (README).
- **Subproject**: *Make it a subproject* / *Make it a plain task* (only while it has no tasks), *Open
  board*, or for a subproject's task a link to its subproject (README).
- **Worktree**: state (not created / setting up / ready / error / removed), branch, base, path with
  copy, error output, **Set up**, **Tear down…** (dialog: discard uncommitted changes, also delete the
  branch), *Don't use a worktree* / *Use a worktree*.
- **Agent**: host (multi-host), session id, live working timer, wait description, cost, **config**
  (changeable until the agent first starts), **model** (free-text, placeholder shows the inherited
  one), **effort** select, the list of tools **always allowed** for this thread (read-only), created.
- **Delete task** (dialog: also delete its branch, and a subproject's tasks' branches).

### Changes tab (`DiffView`)
- One unified diff of the task's worktree against the merge-base with its base branch, **including
  uncommitted and untracked files** (server `worktree::diff`; first 50 untracked files, 2 MB cap).
- Summary ("7 files changed vs master, +120 −34"), a **Commits** box (`git log --oneline` since the
  merge-base), **Refresh**, and auto-reload when the agent starts/stops or the worktree changes.
- Each file is a collapsible block with +/− counts and red/green line colouring.
- **Not there**: file tree, side-by-side view, syntax highlighting, per-commit or per-file selection,
  staging/reverting, inline comments sent to the agent, or a "commit/push/open PR" button.

### Review tab and review threads (`components/Review.tsx`)
- The task's latest review (README): per-reviewer rows with state and a link to each reviewer's thread,
  summary and issues, and **Review now / Review again** (disabled while the agent runs).
- A review thread opens in the same panel with breadcrumb back to the task, its own Agents/Context
  pills and Stop, and a sidebar: *Reviewing* (task + branch), *Latest review*, reviewer cost/session.
  The composer there asks "Ask the reviewer about its findings…".

### Terminal and terminal tools (`components/Terminal.tsx`, `terminalTools.ts`)
- (README) tmux-backed shell and tools. UI extras: a header with the tool command and cwd, connection
  state, **Restart** (end and start again), **End**/**Close**; an overlay on exit or disconnect with
  **Reconnect** / "Start a new session"; clickable URLs (web-links addon); Ctrl/Cmd+C copies a selection
  (else sends ^C), Ctrl/Cmd+V and Shift+Insert paste; bundled JetBrains Mono with Nerd Font symbols;
  terminals stay mounted across tab switches; xterm loads lazily.

### Document tab (`components/Document.tsx`, `planTheme.ts`, `planAnswers.ts`, `htmlFrame.ts`)
- (README) plan/artifact/diagram rendering, versions, plan questions. UI extras: a **version
  dropdown** ("v3 · 5m ago (latest)" / "(being written)") with *Back to the latest*; **Preview/Source**
  toggle; **copy source**; **download** the file (and the rendered **SVG** for diagrams); diagram
  **zoom** (−, fit, +) and a **Fix** button that sends Mermaid's error to the agent; "Writing…" while
  the agent writes.
- Plans that aren't whole pages are wrapped in the **board's theme** (colours copied from the app),
  with `<ia-html>` embedded sandboxed sub-pages auto-sized to their content and `<ia-question>` turned
  into form fields. The frame keeps its scroll position across reloads as the agent rewrites the file.
- The agent's **latest reply** floats in a small box above the composer under the document, with a
  *Thread* link; the plan's question bar ("2 of 5 questions answered", Reset, **Send answers**; README).

## 6. Thread (`components/Thread.tsx`, `threadModel.ts`, `subagents.ts`)

- **Your messages**: right-aligned bubbles with attachment thumbnails/chips; the board's own prompts
  (review fixes, merge instructions, other agents) are shown in muted italics; a steered message's
  tooltip says it was read mid-turn.
- **Agent text**: GitHub-flavoured markdown (tables, task lists; links open in a new tab), **streamed
  token by token** while the agent writes. Code blocks have **no syntax highlighting**.
- **Thinking** blocks: a collapsed "Thinking" toggle.
- **Tool calls** are grouped in a box; past 6 calls it shows "Show N earlier tool calls". Each row: icon,
  verb and a one-line summary with paths made relative to the worktree ("Ran `npm test`", "Read
  src/a.ts", "Edited", "Wrote", "Searched", "Listed", "Fetched", "Searched web", "Updated todos", board
  tools as "Board create_task “title”", other MCP tools as "server · tool"), a spinner while pending and
  a red × on error. Expanding shows: Bash command; **Edit/MultiEdit as −/+ line diffs**; Write content;
  Codex **ApplyPatch as unified diffs** per file (new/deleted/moved); **TodoWrite as a checklist**
  (✓ ◐ ○); anything else as JSON; plus the result (errors only for edit tools).
- **Subagents** (README): rows with agent type, title, "background" tag, live activity line, "needs
  approval", duration and ✓ / failed / stopped. Expand inline (model, tool-use count, collapsible
  prompt, its own calls, final report), or **open its thread** in place of the main one with a
  breadcrumb (Main thread › parent › this), back arrow or Escape, and **Show in thread**, which scrolls
  to and flashes its row. Nested subagents are supported. The **Agents** pill lists them, running first.
- **Permission cards**: "Claude wants to use <tool>" with the input rendered as above, **Allow**,
  **Always allow <tool> for this thread**, **Deny**; names the subagent that asked (click opens it);
  afterwards collapses to a one-line summary with an allowed/denied tag (README covers the buttons).
- **Project-change and task-deletion cards** in the asking agent's thread (README).
- **Event lines** (info/warn/error, expandable details: setup and status-script output, failures).
- **Turn lines**: "Turn complete · 42.1s · 7 turns · $0.183", "Interrupted", "Ended: error_max_turns".
- **Compaction lines**: "Conversation compacted · 84k → 12k tokens · 3.2s · $0.02", or "Context
  full, conversation compacted"; click to read the summary (README).
- Footer while running: "Working…" or "Waiting: <reason>" (tooltip: until when, which tasks or command).
- **Paging** (API 56): long threads load the latest page and fetch older pages as you scroll up
  ("Load earlier messages", retry on failure), keeping what's on screen in place. Auto-scroll follows
  the end only while you're within 80px of it.
- **Questions**: `request_user_input` has **no dedicated answer card**: it appears as a "Board
  request_user_input <question>" tool row, the question becomes the card's amber attention reason, and
  you answer by replying in the composer. Plan mode's `ExitPlanMode` and Claude's `AskUserQuestion` are
  likewise not specially rendered (a permission card with JSON input). Structured questions exist only
  inside plan documents (`<ia-question>`).
- **Images** in tool results (screenshots, image Reads) are not shown: results are reduced to text.
- No message actions: no copy, edit-and-resend, retry, fork, rewind/checkpoints or thread export.

## 7. Composer (`Composer` in `components/Thread.tsx`, `components/SkillMenu.tsx`, `components/Attachments.tsx`)

- Auto-growing textarea (to 260px). **Enter sends**, Shift+Enter adds a line, **Shift+Tab cycles the
  permission mode** (README). An empty Enter on an unstarted task starts it with just the description.
- **Permission mode dropdown** under it, colour-coded per mode with icons and descriptions, plus
  "Reset to project default (Ask)" / "Using host default"; notes that changes apply from the next
  message (README covers modes).
- Info line: "session 1a2b3c4d · claude-opus-5-5 · high effort" (or "new session"). **No model or effort
  picker in the composer**: those are in Details → Agent.
- **`/` skills menu** (`$` for Codex; README) with a loading state, a one-minute cache, and once a
  command is typed a hint line describing what it does.
- **Attachments** (README): paperclip, paste or drop; uploading chips; image thumbnails that open a
  full-size lightbox; other files as download chips.
- Above the textarea: **steered messages** waiting to be read (spinner, "Sent:" or "From another
  agent:"), and the **queued message** with an × to take it back into the composer for editing (README).
- Buttons: send (arrow), **queue/steer** while running, and **Stop**; placeholders change with the
  state ("Message the agent: it reads it after its current step…", "Queue a message for when its agent
  starts…", "Add extra instructions, or press Enter to start").
- **Drafts per task** are saved in localStorage as you type (text and uploaded files), so switching
  tasks or reloading keeps them; if storage is full it warns that the draft lasts only until reload. A
  send in flight is tracked outside the composer, so text typed while sending is kept and only what was
  sent is removed, even if you switched away meanwhile.
- No `@file` mentions or file picker from the worktree, no prompt history, no voice input.

## 8. App-wide approval dialog (`components/Approvals.tsx`, `approvals.ts`)

- (README) Project-setting changes and task deletions requested by agents pop up as a modal over
  whatever page you're on, from any host. UI extras: "1 of N" counter, a per-setting old → new view with
  the agent's reason, **Approve / Deny** (or **Delete / Don't delete**), **Decide later** (hides it
  until it's asked again; it stays in the thread) and **Open thread**.

## 9. Settings

### Settings page (`/settings`, `components/Settings.tsx`), in order
1. **Hosts** (`components/Hosts.tsx`): each host's name, online dot, mode, URL, "last seen", "board
   only (can't run agents)", version/API/commit, compatibility badge (Outdated / Too old / Board too old)
   and **Update to <commit>** with live phases (README); **Configure**, **Rename**, **Remove**.
   **Add host** has two tabs: **Over SSH** (not in the README: SSH target, SSH port, path to `huntaway`
   on that machine, host port; the board shows a restricted `authorized_keys` line for its own key,
   then starts `huntaway` there if needed and tunnels to it, with the host listening only on its
   localhost) and **By URL and token** (README). **Connect from elsewhere** shows the dial-out command
   and this host's token for another board (README). **Scratch task host** select on board-only hubs.
2. **Agent configs** (`components/ClaudeConfigs.tsx`): grouped by name across hosts; add (host, name,
   agent Claude/Codex, directory), edit, delete (warns which profiles use it), **Show usage**, **Copy
   login** to another host (README), and adding the same-named config on hosts missing it.
3. **Profiles**: merged by name with a row per host; edit form (host, name, default model, ordered
   agent configs, GitHub account, clone folder, Asana toggle and token, agents from other profiles)
   (README for each field); Copy login.
4. **Skills and MCP servers** (global; `components/AgentTools.tsx`): per-profile default on/off, add a
   skill by pasting `SKILL.md`, add an MCP server as stdio (command, args, env), HTTP (URL, headers) or a
   raw `.mcp.json` entry, "allow all tools" per server, filter when the list is long (README).
5. **Archived projects** with Unarchive (README).
6. **Server**: running commit, source checkout and branch, commits ahead, **Rebuild & restart** dialog
   with the new commits listed, running-agent count, warnings for a dirty or non-master checkout, a
   "Rebuild before restarting" toggle, a streamed build log and an automatic page reload once the new
   process is up (README describes the action; `components/Server.tsx`).
7. **Network access**: the board URL with token (masked, Reveal, Copy), data directory and version.

### Host page (`/hosts/<id>`, `components/HostPage.tsx`)
Mode, URL, version and update; **Agent defaults** (model with "Specific model…", effort, permission
mode; README); agent configs and profiles on this host; **Terminal tools** (name + command rows;
README); **Server** (local: as above; a linked host: Rebuild & restart or plain Restart, polled log);
**Remove from board**. Offline hosts show "settings can be changed once it reconnects".

### Project settings (`/p/<id>/settings`)
All on one form with **Save changes** (only edited fields are sent, so concurrent agent edits survive):
name, key (shows former keys), repository path (+ *Move the folder there*), group (with suggestions),
base branch, model, **Use its own agent configs**, GitHub account, permission mode, reviews (toggle,
fix rounds, reviewers with config/model/effort), **Prompts** (each shows Default/Custom and *Reset to
default*), skills and MCP servers (saved immediately), worktrees (toggle, folder, setup and teardown
scripts with variable hints, **Remove merged worktrees** with a per-task removed/kept report), status
scripts (any column + per column), scratch folder (read-only), **Archive project**, **Delete project**.
All of these are README features; the page itself isn't described there.

### Add project dialog (`NewProjectModal`, `components/GithubRepos.tsx`)
(README) Folder / GitHub tabs. UI extras: the **folder picker** browses the host's filesystem as you
type (Tab completes, arrows pick, `~/` expands, git repos marked, "New folder. It's created when you
add the project."); host and profile selects; a config-directory field when the profile doesn't exist
on that host yet; the repo list marks forks, private and archived repositories.

## 10. Analytics (`components/Analytics.tsx`, `components/DiskUsage.tsx`)

(README) Report, Calendar and Disk tabs. UI extras: range presets (today, yesterday, this/last week,
this/last month, last 7/30 days, custom), headline tiles (active time, prompts and how many typed, tasks
touched, agent time and run count), per-day stacked chart or a single-day timeline, a by-project/task
table, a collapsible prompt log, month/week calendar grids with prev/next and a day detail panel, a
break threshold and first-prompt credit as inputs, CSV download; Disk shows tiles, a per-project stacked
bar (repo, worktrees, agent runs, scratch) and a worktree table where reclaimable ones are italic and
open their task. Tab, range and rules are remembered per browser.

## 11. Notifications and attention

- **None of**: browser/desktop notifications, sounds, a tab-title or favicon badge (the title is always
  "Huntaway"), an app badge, an inbox, or email/push. Electron adds none either.
- What there is instead: sidebar amber "needs attention" and purple "ready to check" counts per
  project/group, per-profile status bars, running dots, due-reminder count, the app-wide approval
  modal, the "New version · Reload" and "N new commits" buttons, and card colouring. Project **status
  scripts** (README) are the hook for external notifications.

## 12. Keyboard

| Key | Where | Does |
|---|---|---|
| `/` | any board | Focus the search box (README); Escape clears, then leaves it |
| Escape | task panel | Close it (after leaving a subagent's thread, an open menu or popover first) |
| Enter / Space | focused card or row | Open the task (cards are Tab-focusable) |
| Enter, Shift+Enter | composer | Send / new line |
| Shift+Tab | composer | Cycle Ask → Accept edits → Auto → Plan (README) |
| `/` or `$` at start | composer | Skills menu: arrows, Enter/Tab, Escape (README) |
| `/ @ ! ^ #` | new task dialog | Token autocomplete: arrows, Enter/Tab, Escape closes the list |
| Ctrl/Cmd+Enter | any dialog, description editor | Submit / save |
| Escape, Tab | dialogs | Close; Tab is trapped inside the top dialog and focus returns afterwards |
| Arrows, Home/End, Escape | right-click menus | Move, close |
| Alt+Up/Down | sidebar grip | Reorder projects (README) |
| Double-click, Enter/Escape | task title | Rename / save / cancel |
| Tab, arrows, Enter | folder picker | Complete, pick |
| Ctrl/Cmd+C, Ctrl/Cmd+V, Shift+Insert | terminal | Copy selection (else ^C), paste |

No global shortcuts for new task, switching boards or tasks, and no command palette or shortcut help.

## 13. Appearance and layout

- **Dark theme only** (`color-scheme: dark`, fixed palette in `index.css`); no light mode, theme
  picker, font-size or density setting. Inter/system UI font, bundled JetBrains Mono for code.
  Status colours: grey to do, blue in progress, amber attention, violet review, pink merge, green done.
- Responsive behaviour is limited to: the task view moving details into a tab and wrapping header
  controls under 880px; board controls moving to a second row under 1180px; card badges dropping their
  words under 280px card width. The **sidebar is a fixed 240px column with no collapse**, the side
  panel is a fixed half width, and columns are 240px minimum, so phones and narrow windows are cramped;
  there's no mobile layout, PWA manifest or service worker. Electron's minimum window is 900×600.
- Accessibility touches: focusable cards, ARIA menus/dialogs/listboxes, focus trap and return in
  dialogs, screen-reader text for reordering.

## 14. Live updates, offline and versions (`store.ts`, `uiVersion.ts`)

- One websocket carries events from every host (task, project, message, streamed delta, usage,
  settings, restart progress, resync). Updates are applied in place; open threads append messages.
- On disconnect: the sidebar dot turns red and pulses; reconnects with exponential backoff (1s up to
  32s); on reconnect it reloads everything and re-fetches open threads from their oldest loaded message.
  A per-host `resync` event does the same for a host that reconnected to the hub.
- Terminals reconnect and tmux repaints; preview dots pause polling while the tab is hidden.
- The UI notices a **new UI build** on the server (on focus, after reconnecting, every 5 minutes) and
  offers *Reload*; after a server restart it reloads itself once the new process answers.
- No offline mode: nothing works without the server, but drafts (composer, new task, plan answers) are
  in localStorage and survive.

## 15. Multiple hosts in the UI

Sidebar projects grouped under host headings with online state and "needs update"; host name in project
headers, the profile board header, the new task `@` hints and Details → Agent; a profile board's New task
only offers projects on connected hosts; Settings → Hosts and per-host pages for defaults, configs, profiles,
terminal tools, restart and update; Copy login between hosts; features hidden per host by API version
(README covers the model).

## 16. What the browser remembers (localStorage / sessionStorage keys `ia.*`)

Token; active profile; project order, collapsed groups, hidden and pinned projects; collapsed sidebar
sections; board view (board/list), sort, backlog and archived open state; each board's search and
filters (per tab); composer drafts per task; new-task drafts, model, effort, config, start-agent choice
and last project per destination, "Add another"; plan answers per task; open terminal tools (per tab);
Add-project tab; usage panel open; Analytics tab, range, calendar mode and rules. None of this syncs
between browsers or machines.

## 17. Electron shell (`app/electron/main.cjs`)

- One `BrowserWindow` (1440×900, min 900×600, dark background, auto-hidden menu bar, sandboxed, context
  isolation) that loads the UI **from the server** with `?token=` (README covers local/remote modes).
- Local mode: reuses a healthy server on the port (reading the token from the data dir) or spawns
  `huntaway serve` (from `IA_SERVER_BIN`, `serverBin`, the packaged resources, or `server/target/{release,debug}`),
  waits up to 15s for its `IA_READY` line, and SIGTERMs it on quit (agents survive under `ia-shim`).
- Links that open new windows go to the system browser. A failure shows an error page naming the
  config file. Keeps the old "Issue Agent" user-data folder and config path after the rename.
- `IA_DEV_URL` (`npm run electron:dev`) loads the Vite dev server.
- **Not there**: tray icon, native notifications, dock/taskbar badge, deep links or a URL protocol,
  multiple windows, native menus, global shortcuts, auto-update. AppImage packaging (`npm run dist`)
  is "not exercised yet" (README). Header bars carry `-webkit-app-region: drag` classes for a frameless
  window, but the window is created with the standard frame.

## 18. Gaps, quirks and README drift (useful for the T3 Code comparison)

- README drift: it describes type tabs (*Plan*, *Subproject*…) "at the top of the New task form" and a
  project picker (*Group task*, *No project*); the current dialog does both with `/type` and `@where`
  tokens and the "Reads as" row. `^effort` and `#dependency` tokens aren't in the README at all, nor is
  adding a host **over SSH**, the side panel/expanded modes, composer drafts, or task resolutions as a
  card menu.
- No structured question UI for `request_user_input`, `AskUserQuestion` or `ExitPlanMode` (plan
  approval shows the plan as JSON in a permission card); the permission card says "Claude wants to use"
  for Codex agents too.
- Diff view is read-only and basic (no file tree, highlighting, comments to the agent, or git actions).
- No syntax highlighting in thread code blocks; tool-result images aren't displayed.
- Model is a free-text field in Details (effort is a select); the composer shows but can't change them.
- "Always allowed" tools for a thread are listed but can't be revoked from the UI.
- Moving a task to In progress from the Details status list doesn't start its agent (dragging does).
- No notifications of any kind, no mobile layout, no light theme, no command palette, no bulk actions,
  no thread search, no message copy/fork/retry/checkpoints.
- Logging a config in (Claude or Codex) isn't possible from the UI: it's done on the host's CLI (or by
  Copy login from another host).
