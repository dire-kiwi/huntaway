# Concepts

- **Agent configs** are Claude Code config directories on a host, passed to agents as
  `CLAUDE_CONFIG_DIR`, or Codex homes, passed as `CODEX_HOME` (API 25), so logins, settings and
  history stay separate. A thread's config decides which agent runs it (see _Codex agents_).
- **A proxy for a Claude config** (API 106): an Anthropic-compatible proxy such as
  [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI), which pools several Claude
  subscriptions behind one address. Set its URL and one of its client keys in the config's _Edit_
  dialog (Settings → Agent configs), and the config's agents, task titles and task terminals send
  their requests there (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, with `ANTHROPIC_API_KEY`
  emptied) instead of using the directory's login. The directory's settings, skills, memory and
  history are still used, so a config like `~/.claude-personal` can go through the proxy as it is
  (Claude Code leaves claude.ai connectors out when it has a key like this). The keys are kept on the host
  and never sent to the board (`has_api_key`, `has_management_key`); a key left out of an update is
  kept, and a blank one clears it. Codex configs can't have one. _Restart 5h window_ doesn't apply to
  them (the proxy picks the account). `PATCH /claude-configs/{id}` (and `POST /claude-configs`) take
  `api_url`, `api_key` and `management_key`.
- **Profiles** (work / personal) scope projects and tasks, and pick which Claude
  configs their agents can use (the first is the default). A project can pick its own instead.
  When more than one is available, the new task dialog asks which to use. A thread keeps the
  config it was created with (it can be changed under Details until its agent first starts),
  and its review thread uses the same one unless the project's reviewers pick another.
