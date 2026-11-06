# T3 Code: threads, the composer and the web/desktop UI

Part of the T3 Code inventory: [t3code-overview.md](t3code-overview.md) has the summary and links the other areas.

Scope: what a user sees and does in the main web and desktop UI while working with agents. Source control and review (diffs, PR pages, git actions) and remote access, mobile and devices are covered in other files and only appear here where the UI touches them.

Source: shallow clone of `pingdotgg/t3code` at commit 9b1d351 (2026-10-30, release v0.1.5). Paths are relative to the repository root. "(from code)" marks things found only in source, not in `docs/`. Labels in **bold** are the UI's own strings.

Vocabulary used by T3 Code (`docs/internals/glossary.md`):
- **Environment**: one running T3 server and the machine it owns. Clients (web, desktop, mobile) connect to one or more environments.
- **Project**: a workspace rooted at a directory on an environment.
- **Thread**: the durable conversation with an agent. **Turn**: one user-to-agent cycle. **Activity**: a non-message timeline item such as a tool call or an approval.
- **Runtime mode**: the permission policy. **Interaction mode**: for example plan vs build.
- **Checkpoint**: a hidden git ref used for diffs and restore.

---

## 1. How work is organised

### Projects
- **Adding a project.** From the sidebar's **Add project** button, or from the command palette:
  - **Add existing project**, by browsing directories with path completion in the palette.
  - **Clone** a git URL, choosing where to clone it.
  - **New project**, which runs `git init` on an empty folder.
  - **Open WSL folder** on Windows.
  - Code: `apps/web/src/components/CommandPalette.tsx`, `CommandPaletteAddProject.tsx` (from code).
- **Starting folder.** **Add project starts in** under Settings → Threads sets where the browser starts (`components/settings/SettingsPanels.tsx`, from code).
- **Project grouping.** On by default (Settings → General → Sidebar). Checkouts of the same repository on different environments are combined into one logical project (`sidebarProjectGrouping.ts`, from code).
- **Project icons.** Automatic favicon detection, or a chosen icon, emoji, monogram or image. Without one the project gets a two-letter coloured monogram, e.g. `Nebula` → `NA` (`docs/user/project-settings.md`, `ProjectMonogram.tsx`).
- **Project settings.** Settings has a project/environment scope sentence that lets you override settings per project. A project also has **Actions** (scripts, which `t3.json` can define). See `docs/user/project-settings.md`.
- **Threads without a project.** A thread can start with no project:
  - Ways to start one: **or start without a project** in the new-thread heading, **No project** in the project menu, **New thread without a project** in the palette, or `mod+alt+n`.
  - Each such thread works in its own folder, `~/.t3/scratch/<date>-<first-words>-<id>`. It has no branch, worktree or diff controls.
  - **Turn into project** (thread menu) converts that folder into a project in place.
  - Source: `docs/user/thread-sidebar.md`.

### Threads and their states
A thread is in exactly one sidebar section: **Pinned**, **Active**, **Working** (beta, on by default), **Snoozed** or **Settled**. Archived and deleted threads leave the list. Source: `apps/web/src/components/Sidebar.logic.ts` (`SidebarSection`).

- **Pin.** From the thread menu, `mod+shift+p`, or by dragging the thread into the pinned section. Pins keep a manual order, and that order is saved on the server.
- **Settle** ("finished, but keep it"):
  - Settling moves the thread to the collapsed **Settled** shelf.
  - Manually settling an idle thread dismisses its unanswered async questions. It also closes the thread's terminals that sit idle at a prompt (keeping their output); a terminal still running a command, such as a dev server, stays open.
  - **Un-settle thread** brings it back to the top of the active list.
  - Shortcut: `mod+shift+s`. Settling or snoozing the open thread moves you to the next thread (`settleAndAdvance.ts`, `shouldNavigateAfterThreadPark`, from code).
- **Auto-settle.** Runs on the server even when no client is open:
  - Defaults: **Auto-settle inactive threads** after 3 days (range 1–90) and **Auto-settle merged threads**. A closed PR can also settle an idle thread.
  - **Keep threads with a PR** (off by default) stops threads with an open PR from settling for inactivity.
  - Work in progress, pending approvals and background work the agent is waiting on all prevent auto-settle.
  - Per thread: **Auto-settle behavior → Enabled/Disabled**.
  - Settings → Threads lets you set the rules per environment or for **All environments**.
  - A project action marked **Run in the thread's worktree when the thread settles** (`"runOnSettle": true` in `t3.json`) runs when a thread settles, for example `cargo clean`.
  - Source: `docs/user/thread-sidebar.md`.
- **Snooze.** Hides a thread until a wake time:
  - The **Snooze** menu lists presets (default 1h, 3h, today 18:00, tomorrow 09:00, Monday 09:00; at most 8) and **Custom…**, which takes a date/time or a duration.
  - A snoozed thread keeps working while hidden. It comes back early when it needs an approval or answer, when a run fails, or when you send it a message.
  - Rows that came back early show a **Woke** marker, which you can dismiss. **Wake thread** ends the snooze.
  - Sources: `docs/user/thread-sidebar.md`, `SnoozePresetsSettings.tsx`, `CustomSnoozeDialog.tsx`.
- **Archive.** **Archive thread** is disabled while the thread is running. Archived threads are listed in Settings → **Archive**, grouped by project, with **Unarchive** and **Delete**.
- **Delete.** Permanently clears the conversation history. Confirmation is on by default (Settings → General → Confirmations).
- **Undo.** Unpin, settle, snooze, archive and discarding a draft each show a 5-second **Undo** notice at the bottom of the sidebar.
  - `mod+z` (`thread.undo`) triggers the most recent undo, even from the composer right after the action.
  - Consecutive actions of the same kind undo together.
  - Source: `docs/user/keybindings.md`, `sidebar/SidebarThreadUndoNotice.tsx`.
- **Usage-limit stops.** A thread stopped by a provider's usage limit shows **Limited**. It offers:
  - **Resume at reset**, which schedules a continuation (on by default with **Resume after usage limits**).
  - **Snooze until reset**, **Wake now**, **Cancel auto-resume**.
  - Queued messages wait until the continuation finishes.
  - Source: `docs/user/thread-sidebar.md`, `chat/UsageLimitRecoveryBanner.tsx`.

### Starting threads
- **New thread.** The new-thread "draft hero":
  - Asks **What should we work on?** or **What should we build in `<project>`**, with a project picker heading (`chat/DraftHeroHeadline.tsx`, `DraftHeroProjectHeading.tsx`).
  - Below the composer are **Workspace** (current checkout or **New worktree**), base branch, and **Run on** (machine, or **Auto balance** across machines).
  - A new thread keeps the current project and model unless the project has a default model.
  - Shortcuts: `mod+n` / `mod+shift+o` (`chat.new`, may ask which project), `mod+shift+n` (`chat.newLocal`, skips that chooser), `mod+alt+n` (no project).