- **One prompt, several agents** (API 61), as t3code sends a prompt to several models: each
  `!model` in the new task dialog's description makes a task with that model, so `!opus
  !gpt-5.5` makes two tasks from one prompt, one on Claude Code and one on Codex. `!` takes any
  model of the configs the task can use (the picked config's first), `!<config>` a config's
  default model, and `!<model>.<config>` a model that more than one config has (`!opus.work`).
  Code tasks made this way each get their own worktree and branch. They share a `fanout_id`, so
  their cards show which model each ran with, and each one's Details list the others with their
  state and cost.
  **Compare** them (API 83) from a card's model badge or right-click menu (_Compare all N from its
  prompt_), or _Compare all N_ in a task's Details. It opens over the board: each one's model,
  status, cost, agent time (all of its runs together), review (the verdict and each reviewer's
  issues) and diff against its base branch, with a table of the files any of them changed (click
  one's +/− to go to its diff). _Side by side_ puts them in columns; _One at a time_ shows one with
  its summary beside it, switched with its tabs, ← → (or `[` `]`) and 1–9, in unified or split
  diffs. A phone shows them one at a time. A task whose worktree is gone shows the commits on its
  branch. **Pick this one** keeps that task as it is and completes the others as _Not done_: their
  agents (and reviewers) are stopped and their worktrees removed. Its dialog lists what each has
  uncommitted, and asks whether to discard that (unticked, those worktrees are kept with the
  changes in), to delete their branches (and the pushed copies; unmerged commits on them are lost)
  and to close their pull requests (with gh, as the task's GitHub account). A worktree whose HEAD
  has commits on no branch (a detached HEAD's) is always kept, as they'd be lost with it. A branch
  is deleted after its pushed copy, so it's kept while its worktree is, while a pull request kept
  open has it, or when its pushed copy can't be deleted. Anything that couldn't be done is listed
  after, and picking again cleans up what was kept the first time. `GET /tasks/{id}/fanout` gives each one's agent time, uncommitted
  files and branch, and `POST /tasks/{id}/fanout/pick` (`delete_branches`, `close_prs`,
  `discard_uncommitted`) picks it.
- **Agents across profiles** (API 23): each profile has its own board, and agents' board tools
  see their own profile's. A profile can let other profiles' agents use its board too: edit it
  under Settings → Profiles and tick them under _Agents from other profiles_ (or _Every
  profile_). It's off by default, so work and personal stay apart until you open one up, and it's
  one way: letting personal agents into work doesn't let work agents into personal. Those agents
  can then list, read, create and change the board's projects and tasks, and message its tasks'
  agents. `list_projects` labels each project with its profile. Projects and tasks are named by
  id or key. A key means the agent's own board if it's there, else the one other board that has
  it. A key that's on several other boards must be qualified, as `work:SD-3` or with the tools'
  `profile` argument. A task created on another profile's board belongs to that profile and runs
  with its Claude config and login. Agents are told which profiles' boards they can't use, so they
  ask rather than create a project that may already be there. The setting is per host, and is
  checked by name, so on a linked host it applies to agents from the profile of that name
  anywhere on the board.
  This keeps profiles' work apart, but it isn't a security boundary. Each agent's board helper
  calls the host's API with the host's own access token (`IA_TOKEN` in the run's MCP config),
  and agents run as the same OS user as the server, so they can also read `<data-dir>/auth_token`
  and the database. An agent that ignores its tools (one following injected instructions, say)
  can reach every profile's board on the host (and on a hub, its linked hosts', whose tokens are in its data). Keep
  logins whose work must stay apart on separate hosts or OS users. What the tools do ask the user
  about (project changes and new projects, deletions, automations) is asked by the server, and
  the API the UI uses to answer needs the same token, so it guards against a misled agent's tool
  calls, not against code running as you.
- **Usage:** the sidebar shows how much of each config's plan limits (session,
  weekly, per-model weekly) is left, for the configs the sidebar's profile and its projects use. It's off until
  _Show usage_ is ticked on a config in Settings → Agent configs (API 52): the endpoint's rate
  limit is per account, and every copy of a login (PR previews, test servers) would otherwise
  ask too. Each host reads the config's login (`<config dir>/.credentials.json`) and asks
  Anthropic's usage endpoint every few minutes (for Codex configs it asks `codex app-server`),
  and agent runs update it live. The login is never refreshed by the board. An expired login
  shows its last numbers until the config's next agent run renews it. Hosts before API 52
  don't show usage. Each limit shows when it resets (a countdown, or a day and time further
  out). A limit at 80% or more is marked in amber, and one that's used up in red, in the
  sidebar and where a config is picked (the new task dialog's config picker, a task's
  _Config_ row), so you can pick another config before starting work.
  A config with a proxy (API 106) shows the proxy's Claude accounts instead, given CLIProxyAPI's
  management key in its _Edit_ dialog (and `management.allow-remote: true` in the proxy's config,
  unless it's on the same machine): the host lists its credentials (`GET /v8/management/credentials`)
  and asks Anthropic's usage endpoint for each Claude one through the proxy, with that account's
  token (`POST /v8/management/requests/api-call`). The sidebar shows the pool's limits, each the
  average of the accounts that answered and resetting when the first of them does, and a line
  per account with what's left of its session and weekly limits (or why it couldn't be read).
  Agent runs' `rate_limit_event`s are one account's, so they don't change the pool's numbers; a
  refusal the proxy passes on (every account it tried was out) still marks the config out. The
  management key can act as any of the proxy's accounts, so it stays on the host.
- **Restarting the 5-hour window** (API 91): a plan's session limit runs for five hours from
  the first message after the last window ended, so a window that ends while nothing runs leaves
  the next one to start whenever work does. Tick _Restart 5h window_ on a config in Settings →
  Agent configs (off by default) and the host sends one short prompt just after each window ends
  (a minute late, for clocks that disagree): `claude -p` on Haiku with no tools, MCP servers or
  saved session for Claude, a low-effort ephemeral turn for Codex, from the data dir. That starts
  the next window straight away. Only plans with a 5-hour limit are sent anything: the host fetches
  the config's usage when the setting is turned on (or the server starts), and a plan whose usage
  has never shown a session limit (like a plan with only weekly limits) is left alone, as is a config
  that's out of usage. (Where that fetch fails, as with a login that has expired, it waits for an
  agent run on the config to report the window.) It fetches again before each prompt, in case a run or another host already
  started the window, and again after it, and takes the prompt's own `rate_limit_event`s in as an
  agent run's are. The first request after a window ends reports the window that ended (as its
  `rateLimitType`, left out of `unifiedWindows`), so that still counts as having one; only a prompt
  whose rate limits show no 5-hour window at all, with usage that doesn't show one either, stops the
  restarts until the setting is turned on again. Codex's windows are told apart by their length
  (`windowDurationMins`), so a plan whose only window is weekly has no session limit. A prompt that fails, or after which no window is running, is tried again in 5 minutes,
  then 10, 20 and 40, then hourly. The setting's checkbox is greyed when the config's shown usage
  has no session limit. See `apps/server/src/agent/window.ts`.
- **Running out of usage** (API 81): when a run is refused for its config's usage limit
  (Claude Code's 429 `usage_limit_reached`, with a `rate_limit_event` whose status is
  `rejected`; Codex's `usageLimitExceeded`), the host marks that config _out_ until the
  limit resets and notes the reset on the task. Usage at 100% alone doesn't count, since a
  plan with extra usage carries on past it, and nor does a `rejected` event on extra usage
  (`isUsingOverage`, or an `overageStatus` of `allowed`), whose turns go on. Until API 81 such a run just failed, and its task
  needed attention with "Run failed: You've hit your 5-hour limit · resets …". Now the task
  needs attention with that message and offers _Carry on then_: it waits in _In progress_
  (with an hourglass and the countdown on its card), and when the limit resets its agent is
  told to carry on, with any message queued meanwhile. Two settings on each profile (Settings
  → Profiles, _When a config runs out of usage_, both off by default) do more by themselves:
  - _Wait for the limit to reset, then carry on_: a task whose agent runs out waits like that
    without asking, and a task started (or messaged) on a config that's out waits for its reset
    instead of being refused.
  - _Start new tasks on the next config with room_: a task whose agent hasn't started yet, on a
    config that's out, starts on the next of its project's (or profile's) configs for the same
    agent (Claude Code or Codex) that isn't out. A task that has started stays on its config,
    which holds its conversation.
    A waiting task keeps waiting, whatever these settings say: a message sent to it (or _Start_)
    joins its queue. Moved to another config before its agent has started, it stops waiting for
    the old config's reset and starts on the new one (or waits for that one's, if it's out too).
    A merge that runs out doesn't wait: waiting in _In progress_ would give up its place in the
    merge queue to the next task's merge. It needs attention, keeping its place, and you message
    its agent once the limit has reset.
    Whether a config is out is kept in memory by the host the config is on, from its own runs,
    so a restart forgets it until a run is refused again; a waiting task keeps its reset time
    in the database and carries on after a restart. Codex doesn't say which limit refused it,
    so the host takes the latest reset of the limits Codex last reported as used up, and a
    Codex task with none known just fails as before.
- **Context** (API 40): a thread's _Context_ pill shows how full its agent's context window is,
  following each reply as it works. Clicking it opens the breakdown Claude Code's `/context`
  shows (system prompt, tools, MCP servers, memory files, skills, messages, free space and the
  autocompact buffer). The board asks the agent for it at the end of each turn (a
  `get_context_usage` control request), so it's as of the last turn. It asks for the summary: the
  total is the last reply's usage and the parts are Claude Code's local estimates, rather than
  `/context`'s recount with the token-counting API. Codex agents only report the total.
- **Projects** are local repositories. Each has a key (`ABC-12`), a scratch folder, a worktrees
  folder, setup/teardown and status change scripts, a permission mode and an optional model.
- **Skills and MCP servers** (API 21, 22): skills (a `SKILL.md` each) and MCP servers for
  agents, kept on the host rather than in a repository. **Global** ones (Settings → Skills and MCP
  servers) are switched on or off by default per profile. A project can override that in its
  settings (_Profile default_, _On_ or _Off_), and it can have its own skills and servers, which
  win over a global one with the same name. A global server named `google` is the assistant's
  alone (see _Google for the assistant_): projects' runs never get it. Before each run, the skills that are on are written to
  `<data-dir>/projects/<id>/agent/.claude/skills/`, which the agent gets with `--add-dir`. The
  servers are added to the run's `--mcp-config` next to `gh` (and `huntaway`, for Codex runs and compactions). A server can allow all of
  its tools, so they never ask for approval. Skills and servers that come from elsewhere (the
  Claude config, its plugins, claude.ai connectors, the repository) can be turned off per project.
  They're denied with `--disallowedTools` (`Skill(<name>)`, `mcp__<server>`). The settings list
  what the project's runs reported in their `init` message over the last two weeks, and anything
  else can be turned off by name. Changes apply from each thread's next message.
- **Skill sources** (API 104): global skills can come from a git repository, as with `npx skills add`.
  Settings → Skills and MCP servers → _Add from git_ takes a git URL (https, ssh or a local path),
  `git@host:owner/repo` or `owner/repo` for GitHub, and optionally a branch or tag. The host clones it
  (shallow, into `<data-dir>/skill-sources/<id>/`, with its own git setup, so a private repository needs
  credentials there) and every folder with a `SKILL.md` in it (the repository's root too, and `skills/`,
  `.claude/skills` and so on, up to six folders down) becomes a global skill, **off** for every profile
  and project. Switch them on like any global skill: per profile (a source's chip switches all its skills at
  once, or each skill's own chips) and per project (_Profile default_, _On_ or _Off_). A run gets the skill's
  whole folder in the project's skills folder, so its scripts and references come with it. _Update_ clones
  the repository again: new skills appear (off), changed ones are updated, ones that went are removed with
  their switches, and if the clone fails the skills stay as they were and the source shows why. A source's
  skills can't be edited or deleted one by one, and one whose name another global skill has is left out
  (the source lists what it left out). `POST /agent-tools/skill-sources` (`url`, `ref`) adds one,
  `POST /agent-tools/skill-sources/{id}/update` updates it, `DELETE /agent-tools/skill-sources/{id}`
  removes it, and `POST /agent-tools/switches` takes a `source_id` instead of an `item_id` to switch all of
  a source's skills.
- **Tasks** start their agent when you press Start, drag the card into _In progress_, or tick
  "Start agent now". The first prompt is the task title and description. Replies resume the
  same Claude session (`--resume`). While the agent works, the card shows how long it has been
  working instead of when it was last active (API 15).
- **Titles** follow the work. A task created from a description alone gets a title using its
  agent and login: Haiku for Claude (`claude -p --model haiku`), or the Codex config's model for
  Codex. Each message you send it after that (not the board's own, nor
  other agents') asks again, with the title, the description and all of your messages (each
  with the end of what the agent said before it), for a title for what the task is about now. It
  answers `KEEP` unless the user has given the task a different goal: details, questions, feedback
  and routine steps (continue, review, rebase, merge) leave the title alone, and a message that's
  only links or attached files isn't asked about. A title renamed by hand (double-click it in the task
  panel, or `update_task`) is pinned and stays as it is; the pin next to it lets it follow the
  messages again (`title_pinned`, API 49). The branch keeps the name it was given.
- **Steering:** a message sent while the agent is running goes to it straight away, as in Claude
  Code (API 28). The agent reads it once it finishes its current step (the tool call it's in) and
  carries on in the same turn; until then it's shown above the composer, and then in the thread
  where the agent read it. One that arrives as the turn ends starts the next turn of the same run.
  Runs read stream-json input for this (`--input-format stream-json`; `turn/steer` for Codex):
  the shim passes the run directory's `input.jsonl` on to the agent after the prompt, and the
  server ends that input when a turn ends with no message waiting, so the run ends as before.
  **Stop** asks the agent to end its turn (an `interrupt`) rather than killing it, so the session
  stays resumable; a message it hadn't read yet then starts its next turn. If it hasn't ended the
  turn within 10 seconds, its process is stopped. Messages from other agents (`send_to_task`) are
  steered the same way.
- **Queued messages:** where a message can't go to the running agent (a `/compact` run, a run
  started before steering, a task waiting on its dependencies) it's queued (shown above the
  composer; more messages are added to it) and sent as the next prompt when the run ends, so the
  card stays in _In progress_. Press **Stop** to stop the run and send the queued message straight
  away, or the ✕ on it to take it back for editing. Messages the agent never read (its run ended
  first) are sent the same way. The card's working timer keeps counting through queued messages.
- **Attachments:** paste, drop or pick (📎) images and other files in the new task dialog or a
  thread's composer (API 18). Each file is uploaded to the host that runs the agent, saved under
  `<data-dir>/attachments/<id>/<name>` (10 MB at most), and listed by path at the end of the
  description or message, so the agent reads it with its Read tool. Agents get `--add-dir` on
  that folder, so reading attachments needs no approval. The board shows the files as thumbnails
  and chips rather than paths. A task's files are deleted with it, and files that no task or
  message refers to (abandoned drafts, removed chips) are deleted after a week.
- **Compacting:** reply `/compact` (optionally followed by instructions for the summary) to have
  Claude Code summarise the conversation so far, so later prompts start from a smaller context.
  It doesn't move the card. A session is also compacted on its own after 50 minutes with no new
  prompts, while its prompt cache (1 hour) is still warm. Sessions idle longer than an hour (for
  example while the host was down) and tasks in _Done_ are left alone. The thread shows where it
  was compacted; click the line to read the summary.
- **Skills** (API 54): type `/` at the start of a message to pick one of the skills the task's
  agent has, with what each does (also `/compact`). Arrow keys move, Enter or Tab picks, Escape
  closes the menu. A Claude agent gets `/name arguments`, which Claude Code runs as at its own
  prompt; as a task's first message it goes before the task, which becomes part of its
  arguments. A Codex agent gets `$name` (also typed to open the menu), which tells it to use that
  skill. For Claude, the list (`GET /api/tasks/{id}/skills`) is the skills the project's last run
  with the task's config reported (the ones a user can call), and those in the config's and the
  repository's skills folders by folder name, less any changed since to `user-invocable: false`;
  descriptions also come from installed plugins and synced skills. Codex's host lists its own
  (with the repository's `.agents/skills`). Both add the project's own and global skills, less the
  ones it turns off. The menu reloads when the task moves to another config.
- **Status transitions:** running → _In progress_; the agent asks a question
  (`request_user_input` or `AskUserQuestion`, see _Questions and plans_) or presents a plan, a
  tool needs approval, a run fails, or you stop it → _Needs
  attention_; a run finishes cleanly → _In review_. You move cards to _Done_ yourself, or to
  _Ready for merge_; a task whose pull request is merged on GitHub moves to _Done_ by itself
  (see _Pull requests_). Moving a task to _Done_ (with the _Done_ resolution) whose work isn't
  merged asks first (API 75): its branch has commits its base branch doesn't, or it has
  uncommitted changes, and its pull request (if any) isn't merged on GitHub. Tasks with a
  document, and _Won't fix_ or _Not done_, don't ask.
- **Archived** (API 53): a task that's been in _Done_ for two days is archived. It leaves the
  kanban board's _Done_ column, which links to it ("N archived"), for the list view's _Archived_
  section, the last one, which starts collapsed. It's still done (a task that depends on it
  still counts it as merged). Drag it back into _Done_ to bring it back for another two days, or
  to another column to reopen it. Tasks keep when they were done in `done_at`; hosts from before
  that go by when the task last changed.
- **Search, filter and sort:** each board's header (a project's, a subproject's, a group's or a
  profile's; on a narrow board, a row below it), in every view, has a search field (`/` goes to it, Escape clears it) that matches
  every word typed in a task's key, title, description, branch or project. _Filter_ picks
  statuses (which leaves the other columns or sections out), types of task, projects (on a
  group's or profile's board) and tasks with a running agent, a star, a pull request or a
  reminder; filters of one kind match any of their values. A bar under the header then shows how
  many tasks are left and each filter, to take off. Each board keeps its search and filters for
  the browser tab; _Sort_ (the board's own order, latest activity, newest, oldest, title or cost)
  is kept for every board. A task dropped below a filtered column's last card goes after that
  card; sorted other than by hand, a drop only moves a task to another column, at its end.
- **Now and Later** (HA-109, API 97) were taken out by HA-285 (API 126): pens took their place
  (see _Pens_ in [Using the board](board.md)). Hosts ignore `now` on `PATCH /tasks/{id}` and the
  agents' task tools, tasks no longer have `now_at`, and `/settings` no longer has
  `now_expiry_hours`.
  - **Lasso:** hold Ctrl and drag with the right mouse button on a board, in any view, to draw a
    loop; the tasks it goes round or over are picked (outlined) as it's drawn, and the browser's
    own menu stays shut. Add Shift to keep those already picked. Ctrl + right-click (without a
    drag) on a card picks it, or lets it go if it was. A bar at the foot of the board counts the
    picked tasks, and its _Pen_ puts them in a pen or takes them out; so does the right-click menu
    of any of them (it says how many). Escape, or the bar's ✕, lets them go. On a touch screen there's no lasso:
    use a card's menu button.
- **Other views** (HA-5, a first try at ways to see the board other than by status): beside
  _Board_ and _List_, the view switch has two more, which show the same tasks (the search and
  filters apply) and are kept for every board like the other two. On a board narrower than
  1500px the switch names only the current view, and below 1180px none.
  - _Triage_: what each task needs from you, most pressing first: an answer (_Needs
    attention_), a review (_In review_), a reminder that's come round, an agent that stopped
    before it finished, a start; then the agents at work. Each shows the agent's last words
    (`GET /tasks/{id}`'s `last_message`); picking one (a click, or `j`/`k`) shows its pending
    permission prompts to allow or deny, its thread's composer (the same draft as its panel's)
    and, in review, _Ready for merge_. `Enter` opens its thread.
  - _Graph_: tasks linked by how they came about: a task follows the task whose agent created
    it, the tasks it waits for (`depends_on`) and the subproject it's in, a column per step, and
    a link that a longer way round already makes is left out. Tasks made from one prompt are
    boxed together; tasks from other boards that one links to are shown faded. Tasks with no
    links are in a grid below.
- **Waiting** (API 36): an agent with nothing to do until something happens (the tasks it
  created, CI and reviews, a deploy) calls the `wait` tool (`reason`, `seconds`, `tasks`) instead of sleeping,
  polling or ending its turn. The call blocks until the first of: the wait period is over (10
  minutes unless given, an hour at most; for a wait with no `tasks`, `command` or `pull_request`, 30
  seconds by default and at most, since little else can end it early: a longer one is turned
  down with a note to give one or wait 30 seconds at a time), one of the tasks in `tasks` changes status (or is
  deleted), one of its subagents completes, fails or stops, the shell command in `command`
  exits (API 41, see below), there's news about the pull request in `pull_request` (API 62, see
  below), a message is sent to the agent (yours or `send_to_task`), the run is stopped, the
  task is moved to another column from the board or with `update_task` (_Needs attention_ too;
  the board's own moves there and back for a subagent's permission prompt don't count), or the run carries on with other work: another board tool
  call (from the agent or its subagents) or a tool call of the agent's own thread (Claude or
  Codex). Its subagents' other tool calls and permission prompts don't count, so an agent can
  wait for its subagents. It then tells the agent which, with the watched tasks' state,
  and the agent can wait again. For a subagent it returns `ended: "subagent_finished"` with
  its `tool_use_id`, status and summary in `subagent`. Meanwhile the task stays in its column (it isn't waiting on you,
  so it's not _Needs attention_), and the card, list and thread show _waiting_ with the agent's
  reason instead of _working_. The waiting state lasts exactly as long as the call, however it returns
  (failing that, until the turn or run ends), and is kept as the task's `agent_wait`, apart from `waiting`
  (queued for dependencies). A server restart doesn't start a wait over: the agent reconnects for
  the call (Claude's runs' calls are taken up again from their output, and an MCP helper retries it), which carries on until the same deadline, watching the same tasks (one
  deleted meanwhile ends it). Planning agents (subprojects and
  group tasks) are told to wait for the tasks they started this way rather than end their turn.
  - `command` lets the agent wait for what the board can't see (CI, a deploy, a file): the server
    runs it with bash in the agent's working directory, and the wait ends when it exits, telling
    the agent its exit code and the last 4000 bytes of its output. A command can block until
    it's ready (`gh pr checks 12 --watch`) or loop until it is (`until curl -sf …; do sleep 15;
    done`). It's approved like one of the agent's Bash calls (a permission prompt in the thread,
    unless the thread's mode or _Always allow_ for Bash decides). In _Auto_ mode the agent's
    own reviewer checks it instead: Claude runs there don't pre-approve `wait` as they do the
    other board tools, and a Codex session from before the board's tools were dynamic tools has
    its `approval_mode` set to `prompt`, so each wait call, command included, goes through
    Claude's classifier or Codex's `auto_review` reviewer and the board doesn't ask again. (If
    Codex leaves the call to the user, the board asks about the command.) Codex doesn't review
    a dynamic tool's calls, so a newer session's wait command is asked about as in _Ask_. It runs in a process group of its
    own that's killed when it exits or the wait ends first, and starts again from the beginning
    when a server restart retries the call. A watchdog in its group kills it once the server
    that started it is gone, however it went (restarting, exiting or crashing), so a restart
    doesn't leave the old copy running. It's kept in `agent_wait.command` and shown with the
    wait.
  - `pull_request` (API 62) watches a pull request: its number (in the task's repository, the one
    its branch is pushed to, whose SSH host alias, like `git@github-work:o/r.git`, is the host
    `ssh -G` says it stands for), `OWNER/REPO#NUMBER` or URL. The wait ends on news the agent hasn't
    been told yet: a check on its head commit failed (or was cancelled or timed out), all of the
    head's required checks passed (all of its checks, when none is required), someone other than
    the agent's GitHub account commented or reviewed, it started to conflict with its base branch,
    or (always) it was merged or closed. `pull_request_events` picks some of `checks_failed`,
    `checks_passed`, `comments` and `conflicts` (all by default). The call returns `ended:
    "pull_request"` with `pull_request`: its state (merge state, review decision, checks' outcome
    with the failed ones' names and links, and those still running), the events, and the new
    comments with their author, kind (comment, review or review comment), file and line, and their
    text without HTML comments and cut to 800 characters (20 at most). A wait that ends otherwise
    returns how the pull request was when last read (`read_at`). The server reads it with one
    GraphQL query (`gh api graphql`) a minute (and one for each 100 review threads past the first
    100, up to 1,000), as the task's GitHub account (see _GitHub accounts_)
    and only that one; a failed read is tried again after 2, 4, 8 and 10 minutes, and after 5 in a
    row the wait ends with `events: ["unreadable"]` and the error. The first read is made before
    the wait starts, so a pull request that can't be read fails the call. No one's asked about it:
    it only reads. What the agent has been told about each pull request is kept with the task
    (`pr_watches`, DB 54), across its waits and runs and server restarts: the comments and reviews
    it has seen, the head commit whose checks' outcome it was told, and whether it was told of a
    conflict. A wait reports what happened since the last one on that pull request, so a review
    left while the agent works between waits ends the next one straight away, and a restart
    doesn't report old comments again. The first wait on a pull request counts its comments as
    seen but reports how its checks ended and a conflict. News counts as told once a call returns
    it (a call that ends otherwise returns it too): a run that was stopped meanwhile leaves it for
    the next wait. It's kept in `agent_wait.pull_request`, and the card and list show _watching
    #N_ after the agent's reason, linked to the pull request.
- **Ready for merge:** moving a task there (once its agent has stopped) asks its agent to merge
  the work: its pull request if there is one, otherwise the branch, following the project's own
  instructions. The card stays in _Ready for merge_ while the agent works. If the agent needs
  approval or asks a question, the card goes to _Needs attention_ and comes back afterwards. When
  the merge is done, the agent moves the task to _Done_. If the agent stops without doing that,
  the task goes to _Needs attention_. A project merges one task at a time (and each subproject
  one of its tasks at a time): tasks moved there while another is merging show _queued to merge_
  and start in column order (top first) once it ends.
  A task with nothing to merge (no commits on its branch beyond its base and no uncommitted
  changes, or no worktree at all) skips the merge and goes straight to _Done_.
  A merge that turns out to need changes to the task's work (checks failing because of it, review
  comments, conflicts that need more than a simple resolution) doesn't hold up the tasks behind it:
  its agent steps out of the queue (`update_task` with status `in_progress` and `remerge`), the
  next task starts merging, and the card shows _rejoins merge queue_ in _In progress_ while its
  agent makes the changes. When that run ends, the task goes back to the end of _Ready for merge_
  (not to _In review_) and merges when its turn comes. Moving it to another column meanwhile
  (bar _Needs attention_) takes it out of the queue.
  A merge waiting on you in _Needs attention_ still holds the queue; move it to another column to
  let the next one go. You can't message a queued task's agent until it's its turn.
- **Dependencies:** a task can depend on other tasks in its project (_Depends on_ in its
  sidebar, the new task dialog, or `depends_on` in the agents' `create_task`/`update_task`).
  Moved to _In progress_ (or started) before they're all merged, it shows _queued_ and its agent
  doesn't start. Messages sent to it meanwhile are queued for it. Once every task it depends on
  is _Done_ with resolution _Done_ (closing one as _Won't fix_ or _Not done_ doesn't count),
  its agent starts. Deleting a task it depends on, or taking it off the list, also lets it go.
  Moving a queued task out of _In progress_ takes it out of the queue.
- **Reviews:** when a task moves to _In review_ (its agent finished, or you moved it), a reviewer
  agent reviews its branch's pull request (or the branch's diff if there's no PR) in a review
  thread of its own, working read-only in the task's worktree. The card shows _reviewing_ while
  it runs, then the outcome; click it, or _Review thread_ in the task's sidebar, to read the
  reviewer's thread or ask it about its findings. Only code changes are reviewed: if the branch
  has no commits of its own, the task is only reviewed if, since the last review, its agent
  edited files (and that succeeded), committed, pushed, opened a pull request or wrote files with
  a shell command such as `sed -i` or a redirect (outside scratch places such as `/tmp`), or the
  worktree has uncommitted changes (or, before the first review, the task has a pull request).
  Files a script writes from its own code (such as `python3 -c '...'`) aren't noticed. The task's
  activity says why it wasn't reviewed otherwise, and _Review now_ reviews it anyway. Then the agent worked somewhere else, such as in another repository, so the
  reviewer is given the agent's last message and the task's pull request, if any, to find and
  review the changes, and passes the task if there were none. The review prompt also quotes what
  you told the task's agent in its thread (each message after what the agent said before it), so
  reviewers don't raise again a limitation you accepted or an option you turned down. The
  reviewer reports with `submit_review`.
  Serious issues go back to the task's agent to fix, which it may push back on by asking you
  (`request_user_input`, so the task goes to _Needs attention_). When it finishes, the new commit
  is reviewed again. After the project's _Fix rounds_ (default 2) in a row, a review that still
  finds serious issues moves the task to _Needs attention_ instead. There, _N more rounds of fixes_
  (in the task's sidebar, under its status and on its _Review_ tab) sends those issues to the agent
  and gives the task as many rounds again, at least one: a project's 2 become 4, then 6 (API 93,
  `POST /tasks/{id}/review/extend`). _Review again_ starts afresh, with the project's rounds. A commit that was already
  reviewed isn't reviewed again (unless its review found issues and the branch has no commits, as
  the fixes are then elsewhere), and a review in progress is stopped when the task's agent
  starts working again. The card stays in _In review_ while it's reviewed, and only goes back to
  _In progress_ when the agent works on it again (to fix the issues found, or because you sent
  it a message). _Review now_ in the task's sidebar reviews on demand, once the agent has
  stopped; a task in _In progress_ or _Needs attention_ moves to _In review_ for it. Turn reviews off,
  or set the rounds, in the project's settings (API 12). The task's _Review_ tab shows what each
  round of fixes changed, from its checkpoints (API 70, see _Checkpoints and rewinding_).