- **Drafts.** Unsent drafts are their own route (`/draft/$draftId`). They appear in the sidebar as **Unsent draft** rows showing the first line or "N attachments". **Discard draft** can be undone. Drafts persist in browser storage across reloads (`sidebar/SidebarDraftBlock.tsx`, `composerDraftStore.ts`, from code).
- **Start in background.** `mod+enter` (or `mod+alt+enter`) in a new-thread composer starts the thread and opens a fresh draft, keeping the workspace mode and base branch. Each submission gets its own worktree when **New worktree** is selected. In an existing thread, `mod+alt+enter` sends and opens a new-thread composer (`composer.sendAndNewThread`). Source: `docs/user/thread-sidebar.md`, `docs/user/keybindings.md`.
- **One prompt, several models.** In a new thread, **Shift-click** models in the model picker to select several. **Choose models** then starts one thread and one worktree per model ("Each model starts in its own worktree."). This needs a git project. Source: `docs/user/thread-sidebar.md`, `chat/useMultipleModelSend.ts`.
- **New thread in this worktree / New thread on `<branch>`.** Available from the branch toolbar and the thread menu, to continue in an existing worktree.
- **Implement a plan in a new thread.** Offered from a proposed plan's **Implement** split button (see 3.5).
- **Prompt links.** `https://app.t3.codes/new?prompt=…&repo=…&provider=…&model=…&pr=…` opens a pre-filled draft and never runs anything:
  - With `repo`, it uses your most recent project for that repository, or offers **Clone** / **Use without project**.
  - With `pr`, it opens the thread linked to that PR, or drafts on the PR branch in a new worktree.
  - Invisible characters (zero-width, tag characters) are stripped with a warning.
  - **Copy prompt link** and **Copy prompt link with repo and model** are in the palette, and sent messages have a **Copy prompt link** button.
  - Source: `docs/user/prompt-links.md`, `components/promptLinks/`.
- **Triage an issue** (palette). Opens a no-project thread whose prompt links a triage playbook, so your own agent can investigate a T3 Code problem (`docs/user/triage.md`).
- **Desktop app as the macOS default browser.** A link opened from another app starts a no-project thread with the browser panel maximised on that page (`docs/user/default-browser.md`).
- **Window capture.** SnapShots (a desktop window capture, off by default) starts a draft in the current project if no thread is open (`docs/user/snap-shot.md`).

### The thread sidebar
Source: `apps/web/src/components/Sidebar.tsx`, `Sidebar.logic.ts`, `sidebar/*`, `docs/user/thread-sidebar.md`.

- **Chrome.**
  - Back/forward buttons, **Toggle main sidebar** (`mod+b`), and links to **Pull requests**, **Usage** and **Settings**.
  - **New thread** and **Add project** buttons.
  - A **Search threads** box, a project filter (**Filter threads by project**, multi-select with **All projects**), and an update pill and **Update everything** dialog for the app, servers and providers (`sidebar/SidebarChrome.tsx`, `SidebarThreadHeader.tsx`, `sidebar/UpdateEverythingDialog.tsx`).
- **Row content** (card rows):
  - Title, status label, relative time.
  - Branch with a worktree indicator (for no-project threads, the machine name instead).
  - A running-terminal indicator and a PR badge (state colour; a stack shows its layer count; `+N` when several PRs are linked).
  - `+insertions −deletions` of the latest run's diff.
  - A remote-machine icon, and a stack of the provider icons the thread has used.
  - Source: `sidebar/SidebarThreadRow.tsx`, `ThreadStatusIndicators.tsx` (from code).
- **Hover card on a row.**
  - Title, project, environment and branch, with a warning when the checkout's current branch differs from the thread's.
  - Terminal process count, model, providers used before, and the list of linked PRs.
  - Source: `sidebar/SidebarThreadRow.tsx` (from code).
- **Status labels** (`resolveSidebarThreadStatus`, `resolveThreadStatusPill`, from code):
  - **Approval** / Pending Approval: amber.
  - **Input** / Awaiting Input: indigo.
  - **Request**: a guest message waiting for the owner.
  - **Working**: pulsing, with a live elapsed timer.
  - **Connecting**: preparing, starting or queued.
  - **Waiting**: blocked on another thread or on background work.
  - **Failed**: red.
  - **Limited**: usage limit.
  - **Plan Ready**: violet.
  - **Done** / Completed: emerald, only while unseen.
  - **Woke**: came back from a snooze.
  - Rows that are working or already seen recede visually (`shouldRecedeSidebarThread`).
- **Unread state.**
  - A completion is "unseen" until you open the thread.
  - The visit watermark is stored on the server, so read state syncs across devices.
  - **Mark unread** rewinds it, for a single thread or a multi-selection.
  - Source: `chat/ThreadVisitWatermark.tsx`, `Sidebar.logic.ts` `hasUnseenCompletion` (from code).
- **Ordering.**
  - New threads appear above your arranged active threads. Agent activity does not reorder the list.
  - Drag within Pinned or Active to reorder. The order is saved on the server, so it shows on other devices.
  - **Move up** / **Move down** are in the thread menu.
  - With the **Working section** on, the active list is ordered by when each thread last "came back to you", and manual reordering is disabled.
  - Settings → General → **Project order**: Last user message (default), Created at, Manual.
- **Working section (beta, on by default).** Threads that are working, or waiting on subagents, watched PRs or background commands, fold into a collapsed **Working** section and return to the top when they finish, fail or need you (`docs/user/thread-sidebar.md`).
- **Boring sidebar (Labs, off by default).**
  - Groups active threads into one folder per project. A closed folder shows a count and a dot when a thread needs you.
  - The pen button on a folder starts a thread in that project.
  - **Two-line folder rows** (Labs) add a branch, PR and agent line.
  - Dragging and the Working section are off in this mode.
  - Source: `components/settings/LabsSettingsPanel.tsx`, `sidebar/SidebarProjectFolderHeader.tsx`.
- **Drag and drop.**
  - Drag between sections to **Pin**, **Unpin**, **Settle**, **Un-settle** or **Wake**. The dragged row shows the verb and other rows slide aside.
  - Press a row's **Settle** / **Un-settle** / **Wake** button and drag up or down to apply it to every thread in the range (`Escape` cancels).
  - Drag files from the OS onto a row: the thread opens with the files attached.
  - Drag a thread (or a multi-selection) onto a composer to attach it as context.
  - Source: `Sidebar.drag.ts`, `Sidebar.pointer.ts`, `docs/user/thread-sidebar.md`.
- **Multi-select.** Modifier-click rows (from code). Bulk actions: **Settle (N)**, **Snooze (N)**, **Mark unread (N)**, **Delete (N)**, bulk **Regenerate title** and bulk unpin (`Sidebar.tsx`, `Sidebar.logic.ts`, from code).
- **Search.**
  - The sidebar search ranks title, branch and PR matches first.
  - Threads whose messages match are listed after them (**Searching thread messages…**), and open at the matching message.
  - Source: `Sidebar.logic.ts` `searchSidebarThreads`.
- **Number hints.** Holding the modifier for 200 ms shows number hints for `mod+1…9` thread jumps. These are desktop-only by default (`useThreadJumpHintsVisible`, from code).
- **Keyboard.**
  - Tab enters the list. Up/Down move between rows, Enter opens, Left/Right fold groups.
  - `F2` renames. `Shift+F10` or the Menu key opens the row menu.
  - `mod+shift+[` / `mod+shift+]` go to the previous/next thread.
  - Source: `docs/user/keyboard-focus.md`.
- **Motion.** Section changes animate, respecting reduced motion. Pin/unpin keeps the scroll position.

### Thread action menu
Right-click a row, or use the row's menu button. Source: `components/threadActionMenu.logic.ts`.
- **Find in thread**
- **New thread on `<branch>`**
- **Pin / Unpin thread**
- **Settle / Un-settle thread**
- **Snooze** (presets, **Custom…**) / **Wake thread**
- **Rename thread** (also double-click the title, or `F2`)
- **Regenerate title**
- **Mark unread**
- **Share with guest** (guest links: a viewer who watches live and sends messages you approve; Labs, needs T3 Connect)
- **Filter by `<project>`** / **Show all projects**
- **Turn into project** (no-project threads, disabled while running)
- **Auto-settle behavior → Enabled / Disabled**
- **Copy → Path / Branch / Thread / Thread ID**. A copied **Thread** pastes into a composer as a thread chip.
- **Project settings**
- **Archive thread**
- **Delete**
- Draft rows get **Discard draft**, **Copy**, and **Project settings**.

### Thread titles
- **Automatic titles.** Generated by the **Text generation model** (Settings → Threads).
- **Thread title instructions.** Under Advanced, per environment or per project (e.g. "Keep titles to a few words"). They apply to new and regenerated titles.
- **Regenerate title.** In the thread menu; works in bulk too.
- **Agent edits.** Agents can rename threads and link or unlink PRs through T3's MCP tools, and the change shows on every client.
- Source: `docs/user/thread-sidebar.md`, `settings/ThreadTitleInstructionsSettings.tsx`.

### Subagents, forks and orchestration (UI side)
- **Subagents.** A provider's subagents, and tasks delegated with T3's `delegate_task` tool, become their own child threads.
  - The parent's timeline shows subagent rows with **Open subagent thread**.
  - A subagent thread's composer is replaced by a bar showing model, effort, live status, "Runs on its own" and **Open parent**. Subagent threads can't take messages; their approvals and questions surface in the parent.
  - **Stop** on a parent also stops its subagents.
  - Source: `docs/user/thread-sidebar.md`, `chat/ProviderSubagentBar.tsx`.
- **Fork from this response.** A button on an assistant response copies the conversation up to that point into a new thread with the same setup. The fork shows "Forked from conversation" with **Open source conversation**.
  - **Merge back to source conversation** sends a summary of the fork's new work back to the parent; this needs a completed run in the fork.
  - Source: `chat/TimelineAssistantRows.tsx`, `chat/ThreadRelationshipsControl.tsx`, `apps/server/src/mcp/toolkits/thread/tools.ts`, `docs/internals/context-handoffs.md` (from code; the user docs barely mention forks).
- **Lineage / Related threads.** The thread details card lists:
  - Parent agent, subagents and forks, and a context-transfer history.
  - **Previous agents**, when the thread switched provider.
  - **Stop entire workflow**.
  - Source: `chat/ThreadRelationshipsControl.tsx`, `ThreadLineageWorkflowRow.tsx` (from code).
- **T3 Orchestrator.** Agents get MCP tools to create, read, search, message, wait on and interrupt other threads. Examples: `create_threads`, `t3_thread_send`, `t3_thread_wait`, `delegate_task`, `schedule_task`, `t3_worktree_handoff`, `request_secret`.
  - Their tool calls render as summaries such as "Ran 2 commands and sent messages to 3 threads".
  - Source: `apps/server/src/mcp/toolkits/*/tools.ts`, `docs/user/activity-log.md`.

### Layout: one thread at a time, plus panels
- **Main view.** One thread at a time:
  - Breadcrumb header (project › thread title, renamable inline).
  - The timeline, with the composer docked at the bottom.
  - An optional **thread details card / panel** (`mod+shift+b`).
  - A tabbed **right panel** and a per-thread **terminal drawer**.
  - Source: `chat/ChatHeader.tsx`, `ChatView.tsx`, `rightPanelStore.ts`.
- **Right-panel tab kinds.**
  - **Browser** (preview), **Terminal**, **Files** / file, **Diff**, **Pull request**, **Linked pull requests**, **Device**.
  - Tabs can be reordered, renamed, closed (**Close others**, **Close to the right**, **Close all**), and browser tabs muted.
  - **Maximize panel** (`rightPanel.toggleMaximized`) is available. `mod+t` adds a tab, `mod+w` closes one, and `mod+shift+t` reopens the last closed tab of any kind.
  - Source: `components/RightPanelTabs.tsx`, `ReopenClosedViewShortcut.tsx`.
- **Floating preview.** A mini-player that floats a browser or device preview over the chat canvas. Controlled by **Auto-show floating preview** in Settings → Browser (`preview/ThreadPreviewMiniPlayer.tsx`, `chat/chatCanvasLayout.ts`, from code).
- **Proactive panels** (Settings → Diffs & pull requests, off by default). Opens linked PRs automatically, or opens Changes once edits reach 3+ files or 50+ lines.
- **Other top-level pages.** **Pull requests** (`/pull-requests`, covered elsewhere), **Usage** (`/usage`), **Settings** (route modal), `/welcome`. Source: `apps/web/src/routes/`.
- **Not present** (from code): no kanban or board view, no inbox page separate from the sidebar sections, and no side-by-side view of several threads on web/desktop. The closest equivalents are the sidebar sections, the Working section and the subagent/lineage links. On iOS a subagent thread can open beside its parent.

---

## 2. The composer