- **Several reviewers** (API 29): a project's settings can list more than one reviewer under
  _Reviewers_, each an agent config with an optional model and effort (for example one Codex and
  one Claude, or Fable and Opus). By default there's one, with the task's own config. Each reviews
  in a review thread of its own, all at once; the card shows how many have finished, and the
  task's sidebar shows each one's findings and links its thread. Once they've all finished, the
  serious issues they found go to the task's agent together, as one round of fixes. The review
  passes when they all pass; if none found issues but one failed or was stopped, the review
  failed. A reviewer keeps its thread from one review to the next, and changing its config, model
  or effort starts a new one. `update_project` takes `reviewers` too.
- **Instructions and skills per reviewer** (API 105): each reviewer can have instructions of its own
  and skills it uses, as a summarizer can (_Instructions and skills_ beside it in the project's and
  the profile's settings; `prompt` and `skills` in each `reviewers` entry). A reviewer's
  instructions replace the project's _In review_ prompt for it only (what to look for: the board still
  adds where the changes are and how to report), so one reviewer can look for security holes while
  another reviews the project's way. Its `skills` are named in its prompt (`/name` for Claude Code,
  `$name` for Codex), and the board's own (a project's and the global ones, see _Skills and MCP
  servers_) among them, and those a summarizer names, are on in that thread whether or not they're on
  for the project: they're written for the thread to a folder of its own, so the project's other agents
  don't get them (a project's own skill that is off for the project can be named too, and wins over a
  global one of the same name), and they show in the thread's `/` menu. The settings are copied to
  the thread as each review starts, so they apply from the next review.
- **A profile's reviewers and summarizers** (API 87, several summarizers in API 103): a profile's settings
  (_Settings → Profiles → Edit_) pick the _Reviewers_ and _Summarizers_ for its projects, and each project's
  _Review_ settings use _The profile's_ until you switch to _This project's own_, which starts from the
  profile's and overrides them. A project's own can still be one reviewer with the task's config,
  over a profile's that differ. Through the API a project's `reviewers: []` and `summarizers: []`
  use the profile's (`reviewers` and `summarizers` on `PATCH /profiles/{id}`), and `get_project`
  shows the profile's as `profile_reviewers` and `profile_summarizers`. (`summarizer`, the first of
  `summarizers`, is still read and written for clients from before API 103: `null` is `[]`.)
- **Summaries** (API 84): once a task's review passes, an agent summarises its changes for you
  to read before merging: what changed and why, the main changes, and how to try it. It reads the
  pull request (or the branch's diff) read-only in the task's worktree, in a summary thread of its
  own (a review thread of type `summary`), and its last message is the summary, kept in the task's
  `summaries` with the commit it describes. While the task waits in _In review_ with a summary
  (written or being written), its sidebar opens on the _Summary_ tab; _Summarise now_ there
  writes one at any time. A summary in progress stops when the task's agent works again, and the
  next review that passes writes a new one. Turn it off, or pick the _Summarizers_ (each an agent
  config, model and effort; the profile's, and otherwise one with the task's config, by default), in the
  project's _Review_ settings (`auto_summary` and `summarizers`, which `update_project` takes too). `POST /tasks/{id}/summary`
  summarises on demand.
- **Several summarizers, to compare skills and prompts** (API 103): a project or profile can list up
  to six summarizers, each writing the summary in a thread of its own at the same time, and the task's
  _Summary_ tab shows each one's, boxed and labelled. Besides its agent config, model and effort, a
  summarizer has a _name_ (to tell them apart), the _skills_ its agent is asked to use while it writes
  (`/name` for Claude Code, `$name` for Codex: the project's and host's own skills, or any the
  config has) and a _prompt_ that replaces the board's instructions on how to write the summary (the
  board still asks it to end with only the summary). So one summarizer with no skills and another with a
  `tldr` skill or a shorter prompt can be read side by side on the same change. A summarizer's
  thread is kept from one summary to the next while its config, model, effort, name, skills and prompt
  stay the same; one added later is written when the next summary is (without redoing the others), and
  one taken out loses its summary. `summaries` on a task is one `{thread_id, label, name, skills,
  custom_prompt, state, head, text}` for each, and `summary` is the first.