### Editor
- **Rich text editing.** The composer is a Tiptap editor that stores Markdown (`ComposerPromptEditorTiptap.tsx`, `docs/internals/composer-editors.md`).
  - **Rich text composer** (Settings → Chat, on by default) shows Markdown styled as you type. Markers such as `**` stay in the text and are what the agent receives.
  - Lines starting with `- `, `1. `, `- [ ] `, `> `, `# ` or `---` become blocks. ` ``` ` + Enter opens a code block with a language picker; syntax highlighting is skipped for very large blocks.
  - Plain mode keeps every marker literal.
- **Editing keys.**
  - Enter sends. Shift+Enter continues a list or quote; on an empty item it moves out a level.
  - Tab nests list items. In code blocks, Tab and Shift+Tab indent the selection, and Backspace at the start unwraps the block.
  - Tiptap's own block chords are removed, so the Markdown round-trips exactly.
  - Source: `docs/user/composer.md`.
- **Send shortcut** (Settings → Chat): **Enter**, **⌘/Ctrl+Enter for multiline prompts**, or **⌘/Ctrl+Enter always**.
- **Right-to-left text.** Arabic, Hebrew and similar lines lay out right-to-left per block, while code blocks stay left-to-right (`composer-text-direction.ts`, from code).
- **Message size.** Up to 120,000 characters. Longer drafts stay in the composer with a validation message (`packages/contracts/src/chatAttachment.ts`, `ComposerPromptLengthValidation.tsx`).
- **Large pastes.**
  - A paste of 32 KiB or more becomes a text-file attachment instead of inline text.
  - `Cmd/Ctrl+Shift+V` pastes as editable text instead.
- **Paste or type from anywhere.** A paste or keystroke made while focus is in the timeline (not in another field) goes to the composer (`chat/usePasteToFocusComposer.ts`, `composerFocusRedirect.ts`, from code).
- **Recall sent prompts.** ArrowUp in an empty composer walks back through prompts sent in this thread, and ArrowDown walks forward. Only the text comes back, not the attachments.
- **Prompt stash.** `mod+s` saves the draft and its attachments and clears the composer.
  - With an empty composer, `mod+s` restores the stash, or opens the stash menu when there are several.
  - Stashed uploads are kept for 24 hours.
  - Source: `docs/user/composer.md`, `chat/ComposerStashMenu.tsx`, `promptStashStore.ts`.
- **Edit from here** (under a sent message) rewinds the conversation to before that message:
  - **Revert and keep changes**, or **Revert files too**, which restores the checkpoint. File restore is only offered for worktree threads that no other session shares.
  - The prompt and its attachments come back into the composer.
  - Needs provider rewind support.
  - Source: `docs/user/composer.md`, `chat/useTimelineRewind.ts`.
- **Typing guard.** An approval or question that arrives while you are typing is held until you pause for 1.5 s, so keystrokes don't answer it by accident (`chat/composerTypingGuard.ts`, from code).

### Sending while the agent works: queue, steer, interrupt, resume
- **Follow-up behavior** (Settings → Chat): **Steer** (default) or **Queue**.
  - The send button shows which one it will do.
  - `mod+enter`, or Cmd/Ctrl-click on the button, does the opposite for one message.
  - Source: `docs/user/composer.md`, `chat/ComposerPrimaryActions.tsx`.
- **Queued messages.** They are stored on the server and appear as dashed rows at the end of the thread.
  - Each row has **Send now** (steers it in), edit (pencil, opens it in the composer: "Editing in the composer", ✓ saves in place) and **Remove from queue**.
  - `mod+shift+enter` sends the first queued message as a steer (`thread.steerQueuedMessage`). `Alt+Up` at the start of the composer edits the last queued message.
  - Sent messages are labelled **Steered the active turn** or **Originally queued, then promoted to steer the active turn**. An interrupted reply shows **Cut off by a steer**.
  - Source: `chat/QueuedRunsControl.tsx`, `TimelineUserMessageRow.tsx`.
- **Interrupt.** With an empty draft while the agent works, the send button becomes **Interrupt** / **Stop generation**.
  - `thread.stop` has no default key.
  - If the agent doesn't respond: **Agent not responding to Stop** → **Force stop**, which kills its processes.
  - Source: `chat/ComposerPrimaryActions.tsx`, `chat/useForceStopThread.ts`.
- **Resume.** After a stop, a server restart or a usage limit, queued messages are held. **Resume** / **Resume thread** in an empty composer continues ("Continue where you left off.") and releases the queue (`chat/useComposerResume.ts`).
- **Compact and send.** When the context is nearly full, the send button reads **Compact and send** ("Summarize N tokens of history, then send"). `/compact` and the context meter also trigger compaction (`ComposerPrimaryActions.tsx`, `docs/user/composer.md`).

### Attachments
- **Limits.** Up to 100 files per message. Images up to 10 MiB each (80 MiB of images in total). Other files, including video, up to 50 MiB each.
- **How files arrive.** Uploads start when you attach, and sending waits for them; a failed upload offers retry or remove. Files land on the environment's machine, and the agent gets their paths.
- **Ways to attach.**
  - **Attach files** button, drag-drop, or paste.
  - HEIC/HEIF images are converted to JPEG, and oversized photos are resized.
  - A folder dropped onto the desktop composer inserts a path reference (local environment only).
  - Dragging from the file tree inserts an @-mention.
  - Source: `docs/user/composer.md`, `chat/folderDrop.ts`, `files/fileTreeDragMention.ts`.
- **Where attachments show.** Images sit on a thumbnail shelf and also get an inline chip at the caret. Other files exist only as chips. Removing a thumbnail that the text still mentions asks for confirmation first.
- **Previewing attachments.** Selecting a file chip opens it beside the conversation:
  - Code and JSON get syntax highlighting. Markdown, HTML, CSV and TSV have rendered and raw views. Audio has a player.
  - A ZIP opens as a folder list. HTML and PDF render.
  - Actions: **Copy contents**, **Save file**.
  - Right-clicking media offers save or copy path.
- **Answers to agent questions.** These can carry attachments too (see 3.6).
- **SnapShots** (desktop, off by default). A global shortcut (both Shift keys by default) captures the window in front, with its app name, title and accessibility tree, as an attachment (`docs/user/snap-shot.md`).

### Inline context chips
Context is inserted as inline chips at the caret and serialised as `[label](t3-context://v1/<kind>/<id>)`.
- **Chip kinds** (`packages/contracts/src/composerContext.ts`): image, file, terminal excerpt, picked page element, preview annotation, review comment (also used for PRs), mention, skill, thread, environment.
- **Behaviour.**
  - Chips can be moved by cut/paste and deleted like a character. Hover shows details. Selecting one opens a details popover or the media viewer.
  - Copy/paste carries chips between drafts, threads and environments; images and files are fetched again from their source.
  - Source: `docs/internals/composer-context-references.md`, `docs/user/composer.md`.
- **What the agent receives.** Each chip becomes an inline marker plus one `<t3_context>` envelope at the end of the message. Captured text is escaped so it can't forge records.
- **Triggers in the composer** (`chat/useComposerMenuItems.ts`):
  - `@`: other threads (same server, or linked machines with the Linked environments beta), machines, and workspace files or folders.
  - `#`: pull requests. Recent ones are listed, threads' linked PRs first. Digits filter by number, an exact number resolves directly, and a word searches the repository. The chip is coloured by PR state.
  - `$`: skills of the selected provider.
  - `/`: commands and skills (see below).
- **Thread references.**
  - A thread chip is only a reference: the agent reads the history on demand through T3's thread-read tool, so attaching a long thread costs nothing until it's used.
  - A thread dragged from another (non-linked) environment becomes a saved transcript file.
  - **Copy thread** / `mod+shift+c` puts a thread chip on the clipboard.
- **From other panels.**
  - Terminal: select text → **Add to chat** in the terminal's context menu.
  - Diff and file views: review comments.
  - Browser preview: **Annotate preview** ("Annotate elements, regions, and drawings"), which produces element and annotation chips with screenshots.
  - These land at the composer's last caret position.
  - Source: `ThreadTerminalDrawer.tsx`, `preview/PreviewChromeRow.tsx`.
- **Project search.** Project content search (`mod+shift+f`) offers **Add to chat** and **Copy mention** on a result (`search/ProjectContentSearchDialog.tsx`).

### Slash commands, skills and goals
- **Built-in commands** (`useComposerMenuItems.ts`, `docs/user/composer.md`):
  - `/model`: switch model.
  - `/plan` and `/default`: only with the legacy plan mode (Labs).
  - `/usage-limits`: shows the current model's limits above the composer.
- **Provider commands.** Listed from the provider, for example Claude's own commands and `/compact` where supported. They only run at the start of a message; T3 commands and skill mentions work on any line.
- **Skills** appear as `/skill:<name>` in the slash menu (**Show skills in slash menu**, on by default) and through `$`.
- **Restart agent session** (palette). Reloads the agent's skills, plugins and MCP servers while keeping the conversation.
- **Goals.** `/goal <done condition>` (Codex and Claude) keeps the agent working across turns until it judges the goal met.
  - A line at the end of the thread shows the goal and its progress.
  - `/goal` shows it and `/goal clear` removes it. Codex also has `/goal pause` and `/goal resume`.
  - Source: `docs/user/composer.md`, `chat/ThreadActivityBanners.tsx`.

### Pickers in and under the composer
- **Model picker** (`mod+shift+m`; `chat/ModelPickerContent.tsx`, `ModelPickerSidebar.tsx`):
  - A providers sidebar (`mod+shift+up/down` switches provider), **Search models...**, **Favorites** (star a model), and a **Legacy models** section.
  - `mod+1…9` picks a model while the picker is open.
  - Models show readiness states such as **Not ready**, **Limited** and **Unavailable**.
  - Shift-click selects several models (new threads only).
  - Picking a different provider in an existing thread is allowed. T3 hands the conversation over as a budgeted selection of history ("Context handoff" in the timeline; `docs/user/portable-handoffs.md`).
- **Traits / effort menu** (`mod+shift+e`; `chat/TraitsPicker.tsx`):
  - Reasoning effort, with **Composer: Increase/Decrease Effort**, which are unbound by default.
  - Context-window size, a thinking on/off switch, and Claude "Ultrathink".
  - Speed: **Normal**, **Fast**, **Ultrafast**.
  - Provider-specific options such as an OpenCode **Agent**.
  - **Effort display** (Appearance) shows the effort as a word or as bars.
- **Permissions** (`mod+shift+a`): **Supervised**, **Auto-accept edits**, **Auto** (the provider's automatic review), **Full access** (the default for new threads). It lives in the effort menu, or next to the model when the thread isn't on the default (`docs/user/permission-modes.md`).
- **Mode (legacy).** **Build / Plan** toggle and Shift+Tab, only with **Plan mode (legacy)** in Labs.
- **Machine.** **Run on** host (`mod+shift+h`, plus **Composer: Cycle Host** unbound by default). **Auto balance** spreads new threads across machines.
- **Workspace and branch.** Workspace (`mod+shift+x`: current checkout, new worktree, previous worktree), **reuse previous worktree** (`mod+shift+l`), base or Git branch (`mod+shift+g`).
  - These sit under the composer for a new thread and retreat after the first message, unless **Composer context** is on (Appearance).
  - Source: `docs/user/keybindings.md`, `docs/user/appearance.md`, `BranchToolbar*.tsx`.
- **Composer extras.** A context-window meter (Context Window, Total processed, Cost; the circular indicator is a legacy Labs option), a usage-limits popover, a fallback-model notice, the stash badge, and **More composer controls** for narrow widths (`chat/ContextWindowMeter.tsx`, `CompactComposerControlsMenu.tsx`).

### Quoting assistant text (citations)
- **Cite in composer.** Select text within one assistant response and choose **Cite selection in composer** ("Shorten selection" if it is too long).
- **The citation chip.** It carries the quote and an optional comment; the pencil edits the comment.
- **Jumping back.** Selecting the quote jumps to and highlights the source, even after reloads or remounts, but only while the source text is still unambiguous.
- **What the agent sees.** Which words were quoted, and which comment is yours.
- Source: `docs/user/composer.md`, `docs/internals/assistant-citations.md`, `chat/AssistantSelectionToolbar.tsx`.

### Voice input
- **iPhone only.** On-device transcription on iOS 26+, inserted at the caret for review before sending.
- **Web/desktop.** No voice input exists; "environment-backed transcription is not implemented".
- Source: `docs/user/composer.md`, `docs/internals/voice-input.md`.

---

## 3. How agent output renders

### 3.1 Timeline structure
- **Rendering engine.** The timeline is virtualised, and row kinds are listed in `MessagesTimelineRow`: messages, work groups, live work, thinking, turn folds, attempt folds, context compaction, events, proposed plans, HTML renders, MCP apps, worktree setup (`chat/MessagesTimeline.logic.ts`, from code).
- **Streaming.** Assistant text streams paragraph by paragraph. **Response streaming → Wait for the full response** (Settings → Threads, Advanced) turns that off.
- **Long threads.**
  - Older parts of a turn fold away; retried attempts fold separately.
  - **Load earlier turns** pages in history.
  - Long user messages collapse behind **Show full message**.
- **Timeline minimap** (from code). A strip with one mark per user turn. Hovering a mark previews the prompt and the final reply, and **Previous turn** / **Next turn** buttons step between turns (`chat/TimelineMinimap.tsx`, `timelineMinimapItems.ts`).
- **Find in thread** (`mod+f`, `chat.find`). Searches every message and proposed plan in the thread, including ones not yet loaded (server-side). Enter / Shift+Enter step through matches (`chat/ThreadFindBar.tsx`, `docs/user/keybindings.md`).
- **"Now" line** at the end of the timeline. Shows what needs you, background work it's waiting on, sync status and the active goal (`chat/ThreadNow.tsx`, `ThreadStatusLine.tsx`).
- **Message actions.** Copy (Markdown, with links in place of chips), **Copy prompt link**, **Edit from here**, **Fork from this response**.
- **Dividers and notices.**
  - **Context compacted** (with token counts, or a failure reason).
  - **Context handoff**, **Created thread**, **Run interrupted**.
  - **Branch changed from …** with **Restore branch**.

### 3.2 Tool calls and the activity log
- **Grouping.** Consecutive tool calls collapse into one expandable summary, e.g. "Ran 2 commands and sent messages to 3 threads". Commands, file changes and orchestration take priority in the summary over reads.
- **Expanded calls.** Expanding shows commands, inputs, status and exit codes. A running command's output updates live, with the tail shown ("Earlier output not shown"). Shell wrappers are shortened in summaries.
- **Open diff** appears on a file change.
- **Failures** show as **Tool call failed**. Failed calls don't count as successes in summaries.
- **Per-item inspector.** A V2 item inspector exists (`chat/V2ItemInspector.tsx`, from code).
- Source: `docs/user/activity-log.md`, `chat/TimelineWorkGroupRows.tsx`, `TimelineWorkEntryRow.tsx`, `CommandOutputPanel.tsx`.

### 3.3 Thinking and reasoning
- **Display.** Reasoning shows as a **Thinking** row while it is in progress and **Thought** when done, collapsed to its first line and expandable.
- **Superseded reasoning.** Reasoning that a later item has replaced is settled.
- **No reasoning text.** If the provider sends none, a plain "Thinking" or "Working..." row is shown.
- Source: `chat/MessagesTimeline.logic.ts`, `TimelineWorkEntryRow.tsx` (from code).

### 3.4 Changes produced by a turn
- **Changes card.** An assistant reply that changed files ends with a changed-files tree showing +/− counts, with **Open diff** / **Open the full diff** to open the Diff panel at that turn (`chat/ChangedFilesTree.tsx`, from code).
- **Checkpoints.** Each turn's checkpoint makes the per-turn diff and **Revert files too** possible (`docs/internals/glossary.md`).

### 3.5 Plans
- **Proposed plan card.** Renders a plan as Markdown, collapsible with **Expand plan** / **Collapse plan**.
- **Plan actions.** **Copy to clipboard**, **Download as markdown**, **Save plan to workspace** (asks for a path).
- **Sidebar.** The thread is marked **Plan Ready**.
- **Composer buttons** (`chat/ProposedPlanCard.tsx`, `ComposerPrimaryActions.tsx`, `useProposedPlanSend.ts`):
  - A **Plan ready** banner.
  - **Refine** (send feedback in plan mode).
  - **Implement**, with a split menu **Implement in a new thread** that starts a fresh thread titled from the plan.
- **Legacy toggle.** T3's own Build/Plan toggle is now **Plan mode (legacy)** in Labs (off by default). Plan cards still render for providers that produce plans (from code).

### 3.6 Approvals and questions from the agent
- **Approval requests.**
  - Kinds: **Command**, **File change**, **File read**, **App permission**, **App access**.
  - Shown in the timeline and as composer actions: **Approve**, **Decline**, **Always allow this session**, plus **More approval options**.
  - With Claude, typing a reply while an approval is pending declines it and sends your text as feedback.
  - Source: `chat/ComposerPendingApprovalActions.tsx`, `TimelinePendingApprovalRow.tsx`, `docs/user/permission-modes.md`.
- **Questions.** Questions such as Claude's AskUserQuestion replace the composer with a question card (`chat/ComposerPendingUserInputPanel.tsx`, from code):
  - One question at a time, with **Previous question** to go back.
  - Single-select options auto-advance; multi-select is supported.
  - Keys `1`–`9` pick options. A typed custom answer replaces the options.
  - The card can be collapsed, or the question dismissed (**Dismiss question without answering**).
  - Questions stay answerable after the provider turn ends when the provider allows it.
- **Question attachments.** When custom answers are accepted, **Attach files** or a pasted image can go with an answer. Each question keeps its own attachments, up to 100 files per answer set (`docs/user/question-attachments.md`, `questionAttachments.ts`).
- **Other request cards** (from code):
  - **Secret request**: the agent asks for a secret value through `request_secret` (gated by the Secrets build flag). `chat/SecretRequestCard.tsx`.
  - **Link request**: the agent asks you to link a machine. `chat/LinkRequestCard.tsx`.
  - **Guest message approval**: guests' messages wait for the owner (status **Request**).

### 3.7 Visual replies (HTML renders) and MCP apps
- **Visual replies.**
  - Agents publish a self-contained HTML page (chart, table, diagram, collage, mockup) with T3's `html_preview` tool. It appears above the written reply, with every provider and on every client.
  - Pages follow the current theme and light/dark mode. Scripts run sandboxed, away from the T3 session.
  - **Open full screen** and zoom controls are available.
  - Local images are embedded at publish time, and the pages are deleted with the thread.
  - Before publishing, the agent checks its work with screenshots from a private headless browser (about 120 MB, downloaded once).
  - Source: `docs/user/html-renders.md`, `chat/HtmlRenderFrame.tsx`, `HtmlRenderDialog.tsx`.
- **MCP Apps.** Interactive apps returned by MCP tools (MCP Apps standard; Codex only today) replace the tool-call row.
  - They follow the theme.
  - They can call their server's tools and post messages, after confirmation unless the tool is read-only.
  - Full screen is available after an in-app click.
  - An app can send a note that goes along with your next message.
  - Source: `docs/user/html-renders.md`, `chat/McpAppFrame.tsx`.

### 3.8 Markdown rendering in messages
Source: `components/ChatMarkdown.tsx`, `chat/Markdown*.tsx` (mostly from code).
- **Code blocks.** Syntax highlighting, **Copy code**, **Wrap lines**.
  - Finished `sh`/`bash`/`zsh`/`fish`/`powershell` blocks have **Run in terminal**.
  - Blocks containing control or invisible characters are refused, so the command that runs is the one shown.
- **Mermaid** diagrams render, with **Show code** / **Show diagram** and **Expand diagram**.
- **Math.** LaTeX is typeset when **Render math** (Appearance, off by default) is on. Dollar amounts stay text.
- **Alerts.** GitHub-style alerts (Note, Important, Warning, Caution).
- **Details.** Collapsible `<details>` blocks render.
- **Task lists.** Task-list checkboxes can be toggled (**Toggle task**).
- **Tables** have **Copy table**.
- **File links.**
  - A link to a workspace file opens the file viewer at the referenced line.
  - Its context menu has open in editor, **Preview media**, **Open in integrated browser**, reveal in the file manager, and **Full path** / **Relative path** copy. Web links also offer **Open in integrated browser**.
  - Files outside the workspace open read-only.
  - Images and videos open in a media viewer with zoom.
- **Thread links** render as thread chips. PR links have **Link to thread** / **Unlink from thread** in their context menu.
- **Copying.** Text and formulas copy back out as Markdown/TeX.

### 3.9 Thread details card
- **Placement.** A card (or docked panel, `mod+shift+b`) beside the chat.
- **Rows** (selectable, 10 in total, set via right-click or Appearance → **Thread details**):
  - **Environment and worktree**, **Open in editor**, **Project scripts**, **Branch and pull request**, **Git actions**, **Changes**.
  - **Servers**: web servers that the thread's terminals or agent started, with **Stop**.
  - **Automations**: scheduled tasks posting into the thread, with **Run now** and **Edit automation**.
  - **Lineage**.
  - **Usage**: off by default; shows the provider account's limit windows and the context window.
- **Hidden rows** keep their shortcuts.
- Source: `chat/threadDetailsItems.ts`, `ThreadDetailsCard.tsx`, `ThreadServersPanel.tsx`, `ThreadAutomationsPanel.tsx`, `docs/user/thread-sidebar.md`.
- **Open in editor** (`mod+o` opens your favourite editor). Choices: Cursor, Trae, Kiro, VS Code, VS Code Insiders, VSCodium, Zed, Antigravity, the JetBrains IDEs (IntelliJ IDEA, Aqua, CLion, DataGrip, DataSpell, GoLand, PhpStorm, PyCharm, Rider, RubyMine, RustRover, WebStorm), and File Manager (`packages/contracts/src/editor.ts`, `chat/OpenInPicker.tsx`).

---

## 4. Panels next to the conversation (brief)
- **Terminal drawer** (`mod+j`).
  - Per-thread terminals that keep running across thread switches. Split with `mod+d` / `mod+shift+d`, add a terminal with `mod+n`, close with `mod+w`.
  - The context menu has **Add to chat**, **Copy**, **Paste**, **Select all**, **Jump to latest**.
  - The server keeps 5,000 lines / 8 MiB of scrollback.
  - The renderer is libghostty compiled to WASM (from code).
  - Source: `ThreadTerminalDrawer.tsx`, `apps/web/src/terminal/ghostty/`, `docs/user/terminal.md`.
- **Project scripts.** Defined in `t3.json` or project **Actions** (setup, run, dev). Each gets a `script.<id>.run` keybinding; the setup script runs when a worktree is created ("Worktree setup" card with Branch, Base, Path and Setup rows) (`ProjectScriptsControl.tsx`, `chat/WorktreeSetupCard.tsx`).
- **Files.**
  - A file explorer pane with a tree (expand/collapse all, refresh) and a file viewer.
  - Workspace files are editable with debounced autosave (from code, `files/fileSaveCoordinator.ts`). Files on the host outside the workspace are read-only.
  - The viewer handles PDF, Office documents, notebooks, fonts, audio, Mermaid, CSV/TSV tables and binary files.
  - `mod+p` opens a fuzzy file picker. `mod+shift+f` opens project content search with **Match case**, **Match whole word** and **Use regular expression**.
  - Source: `components/files/`, `search/ProjectContentSearchDialog.tsx`.
- **Browser preview** (`mod+shift+j`).
  - An integrated browser with tabs, zoom (`mod+=` / `mod+-` / `mod+0`), URL focus (`mod+l`) and reload (`mod+r`).
  - It discovers local dev servers and shows the agent's cursor when the agent drives the browser.
  - Also: element and region annotation, recordings, and cookie-imported profiles (desktop).
  - Agents control it through `preview_*` MCP tools.
  - Source: `components/preview/`, `docs/user/browser-import.md`.
- **Diff, Pull requests, Device.** Covered in the source-control and remote/devices files.

---

## 5. Keyboard shortcuts and focus

### How bindings work
- **Storage.** `~/.t3/userdata/keybindings.json` on the environment holds a JSON array of `{key, command, when}` (at most 256). New defaults are merged in at startup without overwriting your changes, and the last matching rule wins.
- **Key syntax.** `mod` is Cmd on macOS and Ctrl elsewhere. Other modifiers: `cmd/meta`, `ctrl`, `alt/option`, `shift`.
- **`when` contexts.** `terminalFocus`, `terminalOpen`, `previewFocus`, `previewOpen`, `modelPickerOpen`, `usagePageOpen`, `composerFocus`, `composerDraft`, `turnRunning`, `editableFocus`, `isWeb`, `isDesktop`. From code also: `rightPanelOpen`, `draftThreadRoute`. Combine them with `!`, `&&`, `||` and parentheses.
- **Settings → Keybindings.**
  - Search, plus groups (Navigation, Threads, Composer, Terminal, Preview & diff, Appearance, Project scripts, Other).
  - A shortcut recorder, a visual **When** builder, and conflict warnings.
  - **Reset to default**, **Remove**, **Add keybinding**, **Open keybindings.json**.
  - On web it warns that the browser may claim some keys.
- Source: `packages/shared/src/keybindings.ts` (`DEFAULT_KEYBINDINGS`), `packages/contracts/src/keybindings.ts`, `apps/server/src/keybindings.ts`, `docs/user/keybindings.md`, `components/settings/KeybindingsSettings.tsx`.

### Default bindings (from `DEFAULT_KEYBINDINGS`)
| Area | Keys → command |
| --- | --- |
| Palette / search | `mod+k` palette · `mod+p` go to file · `mod+shift+f` search project contents · `mod+f` find in thread |
| Threads | `mod+n`, `mod+shift+o` new thread · `mod+shift+n` new thread (skip project chooser) · `mod+alt+n` new thread without project · `mod+shift+[` / `mod+shift+]` previous/next thread · `mod+1…9` jump to thread (desktop only by default) · `mod+shift+s` settle · `mod+shift+p` pin · `mod+shift+c` copy PR link or thread · `mod+shift+k` copy PR number · `mod+z` undo the last sidebar action |
| Composer | `mod+enter` opposite queue/steer action (while running) or start in background (new thread) · `mod+alt+enter` start in background / send and start new thread · `mod+shift+enter` steer the first queued message · `alt+up` edit last queued message · `mod+s` stash/restore prompt |
| Composer pickers | `mod+shift+m` model · `mod+shift+e` effort · `mod+shift+a` permissions · `mod+shift+h` host · `mod+shift+x` workspace · `mod+shift+g` branch · `mod+shift+l` reuse previous worktree · in model picker: `mod+shift+up/down` provider, `mod+1…9` model |
| Layout | `mod+b` sidebar · `mod+alt+b` right panel · `mod+shift+b` thread details panel · `mod+t` new right-panel tab · `mod+w` close tab/terminal · `mod+shift+t` reopen closed tab · `mod+d` diff · `mod+j` terminal · `mod+shift+j` preview |
| Terminal (focused) | `mod+d` split · `mod+shift+d` split vertical · `mod+n` new · `mod+w` close |
| Preview (focused) | `mod+r` reload · `mod+l` URL · `mod+=` / `mod++` / `mod+-` / `mod+0` zoom |
| Navigation | `mod+[` / `mod+]` back/forward · `F6` / `shift+F6` (and `mod+F6` / `mod+shift+F6` in browsers) cycle workspace areas · `mod+o` open in favourite editor · `mod+u` Usage |
| Appearance | `mod+alt+a` theme picker · `mod+alt+shift+a` cycle System/Light/Dark · `mod+alt+shift+t` theme editor |
| Usage page | `c` / `t` / `l` Cost/Tokens/Limits · `mod+shift+1…4` 24h/7d/30d/90d |
| Unbound by default | `thread.stop`, `composer.cycleHost`, `composer.increaseEffort` / `decreaseEffort`, `rightPanel.toggleMaximized` |

- **Composer-local keys** (not in the keybinding file): Enter/Shift+Enter (per **Send shortcut**), ArrowUp/Down prompt recall, `Cmd/Ctrl+Shift+V` paste as text, `1`–`9` for question options, `Escape` to close find.
- **Desktop quit.** `Cmd/Ctrl+Q` has **Hold** mode by default (hold 1.2 s or double-press); **Direct** and **Double press** are the other options. Source: `docs/user/keybindings.md`, `QuitHoldOverlay.tsx`.
- **Diff find.** `mod+f` inside a diff searches every file, including folded ones. Not configurable.

### Focus model
- **Workspace areas.** `F6` / `Shift+F6` cycle the sidebar, conversation, message input and visible panels, restoring the last focused control in each (`docs/user/keyboard-focus.md`).
- **Command palette.** Keeps focus while open. Closing it returns focus to the composer.
- **Terminals.** A terminal that finishes starting doesn't steal focus if you went back to typing.
- **Type to focus.** Typing or pasting while focus is on the timeline goes to the composer (from code).
- **Menus.** `Shift+F10` or the Menu key opens context menus, which are fully keyboard-navigable (`contextMenuFallback.ts`).
- **Gestures.** Two-finger horizontal trackpad swipes go back and forward like a browser (`HistorySwipeNavigation.tsx`, from code).

---

## 6. Command palette
- **Search.** `mod+k` searches commands, projects and threads across all connected environments.
  - Thread ranking uses title, branch, PR and project, weighted by frequency and recency. For three weeks, the thread you last picked for a query ranks first for that query.
  - Message matches appear under **In messages** and open at the message.
  - Starting the query with `>` shows actions only.
  - Groups: Suggestions, Recent Threads, Threads, Projects, Actions, Settings, Directories.
  - Source: `components/CommandPalette.tsx`, `CommandPalette.logic.ts`, `docs/user/thread-sidebar.md`.
- **Actions found** (from code):
  - New thread / **New thread in...** / **New thread without a project**.
  - **Add project** (local folder, clone, new project, WSL).
  - **Go to file**, **Search project contents**, **Find in current thread**.
  - **Open pull requests**, **Link pull request to thread**, **Show linked pull requests**.
  - **Share with guest**, **Copy prompt link** (+ **with repo and model**).
  - **Restart agent session**, **Triage an issue**.
  - **Open usage**, **Open settings** (and every settings section), **Project settings**.
  - **Change theme**, **Change appearance**, **Toggle theme editor**.
  - **Connect an environment**, focus next/previous workspace area.

---

## 7. Appearance and themes
Source: `docs/user/appearance.md`, `components/settings/AppearanceSettingsPanel.tsx`, `ThemeSettings.tsx`, `TypographySettings.tsx`.
- **Colour scheme and themes.**
  - **Color scheme**: System / Light / Dark.
  - A theme grid with separate light and dark variants per theme, and **Search themes...**.
  - Preferences are saved per device or browser.
- **Custom themes.**
  - **Create theme** opens an editor; its colour picker can select an area of the app to find the colour to change (`themeInspector.ts`).
  - **Add theme** imports a T3 Code or VS Code theme (`vscodeThemeImport.ts`, `openVsxThemes.ts`, from code).
  - Themes export as JSON. **Duplicate**, **Edit**, **Export**.
- **Environment themes.**
  - A server can publish themes in `~/.t3/userdata/themes/`, generating a full palette from `canvas` + `accent`.
  - `t3 theme set <id>` switches connected clients once.
  - Clients follow a published theme as the server updates it.
- **Interface.**
  - **Contrast** (50–200%), **Glass opacity** (40–100%).
  - **Chat width**: Comfortable / Wide / Full.
  - **Effort display**: Word / Bars.
  - **Render math**.
  - **Panel animations** (0–400 ms; off by default).
  - **Environment identification**: artwork or version pill.
  - **Composer context**.
- **Typography.**
  - Interface and monospace fonts and sizes, or with **Separate fonts**: interface, prompt, code and terminal fonts.
  - **Word wrap**, **Font smoothing** (macOS).
- **Diffs & pull requests page** (appearance-related). **Diff layout** Stacked/Split, **Hide whitespace changes**, **Default diff file state**, **Diff colors** Red & green / Blue & orange.
- **Shortcuts.** `mod+alt+a` opens the theme picker from chat; `mod+alt+shift+a` cycles appearance.

---

## 8. Notifications and attention signals
- **Thread notifications** (Settings → General → Notifications).
  - Options: **Off** (default), **Notifications only**, **Sound only**, **Notifications with sound**.
  - They fire when a thread finishes, fails, or needs input or approval, while the app is open on that device.
  - Browsers need HTTPS or the desktop app.
  - Source: `components/settings/NotificationSettings.tsx`, `threadNotifications.ts`.
- **In-app notifications** (off by default). A toast when another thread finishes, fails or needs you while the app has focus.
- **Timing.** Attention notifications fire at once. Completion notifications wait out a short grace period, so a continuation that starts right after doesn't trigger a false "done" (`ThreadNotificationCoordinator.logic.ts`, from code).
- **Dock badge.** The desktop dock/taskbar badge counts unread notified threads (`ThreadNotificationCoordinator.tsx`, from code).
- **Screen readers.** Background status changes of other threads, and activity in the open thread, are announced through live regions (`BackgroundThreadAnnouncer.tsx`, `chat/ThreadActivityAnnouncer.tsx`, from code).
- **Other toasts.** Undo notices, update available (**Update everything**), keybindings-file problems, slow RPC, legacy-thread migration and clone progress (`components/*Toast*`).
- **Mobile push.** Covered in the remote/mobile file.

---

## 9. Settings pages (what's configurable)
Source: `apps/web/src/routes/_chat.settings.*.tsx`, `components/settings/`.
- **Navigation.** Sidebar groups: (General, Appearance, Chat, Diffs & pull requests, Keybindings, SnapShots), **Agents** (Providers, Threads, Browser, Devices, Scheduled tasks), **Code** (Projects, Source control, Worktrees), **Connections** (Environments, Sharing & access, Secrets\*), then Maintenance, Labs, About, Archive.
- **Search.** Settings search (`/` or `mod+f`) jumps to a row and opens collapsed **Advanced** folds. Every keybinding command is its own search result.
- **Scope sentence.** "Applying settings for [All projects] across [All environments]" picks the project and environment a change applies to. Server-scoped rows show inheritance (default → environment → project → `t3.json`) and **Mixed** when the targets disagree (`docs/user/project-settings.md`).
- **General.**
  - Notifications (above).
  - Sidebar: **Project grouping**, **Project order**, **Working section**.
  - Confirmations for unpin, archive (off) and delete (on), and **Quit shortcut**.
  - **Time format**: System / 12-hour / 24-hour.
- **Chat.** **Rich text composer**, **Send shortcut**, **Show skills in slash menu**, **Follow-up behavior** (Queue / Steer).
- **Threads.**
  - New threads: **Model**, **Fallback model** (used when the default provider is out of usage), **Permissions**, **Workspace**.
  - **Snooze options**.
  - Usage limits: **Resume after usage limits**, **Snooze until limits reset**.
  - **Auto-settle** rules.
  - **Text generation model**, **Thread title instructions**, **Response streaming**.
- **Labs** (all off by default).
  - **Boring sidebar (group by project)**, **Two-line folder rows**.
  - **Guest links**, **Linked environments**, **Simlock device hosts (alpha)**.
  - Legacy: **Plan mode (legacy)**, **Context window indicator (legacy)**.
  - Beta options elsewhere: **Review guides (beta)** (Source control); "Before the cache expires (beta)" under **Compact idle threads** (Providers).
- **Archive.** Archived threads by project, with Unarchive and Delete.
- **One line each** (covered in other files):
  - **Providers**: instances, sign-in, models, custom models, accent colour, usage providers.
  - **Browser**: agent browser access, profiles, open links in, search engine, viewport, recordings.
  - **Projects**: name, icon, actions, checkouts.
  - **Source control**, **Worktrees** (location, branch naming, submodules, cleanup).
  - **Environments**, **Sharing & access**.
  - **Scheduled tasks**: cron or webhook agent runs.
  - **SnapShots**, **Devices**, **Secrets**\* (build flag).
  - **Maintenance**: updates, background activity profile, cleanup, diagnostics.
  - **About**: version, update track Stable/Nightly, `t3` CLI, mobile app.

---

## 10. Welcome wizard and onboarding
Source: `docs/user/welcome-wizard.md`, `components/onboarding/WelcomeWizard.tsx`, `FirstRunGate.tsx`.
- **When it shows.** New installations get a setup flow. It can be rerun at `/welcome`. It can be closed at any step, and direct links (e.g. Settings) bypass it.
- **Steps.**
  1. **Connect your computers.** Select the already-connected machine and add others via T3 Connect (`t3 connect`) or **Add a computer** (pairing link, `t3 pair --tailscale`). Version-incompatible machines show **Client not supported**.
  2. **Check your agents.** Detects Claude Code and Codex on each machine. Install or sign-in buttons open a terminal with the vendor command ready.
  3. **Import your projects.**
     - Finds directories used by Claude Code, Codex or Pi. Git repositories come first, grouped by remote, newest first.
     - Selected by default: repositories active in the last 30 days with at least 3 conversations.
     - Imports those conversations (first prompt plus the newest messages, 200 total, no tool activity) so they can be continued in T3.
- **Error states.** **Still connecting** / **Could not read settings** with **Reload** / **Retry**.
- **Hosted app.** app.t3.codes skips setup and asks you to sign in to T3 Connect and run `npx t3 connect`.

---

## 11. Other user-facing UI features
- **Usage page** (`mod+u`, `/usage`):
  - Token use, cache savings, estimated API-equivalent cost and per-model breakdown across providers and environments.
  - **Limits** pools subscription windows per provider across accounts.
  - Custom **Model prices** and **Map to**.
  - Shortcuts `c`/`t`/`l` and `mod+shift+1…4`.
  - Source: `docs/user/usage.md`, `components/usage/`.
- **Navigation history.**
  - `mod+[` / `mod+]` and back/forward buttons in the sidebar.
  - `mod+shift+t` reopens the last closed tab of any kind (files, diffs, PRs, browsers, devices).
  - Source: `navigationHistory.ts`, `reopenClosedView.ts`.
- **Updates from the sidebar.**
  - A sidebar update pill with release notes.
  - **Update everything** updates this app, remote servers and provider CLIs in one run. It can switch the update track and checks database migrations before crossing tracks.
  - Source: `sidebar/SidebarUpdatePill.tsx`, `sidebar/updateEverything.logic.ts` (from code).
- **Guest links** (Labs). Share a live thread with a guest whose messages need your approval (covered in the remote file).
- **Migration from V1.** V1 threads are migrated with titles, modes, branches, pins, snoozes and PR links. Drafts, stashes, layout and theme carry over to the V2 desktop app (`docs/user/thread-migration.md`).
- **Desktop-only.** Quit-hold overlay, default-browser mode (macOS), SnapShots, browser profile cookie import, folder drop as a path reference, and `mod+1…9` thread jumps by default.
- **Accessibility** (from code). Live-region announcements, keyboard-operable drag alternatives (**Move up/Down**), screen-reader labels for chips ("Terminal excerpt, Terminal 1 lines 3-4"), reduced-motion support.