- **Prompts:** the project's settings show the instructions in the prompts the board sends as a
  task moves across it, and each can be replaced: _In progress_ is sent to the task's agent when
  it starts, after the task's title and description (and before any message it was started
  with); _In review_ tells the reviewer what to look for; _Ready for merge_ tells the agent how to
  merge. The board keeps the parts it relies on around them (which branch, how to report a
  verdict, setting the task to done). A prompt left as the default (or cleared) follows the
  default, which `GET /default-prompts` returns. Agents can read and change them with
  `get_project` and `update_project` (API 27). Below them, a read-only preview shows what the
  board adds to the agent's own system prompt for a new thread in the project, with the options a
  thread is made with (task, subproject or scratch task, labels, its own worktree, Claude Code or
  Codex, and Codex's plan mode) and the project's saved settings (`GET
  /projects/{id}/system-prompt`, API 80).
- **Project changes by agents** (API 44): `update_project` changes any project setting but its
  agent configs, which only the user changes; agents can't delete projects. Its name, key, base
  branch, model, prompts, reviews and group change straight away. A change to its permission
  mode, a script (setup, teardown or status), its repository path or its worktree settings
  (the files copied or folders linked into worktrees too, from API 82) first asks the user: a
  dialog over the whole app (and a card in the agent's thread) shows each
  setting's old and new value and the agent's reason, and the call waits for the answer. Nothing
  changes unless they approve, whatever the thread's permission mode, and an approval is never
  "always". What counts as a change is what the project would be after it (the update is made
  and rolled back), and only those settings are written. Agents on other hosts can't ask for
  these. `GET /project-approvals` lists the ones waiting. From API 45 a new repository path is checked before asking
  (it must be the same repository, or with `move_repo` a free path to move the folder to), and
  approving `move_repo` moves the folder.
  From API 76 `create_project` asks too, before anything is made: the dialog (_Add a project?_)
  shows the folder with symlinks resolved (and whether it exists yet, or is a git repository),
  the name and key it would get, the board, and the host's default permission mode, which its
  tasks get. The path must be absolute (or start with `~/`). Its tasks' agents work in that
  folder, so without this an agent could add your home folder as a project and start a task
  there. It's asked as a project change (kind `project`, tool `create_project`, with `changes`
  for older UIs), and a call retried after a restart waits for the same answer, like
  `update_project`'s.
- **Task deletions by agents** (API 58): `delete_task` deletes a task (and a subproject's tasks)
  as the task panel's _Delete_ does, but only once the user confirms it. Like a project change, it
  asks in a dialog over the whole app and a card in the agent's thread, showing the task, the
  tasks deleted with it, whether its branch goes too (`delete_branch`) and the agent's reason. The
  call waits for the answer whatever the thread's permission mode, and deletes nothing unless they
  confirm. Agents can't delete their own task or the subproject they're in, reviewers don't get
  the tool, and agents on other hosts can't ask for it. Only the tasks the user was shown are
  deleted: if a subproject gains tasks while the user is asked (or a task becomes one), the call
  deletes none of them and the agent has to ask again. No task can be added to a subproject while
  it's being deleted (by an agent or from the board), since it would go with it. A task deleted
  some other way while the user is asked settles the question. `GET /project-approvals?all=true` lists these with the
  project changes waiting.
- **Worktrees:** by default each task gets `ia/<key>-<n>-<slug>` in its own worktree, created on
  first run (or from the task panel). A new branch starts from the latest base branch: its
  upstream (or, without one, the branch of the same name on `origin`) is fetched first, and the
  branch starts from it whenever the local base branch is behind, even if that can't be
  fast-forwarded (it's checked out with changes in the way) or has diverged. The local branch is
  fast-forwarded when it can be, and is used as it is when it's ahead (with unpushed commits)
  or has no upstream. The task's log says which it started from.
  A new worktree has none of the repository's git-ignored files (`.env`, local config, caches),
  so a project can bring them in from its repository folder, before the setup script runs (API 82,
  the _Worktrees_ settings, `copy_files` and `link_folders`):
  - **Files to copy** are .gitignore-style patterns, one per line (`.env` matches at any depth,
    `/.env` only at the top, `config/*.local.json`, `!` leaves one out), as is a
    `.worktreeinclude` file at the top of the repository folder, which is read as well (the file
    Claude Code and Orca use). Each untracked file they match is copied if git ignores it, both
    in the repository folder and on the task's branch, so a copy never shows as a change or gets
    committed. Tracked files aren't copied, and a file the worktree already has is never
    overwritten. Copies are copy-on-write where the filesystem can (Btrfs, XFS, APFS).
  - **Folders to link** are paths of folders relative to the repository, one per line, each
    symlinked into the worktree instead of copied (a model cache, say). Each must be ignored by git
    and have nothing tracked in it. Git doesn't count a symlink as a folder, so a `node_modules/`
    pattern doesn't ignore the link: when nothing else does, `/<path>` is added to the
    repository's `.git/info/exclude` (shared by its worktrees, under a comment saying why), so the
    link doesn't show as untracked, doesn't get committed, and doesn't keep the worktree from
    being removed. Changes made through a link change the original; removing the worktree
    (teardown, forced or not, or **Remove merged worktrees**) removes the link only.

  Nothing is read from outside the repository (`..` and absolute paths are refused) or through a
  symlink in it (a symlinked file, folder or `.worktreeinclude` is left out, since it could lead
  out of the repository, to its `.git` or to tracked files), and nothing is written through a
  symlink in the worktree. The links made in a worktree are listed in its git folder
  (`huntaway-links`), so moving the repository repoints them even if the setting has changed since. The task's log lists what was
  copied and linked, what was already there, and what was left out and why. Agents' `update_project`
  can change both lists only once the user approves, as with the scripts, since they can put
  secrets in reach of every task's agent. The setup script then runs there with `IA_REPO_PATH`,
  `IA_WORKTREE_PATH`, `IA_BRANCH`, `IA_TASK_ID`, `IA_TASK_NUMBER` and `IA_PROJECT_KEY` set.
  Teardown runs the teardown script and removes the worktree. It refuses while there are
  uncommitted changes unless you choose to discard them, and keeps the branch unless asked.
  Agents are told to commit to their branch.
  **Remove merged worktrees** in a project's settings (API 39,
  `POST /projects/{id}/remove-merged-worktrees`) removes the worktrees of its done tasks when
  nothing in them would be lost: no uncommitted or untracked files, including changes to tracked
  files marked assume-unchanged or skip-worktree (ignored files, such as build output, don't
  count and go with the worktree), and HEAD is in the base branch, locally or
  upstream (fetched first), or is the head of the branch's merged pull request (squash and rebase
  merges, asked of `gh`). Worktrees an agent or reviewer is working in are left alone. It lists
  each done task's worktree as removed or kept, and why. The tasks and their branches are kept;
  if a task's agent runs again, its worktree is set up again in the same folder (named from its
  branch), so its conversation carries on.
  A project that uses worktrees but whose folder can't have them yet (it isn't the top folder of
  a git repository, or the repository has no commit to branch from) shows its **setup thread**
  instead of its board (API 73). _Start setup thread_ (`POST /projects/{id}/setup-thread`, with
  an optional `message` for the agent) makes a task in the project, without a worktree, whose
  agent looks at the folder, makes it a repository with a `.gitignore` and a first commit, and
  offers to put it on GitHub, asking before anything hard to undo. The project keeps it as
  `setup_task_id`, so asking again gives the same thread. The page looks at the folder every few
  seconds, and the board comes back, with the thread's task on it, once the folder is ready.
  _Use without worktrees_ turns the project's worktrees off instead, and the board shows at once.
  Projects list `has_commits` beside `is_git`.

- **Starting from elsewhere** (API 96): a task's worktree can start from something other than the
  project's base branch, picked before it's made: type `from:` in the new task dialog's
  description (it suggests the project's open tasks and its branches), fill in _Starts from_ in
  the task's _Worktree_ details before its first run (or after a setup that failed before making
  its branch), or give `start_from` to the API and the agents' `create_task`/`update_task`. It
  takes another task's key (`from:IA-12`), a branch (`from:feature-x`, or `from:origin/feature-x`
  for one only on a remote), a pull request (`from:#12` or its URL) or a commit (`from:0123abc`, 7
  to 40 hex digits); `task:`, `branch:`, `pr:` or `commit:` after `from:` says which when it could
  be read as another. It's kept on the task as `start_from` (`{type: "branch", branch}`, `{type:
  "task", task_id}`, `{type: "pull_request", number, repo?}` or `{type: "commit", commit}`), and
  it's worked out as the worktree is first made, which sets the task's base branch:
  - **Another task** stacks it on that task's branch, which becomes its base: its pull request
    targets that branch, and its _Changes_ tab, reviews and merged checks compare with it, so the
    other task's changes aren't counted as its own. A task to stack on with no branch yet has its
    worktree set up first (as a subproject's is for its tasks), and one that's merged already has
    the task start from where it was merged. Merging a stacked task while the other is open puts
    its work on the other's branch, as stacked pull requests do, so it reaches the base branch
    with the other's merge. Once the other is merged, the stacked task goes where that went
    instead, as GitHub retargets a pull request whose base branch is deleted: its agent is told
    to merge, and open its pull request, there (retargeting one it has first), its merged checks
    look there, and its _Changes_ and reviews start from the later of its merge bases with that
    and with where it started, so a squashed parent's work isn't counted as its own before
    it's rebased, nor after, even once the parent's branch is deleted. Where it started is kept
    as `refs/huntaway/start/<task id>` in the repository, and goes when the task does. It's moved on
    to as much of the parent's branch as the task has taken in when either task's agent run ends,
    when the parent is done, before the parent's worktree or branch is removed, and when _Changes_
    or a review reads it. _Remove merged worktrees_ counts a stacked task merged into the
    project's base branch as merged too. Stacking doesn't make it wait for the other task: add a
    dependency for that. A task can't start from one that (by way of others, or a subproject it's
    in) starts from it. Deleting a merged task keeps the tasks stacked on it going where it went:
    when that's the branch of a task it was stacked on that isn't merged yet, they're stacked on
    that one; otherwise one with a branch then starts from the commit where its own work starts,
    and one without is a task on that branch. A stacked task's pull request goes to the repository
    the other task's branch is pushed to, or, while that has no remote of its own (it isn't pushed
    yet), wherever the other task's pull request goes.
  - **A branch** becomes its base branch, fetched first as the project's is. A remote's branch
    is the branch of that name when it's on the remote the name alone follows (usually `origin`,
    where the task's pull request goes). Another remote's (`upstream/feature`) isn't a branch the
    task's pull request can target: as for a pull request from a fork, the task starts from its
    latest commit (fetched even if it never was before), with the project's base branch as its
    own, so its pull request has that branch's commits too, and its _Changes_ and reviews start
    after that commit.
  - **A pull request** in the project's GitHub repository (the one its tasks open theirs in, going
    by its base branch's remote; looked up with gh, as the task's GitHub account) is its branch, as
    for a task, when that's the branch its name alone follows in the project's repository. A merged
    one is where it was merged; one from a fork, closed, or whose branch the name follows elsewhere
    (to another remote), starts from its head commit, fetched by its SHA, with the pull request's
    base as the task's (so its pull request has the other's commits too).
  - **A commit** is where its branch starts, fetched by its full SHA if the repository doesn't have
    it; its base branch stays the project's, and its _Changes_ and reviews start after the commit
    when the base branch doesn't have it. Such a review, and the summary of its changes, read the
    branch's changes from where it started rather than its pull request's diff, which has more.
    The task's log says where it started. Its branch, base branch and worktree folder are saved as
    soon as git makes them, so a setup script that fails doesn't lose them. It can't change once the
    task's branch exists (it's set up again from that branch), a subproject's tasks start from the subproject's branch, and a task
    that doesn't use a worktree has nothing to start. `base_branch` and `start_from` replace each
    other. `GET /projects/{id}/branches` lists the branches of a project's repository, latest first.
- **Temp folders:** each task's agents get a temp folder of their own,
  `<system temp>/ha-<hash of the data dir>/<first 12 hex digits of the task id>` (kept short, as
  sockets in it can't have paths over 107 bytes), as `$TMPDIR` for its runs (Claude and
  Codex) and its terminals, so what they leave there (test servers' data, build and test output,
  logs, browsers' profiles) doesn't pile up in `/tmp`. They're told to use it, Claude gets it as an
  `--add-dir` and Codex as a writable root. Review threads share the folder of the task they
  review. It's deleted as soon as the task is done and no agent (its own or a reviewer) is running
  in it, or once the last one stops if the task went to _Done_ while it ran, and when the task is
  deleted; a sweep every ten
  minutes (and at start) deletes those of tasks that are done or deleted (while the server was
  down, say). It's made again if the task's agent runs again; a run that starts while its folder
  is being deleted gets a new one. Each data dir has its own folder of them, so a server never
  deletes another's (a test server's, say). Nothing is deleted unless that folder is a real
  folder (not a link) of the server's user that no one else can write to, and only folders in it
  named after a task are. Files written straight to `/tmp` by name don't go with it.
  Before a task's folder or worktree goes, what its agents left running there is stopped (TS
  server, `apps/server/src/agent/leftovers.ts`): test servers whose `--data-dir` is in the folder,
  or that run the worktree's build or were started in it (unless their data is in another task's
  folder), the ia-shim runs in their data dirs, the folder or by the worktree's ia-shim, the
  agents under those shims, and what the servers started. The sweep also stops those whose task
  is done or deleted and whose folder went already. They're found from `/proc` (`ps` and `lsof`
  on macOS) by their command line, executable and working directory, and stopped by pid (TERM,
  then KILL after 5 seconds if it's still the same process); never the board itself, a server on
  its data dir, or a shim of the board's own runs.
- **Notifications**: Settings → Notifications picks how the browser tells you about tasks on
  every board it shows (other profiles' and other hosts' too): _Off_ (the default),
  _Notifications_ (the system's), _Sound_ (a chime) or _Both_, and for which events: a task that
  needs attention (a question, a permission prompt or a failed run), one that's ready to review
  (in review once its automatic review passes, or with none to wait for; it has to stay so for
  5 seconds, as a review or a run can start straight after), and optionally Ready for merge and
  Done. A notification shows the task's key, title and reason, and clicking it opens the task.
  _Enable_ asks the browser for permission. Browsers only show notifications for secure pages
  (HTTPS or localhost), so a board opened over plain HTTP on a LAN address can't have them, and
  the section says so; the sound needs a click or key press on the page since it loaded. One of
  the browser's tabs or windows notifies, and none do for the task open in a focused window,
  for tasks that were waiting already when the page loaded or reconnected, for a move you made
  yourself or a run you stopped. The tab title (`(2) Huntaway`) and icon count the tasks that
  need attention, and the desktop app shows the count on its dock or taskbar badge. The settings
  are kept in the browser.
- **Phones and tablets:** below 700px wide (a phone) the board has a narrow layout. The sidebar
  is a drawer, opened with the menu button at the start of each page's header and closed once
  it's taken you somewhere (or with a tap beside it, or Escape). A board shows one column at a
  time: tabs above it with each column's count pick one, as does swiping sideways, and the board
  opens on the column picked last (before any is picked, _Needs attention_ if it has tasks,
  else the first column with some). The list view stays as it is, with each task's title on a
  line of its own. A task opens over the whole screen with a back button, its tabs first in a
  row that scrolls sideways and its details as a tab. On a touch screen Enter in the composer
  starts a new line and the send button sends (Ctrl/Cmd+Enter does too). Dialogs and menus fit
  the screen and scroll, and buttons are larger to tap. Dragging doesn't work on touch screens,
  so on a phone, and on any touch screen (a tablet keeps the desktop layout), each card and row
  has a **⋯** button whose menu moves the task to another column as dropping it there does
  (into _In progress_ starts its agent), or completes it as Done, Not done or Won't fix. A task
  beside a board is at least 480px wide, so it's usable on a tablet. Wider windows and the
  desktop app keep the desktop layout. To install the board on a phone and have it push
  notifications, see _Push notifications on a phone_.
- **Status scripts** (API 37, 38): a project's status scripts run with bash when one of its
  tasks moves to another column, whoever moved it (you, its agent, a review or a merge), e.g. to
  send a notification, update another tracker or clean up a finished build. Each column has its
  own script, run when a task moves into it, and the _Any column_ script runs on every move,
  before the column's. They run in the background in the task's worktree (the repository when it
  has none), one at a time per task in the order the changes happened, and each is stopped after
  5 minutes. Its output, or why it failed, goes in the task's thread. They get the setup script's
  variables (`IA_WORKTREE_PATH` is empty without a worktree) and `IA_OLD_STATUS`, `IA_NEW_STATUS`
  (`backlog`, `todo`, `in_progress`, `needs_attention`, `in_review`, `ready_for_merge` or
  `done`), `IA_TASK_KEY`, `IA_TASK_TITLE`, `IA_RESOLUTION` (when done) and `IA_PR_URL`. The API
  has the column scripts in `status_scripts` (`{"done": "…"}`) and the any-column one in
  `status_script`.
  This repository's own project frees a done task's worktree build output (`target`,
  `apps/web/dist`, about 2 GB each) with this _Done_ script:

  ```bash
  "$IA_REPO_PATH/scripts/clean-worktree.sh" "$IA_WORKTREE_PATH"
  ```

  `scripts/clean-worktree.sh` only cleans linked worktrees, never the main checkout the daemon
  runs from, and keeps `node_modules`. A task that's reopened builds again from scratch.

- **Subprojects:** a task can be a subproject (pick **Subproject** at the top of the new task
  dialog, pass `type: "subproject"` or `is_subproject` to `create_task`, or _Make it a subproject_
  in a task's sidebar). It's a task like any other, with its own worktree, thread, changes, review
  and pull request into the project's base branch, and clicking its card opens it beside the board.
  The card also shows how many of its tasks are done, and its **Board** button (or _Board_ in the
  task's header) opens the subproject's own board of tasks, as a kanban board or a list. The
  subproject's branch collects its tasks' work: each task gets a worktree branched from
  it (the subproject's worktree is set up first if needed), its agent is told to open its pull
  request against that branch (pushing the branch if the remote doesn't have it yet), and
  _Ready for merge_ merges it there instead of the project's main branch. The subproject's own
  agent plans and coordinates: tasks it creates with `create_task` go in the subproject, and
  `list_tasks` lists them. The subproject's column follows its tasks (and its own agent), by
  priority: _Needs attention_ if any of them is waiting on you, else _In progress_ if any is being
  worked on, else _In review_ once they're all in review or merged (tasks still to do don't
  count). It stays in review after the last one is merged, and its card then says so. Moving it
  to _Ready for merge_ or _Done_ is up to you. When they're done, the subproject is merged as a
  whole like any other task (its agent asks first if some of its tasks aren't done). Deleting a
  subproject deletes its tasks. Subprojects don't nest (API 17).
- **Changes** (API 66): a task's _Changes_ tab works like lazygit, in its worktree (or its
  project's repository when it has none). Panels on the left list the branch (_Status_: its
  commits since the base branch, and against its upstream), the changed files (a tree, or a
  list with `` ` ``), the commits (the branch's, then a few from its base) and the stashes; the
  main panel shows what's selected: the branch's whole diff against its base, a file's unstaged
  and staged changes, or a commit's or stash's. A task in a worktree of its own has a fifth panel,
  _Turns_ (API 70): its agent's turns, latest first, each showing what that turn changed (see
  _Checkpoints_ below); `g` rewinds to before one. `1`–`5` or ←/→ move between panels, ↑/↓ (or
  `j`/`k`) through a list, and the bar at the bottom shows the keys for where you are (each one
  can be clicked; `?` lists them all). In the files, space stages or unstages a file or folder,
  `a` everything, `d` discards, `c` commits (with a summary and description; a message not
  committed is kept for the next try), `A` amends the last commit and `s`/`S` stash. Enter goes
  into a file's diff to stage single lines: space stages (in the staged changes, unstages) the
  line under the cursor, `v` or shift+↑/↓ select a range, `a` the whole hunk, `d` discards
  them, Tab switches between the unstaged and staged changes and Esc goes back; clicking,
  shift+clicking and dragging over lines selects them too, and each hunk has buttons. In the
  commits, `g` resets the branch (soft, mixed or hard) and `r` rewords the last commit; in the
  stashes, space applies, `g` pops and `d` drops. Right-clicking a file, commit or stash shows
  its menu. The view checks for changes every few seconds (the agent may be making them), and
  keys pressed while a change is being made wait for it, so pressing space again stages the next
  line. The staged lines are a patch the UI makes from the diff it shows (`apps/web/src/components/changes/diffs.ts`),
  applied with `git apply --cached`; if the file has changed since, git refuses it and the view
  shows why. A file whose diff isn't UTF-8 (one in another encoding) is shown but only staged or
  discarded whole, as a patch made from the text the view shows would write its other bytes back
  wrong. A host before API 66 shows the branch's diff alone.
- **Diffs and comments for the agent:** the Changes tab's diffs are highlighted for their
  file's language (by extension or name; the theme is the board's own colours), with
  [Shiki](https://shiki.style)'s TextMate grammars in a web worker (`apps/web/src/components/changes/highlight.worker.ts`),
  so a big diff doesn't hold up the page. Each language's grammar is fetched the first time a
  file in it is shown; a file's diff is highlighted once it's scrolled near, each hunk on its own
  (lines show plain until then), and files with more than 5000 lines in their diff, and lines over
  1000 characters, are left plain. `|` (or _unified_/_split_ in the main panel's title) shows
  diffs side by side or unified, and the choice is kept in the browser. Lines can be commented on
  for the agent: `n` comments on the line under the cursor or the range or hunk picked (when
  staging), or on the lines picked by their numbers in a commit's, a turn's, the branch's or a folder's diff
  (click, shift-click or drag over them); a line's comment button (on hover) does the same for it,
  or for what's picked if it's one of those lines. The note is written under the lines (Enter adds
  it, Esc leaves it for later), and the comments wait there, in a bar at the bottom of the tab (a
  list that goes to each one, _Send to the agent_ and _Discard_) and as chips in the thread's
  composer, until a message takes them: the bar's button sends them alone, and a message sent from
  the composer takes them after what's typed. Either way they go as one message, each with its
  file, its lines (numbered in the new version, or the old one for removed lines), the lines as
  the diff has them and its note, and while the agent works it's queued or steered as any message
  is then. Comments, and notes still being written, are kept in the browser per task
  (`apps/web/src/components/changes/lineComments.ts`), as composer drafts are.
- **Checkpoints and rewinding** (API 70): a task in a worktree of its own keeps a checkpoint of
  its files before each of its agent's runs (when anything changed since the last, so the first
  run's is the task's baseline) and after each of the agent's turns, including ones that were
  stopped or failed. A checkpoint is a commit of everything git doesn't ignore in the worktree
  (tracked files as they are on disk, and untracked ones; untracked files over 50 MB are left
  out), whose parent is the HEAD then, kept under `refs/huntaway/checkpoints/<task id>/<n>` in the
  project's repository (so `git log --all` shows them). It's made with a scratch copy of the
  worktree's index (`GIT_INDEX_FILE`, `git add -A`, `write-tree`, `commit-tree`), so the index,
  branch and stashes aren't touched. The `checkpoints` table ties each turn's to its run, its
  number and the message that started it. A task keeps its last 200, and they're deleted (refs
  and rows) when its worktree is removed. Tasks working in their project's repository, review
  threads, documents and scratch tasks have none.
  - **What each turn changed:** the _Turns_ panel of the _Changes_ tab shows the difference
    between the checkpoint a turn started from and its own. Files git brought in during the turn
    are left out (and listed) unless the turn changed them itself: those changed by commits HEAD
    moved to rather than made in the worktree (a pull or fast-forward, the commits a rebase went
    onto, told apart by the worktree's HEAD reflog) and by merges made there, except where the
    merge's result isn't git's own (conflicts resolved, from `git show --remerge-diff`). The
    task's _Review_ tab lists what each round of fixes a review sent back changed (the turns of
    the run it started, whose message is marked with `review_round`). A turn from before a host
    had checkpoints has none to start from, so its changes aren't shown.
  - **Rewinding:** hovering one of your messages in the thread shows _Rewind to here_ (or `g` in
    the _Turns_ panel). It puts the worktree's files back to the checkpoint taken before that
    message's turn: only the files that differ are written or removed (never through a symlink),
    files git ignores (build output) are left alone, and so are submodules and other repositories,
    files marked `skip-worktree` or `assume-unchanged`, and whatever the checkpoints don't have
    that a restored file would replace (a folder in its way that still holds ignored files, or a
    file ignored since); the note in the thread lists them. Those files go back to HEAD in the
    index. The files as they were are kept as a checkpoint of their own (named in the note). If
    commits were made since, the branch can be moved back too (`git reset --soft`, after the
    files, off by default). The
    agent's conversation can go back with it, so it carries on from before that message: its
    next run resumes Claude Code's session with `--resume-session-at` (the session's last message
    from the turn before) or reverts the Codex thread with `thread/revert` (to before the turn);
    going back to before the thread's first message starts a new conversation. Until that run,
    a note over the composer says so (_Keep the conversation_ cancels it), and the message goes
    back into the composer to edit and send again. The rest of the thread stays, with the
    message marked _rewound_, and the checkpoints after it are marked stale and can't be
    rewound to again. A rewind is refused while the agent or a review of the task is running,
    or while a merge or rebase is in progress in the worktree. `GET /tasks/{id}/turns` lists the
    turns, `GET /tasks/{id}/turns/diff?from=&to=` diffs two checkpoints, `POST /tasks/{id}/rewind
    {message_id, conversation, branch}` rewinds and `DELETE /tasks/{id}/rewind` keeps the
    conversation.
- **Terminals:** a task's _Terminal_ tab opens a shell (xterm.js) in its worktree, or where its
  agent runs if it has none. It is a tmux session on the task's host, on a tmux server of its
  own (`tmux -L ia-<host id>`, so your other tmux sessions aren't touched, though `~/.tmux.conf`
  still applies). The session outlives the browser and server restarts, ends when the shell
  exits or with **End**, and is killed when the worktree is torn down or the task deleted.
  `CLAUDE_CONFIG_DIR` is set to the task's Claude config. The host needs `tmux` installed. Terminals
  on linked hosts are relayed by the hub (API 7). Copying in tmux reaches the browser's
  clipboard (OSC 52); Shift+drag selects in the browser instead.
- **Terminal tools:** TUI programs or scripts (`lazygit`, `nvim`, `~/bin/review.sh`…) set up on
  a host's page (Settings → the host → _Terminal tools_) show as shortcuts next to a task's
  tabs. Each opens in its own tmux session in the task's directory, run through your login
  shell (so it gets your usual `PATH`). Unlike the shell, a tool session lasts only while a
  board has it open: the board renews it every 30 seconds while the app is open, and the host
  ends tool sessions that nobody is attached to and nobody has renewed for 90 seconds.
  Reloading the page keeps them. **Close** ends one straight away. If a tool exits with an
  error, the message stays on screen until you press Enter (API 13).
- **Browser pane:** in the desktop app, the globe button in a task's header opens a browser beside
  its thread (HA-275), to look at the app the agent is building: an address bar (a bare port such
  as `5173` opens `localhost:5173`), back, forward, reload, the page's DevTools, and _Open in your
  browser_. Drag the bar between them to resize it (double-click for half and half). Each task
  remembers the page it was last on, or opens on its PR preview; closing the pane keeps the page
  loaded until another task is opened. It shows only `http:` and `https:` pages, in a session of
  their own (`persist:huntaway-browser`: cookies and storage apart from the board's), with no
  access to the app and no permissions beyond the clipboard and full screen; a link that opens a
  new window opens in the pane. A browser's board has no pane, since its frames hold only the
  board's own pages (`frame-src 'self'`, for agent-written documents' sake, HA-266), and
  `localhost` is the machine the app runs on, not a linked host's.
- **Permissions:** in _Ask_ mode, Claude's permission prompts are routed to an approval card in
  the thread: Allow, Always allow (for that thread), or Deny. Claude asks on its own output
  (`--permission-prompt-tool stdio`: a `can_use_tool` control request in the run's `out.jsonl`)
  and gets the answer on its input (`input.jsonl`); a prompt still open when the server restarts
  is asked again, and can be answered as before. A `/compact` run, which takes no input and calls no
  tools, has no prompt tool (until HA-225 it had the board's MCP server's `permission_prompt`). Codex's approvals come on the
  run's output too (the app-server's requests, which its adapter writes there) and get the same
  card, which names the agent asking; a Codex `/compact` declines them. Runs that ask on their output are
  run format 3 (4 when they call the board's tools there too, see _Agent tools (MCP)_, and 5 for
  Codex's): an older build that's rolled back to stops them (it couldn't answer them) rather than follow them.
- **Questions and plans** (API 64) are cards in the thread rather than approvals, and the task's
  card says what's asked ("Which database should the cache use?", "Plan ready for approval: …").
  Keys 1–9 pick an option in the latest one that's waiting, unless you're typing.
  - `request_user_input` can give `options` (each a `label` and a `description`, up to nine),
    `multi_select` and `allow_other` (whether a free-text answer is offered too; it is by
    default). The card's buttons answer it, and the answer goes as your message (the question
    quoted, then the options picked or what you wrote), which resumes the agent. A reply typed in
    the thread settles it too. The agent's turn ends when it asks, so it stays answerable after
    its run ends (`POST /tasks/{id}/questions/{message id}` with `choices` and `text`).
  - Claude's `AskUserQuestion` shows its questions with their headers, options and descriptions,
    multi-select and an _Other_ answer. The answers go back the way headless Claude Code takes
    them, in the tool's input (`updatedInput.answers`, each question's text to its answers joined
    with commas). Codex's own questions (`item/tool/requestUserInput`, in its plan mode) get the
    same card and are answered by question id; a question marked secret takes a password field
    and its answer isn't shown in the thread. _Dismiss_ declines them.
  - A plan (`ExitPlanMode`) shows as Markdown. **Approve** picks the mode the thread carries on
    in (starting at the thread's own mode, if it has one other than Plan, else its default; or
    Accept edits, Auto or Bypass), which the running Claude Code switches to as
    well (`updatedPermissions` with `setMode`; it can't switch to Bypass, which the board covers
    by allowing every prompt). **Keep planning** sends it back with your feedback.
  - They're asked whatever the thread's mode or _Always allow_ list, except _Don't ask_, which
    declines them. A question or plan whose run ended before it was answered (stopped, say) can
    still be answered: the answers (or the approval, or the feedback) go to the agent as your
    message. Once a message has been sent to the agent after one (by you, the board or another
    agent), it isn't answered any more. Only the first answer counts, so two tabs can't both send one.
  - `POST /permissions/{id}` takes `answers` (a list per question of option labels and typed
    answers), `mode` (for a plan approved) and `feedback` (for one sent back) besides `decision`.
- **Permission modes:** each host has a default mode (its agent defaults), each project can
  set its own (Settings, or _Host default_), and every thread can override it from the selector under the message box (Shift+Tab cycles Ask → Accept edits →
  Auto → Plan). Modes map to Claude's `--permission-mode`: _Ask_ (`default`), _Accept edits_,
  _Auto_ (Claude's classifier), _Plan_, _Don't ask_ (deny anything not already allowed) and
  _Bypass_. A change applies from the next message, except that switching to Bypass or Don't ask
  also settles prompts in the current run. Approving a plan (`ExitPlanMode`) moves a thread
  in Plan mode back to its default mode (Ask if that's Plan too), or to the mode picked on the
  plan's card.
- **Analytics** (sidebar) tracks when you prompted which project and task, for timesheets. It's
  built from the threads' own history (your messages, starting a task, moving it to _Ready for
  merge_, and agent runs), so it covers work from before it existed, across every host with the
  profile. Messages from other agents (`send_to_task`) and the board's own prompts (review fixes)
  don't count. Active time credits each prompt with the time since your previous one on any task,
  up to a break (30 minutes by default), and the first prompt after a break a few minutes (5 by
  default); both are adjustable. The _Report_ tab filters by time range and project, with a chart
  per day, totals per project and task, a prompt log and a CSV export (one row per day and task).
  The _Calendar_ tab shows months or weeks, and each day's timeline of your prompting and the
  agents' runs (API 16). The _Disk_ tab shows how much space each project takes up on its host:
  its repository (and how much of that is `.git`), each task's worktree, its agent runs' folders
  (output and logs, kept 14 days after a run ends) and its scratch folders, as `du` counts them,
  and each host's database (API 59). Worktrees of done tasks, and worktrees of a project's repository in its
  worktrees folder that no task on the host has, count as reclaimable. **Reclaim space** (API 39) removes the done tasks' worktrees that are merged and clean, as _Remove
  merged worktrees_ does for each project, and lists what it removed, how much that freed and what it kept; click a worktree to open its task and
  remove it there, which is also the way to remove a worktree no task has. The
  folders are measured when the tab first opens and again on refresh (API 35).
  The _Tokens_ tab (API 98) shows where agents' tokens go: in total and per day, by what they were
  spent on (tasks' own agents, reviews, summaries, compactions, scratch and group tasks), by model
  (Claude's and Codex's), and per task, with a review or summary thread's tokens counted towards
  its task and a subproject's tasks' towards the subproject (expand it to see each). It can measure
  all tokens (uncached input, cache reads and writes, and output), output tokens, or cost (Claude
  Code's; Codex doesn't report one). Each run's tokens are counted per model, subagents' included,
  from its output once it ends (see `apps/server/src/agent/tokens.ts`): runs from before this was kept
  are counted at startup from the output the board still keeps (14 days of it), and older ones
  show only what they cost, as estimates. Its _Reviews_ part counts each reviewer's submission:
  how many found serious issues, how many tasks passed their first round, and how many rounds of
  fixes each model's work took, by the model the task's agent used and by reviewer. A round is a
  review of the task by all of its reviewers (each submission keeps when its round started), and a
  task's first round and rounds of fixes count all of its rounds, those outside the range too. Reviewers also
  list minor issues (`submit_review`'s `minor_issues`); reviews from before that count as noting
  minor issues when their summary mentions some, and the follow-ups are the tasks the reviewed
  task's agent created after such a review. `GET /profiles/{id}/token-stats?from=&to=` has the data.
- **Subagents:** each subagent Claude or Codex starts is a row in the thread
  showing whether it is running (in the foreground or background), done, failed or stopped. Expand
  the row to read its prompt and transcript. They are read-only: you reply to the parent thread,
  and stopping the parent stops its subagents. The **Agents** pill in the header counts running
  and finished subagents and jumps to each. A permission prompt raised inside a subagent shows
  on the parent thread and names the subagent that asked.
