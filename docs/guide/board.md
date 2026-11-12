# Using the board

The board shows every profile at once. The sidebar lists the profiles at the top, each with a bar of how many of its
tasks are in progress (blue), need attention (amber), in review (purple) and merging or waiting to merge (pink), leaving
out the columns with none. Clicking one opens the **profile's board**: all of its tasks together, from every project and
every host that has the profile, with its group and scratch tasks. Its _New task_ form picks the project, or makes a
scratch task: type `in:` and a project's key (`in:HA`), `in:none` for a scratch task in no project or `in:group` for a
group task (this was `@HA` on the old board until HA-303). Below the profiles, _Guide_ opens this guide in the app, a
page at a time, with the open page's sections beside it.

Typing `@` in a task's message box or the _New task_ form's description (HA-303) lists projects and tasks to mention:
those on the profile's own board first, then those of the profiles that let its agents in. What follows the `@` filters
them by key, title, project key or project name, and Up/Down, Enter or Tab (or a click) picks one, which puts its key
in place of the `@`: `HA-12` or `HA`, or `work:SD-3` for one on another profile's board, as the board's MCP tools
take it, so the agent can look it up. Escape closes the list, and while it's open Enter doesn't send or create
anything. An `@` in a word (an email address) doesn't open it.

A task's key in a thread or a description is a link to the task (HA-307). It opens the task in a dialog over the page
you're on (HA-326, `?modal=<id>`), rather than moving to its board: a task open in the side panel stays there beside it,
and Escape, the backdrop or the close button closes the dialog only. A routine report's thread key and the assistant's
tracked items open the same way.

The sidebar's project list is one profile's: the one whose board you opened last, which is marked
with a bar beside its name (its initial in colour, the others' grey) and named on the _Projects_
heading. It stays while you're on other pages, and opening a project it doesn't list (from a
link, or a starred task) moves it to that project's profile. Pin a project to keep it listed
whichever profile is active by right-clicking it and picking _Pin to every profile_ (a group's
menu pins the projects it lists); pinned projects show a pin, and the initial of their own
profile when it's another one. The active profile and pinned projects are saved in this browser,
and the board opens on the active profile's board.

Under the active profile's **Assistant** (see [assistant.md](assistant.md)), **Docs** lists its
documents (HA-281): the reports, plans and write-ups its agents publish with the `docs` MCP server
(see _Docs_ in [agents.md](agents.md)), with each one's latest version, when it was updated and the
task that published it, which opens from there. A document opens on its pages, at
`/docs/<profile>/d/<slug>/`: a menu of them (nested by their paths), the page, and a picker of its
versions with each one's message. Links between pages open them there, in the same version; links out
open in a new tab. Pages come rendered from their host and show in a sandboxed frame, as plans do.
Their images (HA-327: AVIFs the host keeps, see _Docs_ in [agents.md](agents.md)) are fetched by the board
and given to the frame as data: URLs; remote images aren't shown.
Local documents collect no answers yet, so their form fields (`<Approval />`, inputs) are read-only.
Selecting text in a page offers **Comment** (HA-302), as on the hosted site: it quotes the text in the
**Comments** panel beside the page, where you leave a comment for the agent. A comment belongs to the version it was
made on: the panel lists the page's comments, highlighted in the page (clicking one scrolls to it), each with Edit and
Delete, and below them those on other pages and versions. **Send to the agent** sends the unsent ones, as one message,
to the task that published the document (its latest version's, while it's on the board and not in an archived project);
an edited comment is unsent again. Agents can also read them with the docs server's `get_feedback`. The header's comment
button hides the panel. Comments stay on the host: publishing to hosted docs doesn't take them.
A task's thread links each document it published to its page here. Docs lists the documents of every host the profile
is on.

Docs is a tree of folders (HA-290), as on the hosted site: folders first, then documents, each by name, and
each document one entry however many pages it has. A document an agent publishes goes in a folder named after its
task's project (a task with no project's at the top level) unless the agent gives another; documents from before
folders were filed the same way, by the task that published their first version. A folder closes and opens with a
click, and stays as you left it in this browser. A document's **Move** (or dragging it onto a folder, or onto a
document in one) puts it in another folder: type a path like `Huntaway/plans`, with the folders there are suggested, or
a new one to make it, or nothing for the top level. A folder's **Rename** moves everything in it, and in the folders
inside it, to the new path. A folder is there while a document is in it, and moving a document doesn't change its
address. A later publish leaves a document where it is. On a profile on several hosts, each host's documents are a tree
of their own, under its name.

Documents can be published to a hosted docs site (HA-282): [dire-kiwi/docs](https://github.com/dire-kiwi/docs),
https://docs.nest.dire.nz by default, where they can be read and shared. **Connect to hosted docs** at the top of
Docs connects the profile: **Sign in** shows a code and a link to the site, where you sign in, check the code and
choose **Allow** (the OAuth device flow; the host waits for it), or paste a personal access token from the site's
**Access** page. The host keeps the sign-in and renews it; the board only sees whether it's connected and as whom.
**Disconnect** forgets it on the host (revoke it under **Access** to end it on the site too). A document's
**Publish** publishes the version shown, with all its pages, its title and its version's message. The first time
it asks for the slug on the site (the local one by default), and a new document there goes in the folder it's in here;
after that each publish adds a new version of the same document there, wherever it is (moves on either side leave
the other as it is). The document then shows the version published there, with a link, or that it has local changes
since. The site's errors (a slug another user has, a sign-in that has expired or been revoked) show in the dialog.
To try it against a local site, run `DOCS_DEV_LOGIN=1 cargo run` in a checkout of dire-kiwi/docs (after building
its `frontend`, see its README), and connect to `http://localhost:3000`.

Add a project with the **+** by the _Projects_ heading. Its _Folder_ tab picks a folder on the
host (a repository, or a new folder that's created for it). Its _GitHub_ tab clones a
repository instead: it lists the ones gh can reach on the host as the profile's GitHub account (see
_GitHub accounts_), or gh's active account when it has none: those the account owns, collaborates
on or has contributed to, most recently pushed first. Typing filters them and also searches its
organizations' repositories by name (they aren't listed, as an organization can have thousands);
`OWNER/REPO` or a pasted github.com URL picks any other. The repository is cloned with
`gh repo clone` as that account, over the protocol gh is set up to use for the host (so SSH uses
the host's SSH keys, and any git config for the folder it goes in), into the profile's **clone
folder**, in a folder named after it (the path can be changed before cloning). Each profile sets
its clone folder per host in Settings → Profiles → Edit (`clone_dir`); it's `~/<profile name>`
(`~/work`, `~/personal`) until it's set. A folder that's already a clone of the repository is added as it
is, unless it's one of the profile's projects already. A clone that fails (its checkout too) is
taken away again, and a request for a folder that's being cloned into waits for that clone to be
added first. The dialog remembers which tab was used last. The `profiles.githubRepos` RPC method lists or searches
the repositories and `projects.clone` (`repo`, `repo_path`, `name`, `key`) clones one and adds it.

The _Folder_ tab can also **create a GitHub repository** for the folder: tick _Create a GitHub
repository for it_, pick _Private_ (the default) or _Public_, and optionally an owner (an organization;
the profile's GitHub account by default) and a repository name (the folder's by default). The
repository is made with `gh repo create` as the profile's GitHub account and becomes the folder's `origin`.
A folder that isn't a git repository yet is made one (a folder that doesn't exist is created), and a
repository's commits are pushed; one that already has an `origin`, or is only a subfolder of a repository,
is turned down, and a repository that can't be made leaves the folder as it was. A push that fails
after the repository is made still adds the project (`github.push_error` says why).
The `projects.createOnGithub` RPC method (`repo_path`, `visibility`: `public` or `private`, `repo_name`, `owner`,
`name`, `key`) does it and returns the project with `github: {full_name, pushed, push_error}`.

The sidebar lists projects in alphabetical order, with each group in its place by its own name
and its projects in order inside it. Right-click a project and pick _Add to favorites_ to list it
under _Favorites_, a section of its own above the other projects (in alphabetical order too, and
out of its group, whose row stays while it has group tasks even if all its projects are favorites);
_Remove from favorites_ puts it back. Favorites are saved in this browser.

Rename a project, change its key or point it at a moved repository folder in its settings (or
with the `update_project` tool). After a key change the old task keys (e.g. `OS-2`) still
find their tasks, and no other project can take them. A new repository path must be the same
repository (told by its worktrees, the commits its history started from, or its tasks' branches);
_Move the folder there_ (`move_repo`) moves the folder itself, with the project's agents stopped.
Either way paths inside the folder (worktrees kept there, the worktrees folder) move with it, the
task worktrees are reconnected (`git worktree repair`), and conversations that ran in the old
folders can still be resumed.

Group projects by right-clicking one in the sidebar (or with _Group_ in its settings). A group
shows as a collapsible folder with its projects underneath, and clicking it opens one board
(or list) with all of their tasks. Right-click a group to rename or ungroup it. Groups are
saved on the host, per project, so projects on different hosts are in separate groups; which
groups are collapsed is saved in this browser.

Hide a project from the sidebar by right-clicking it and picking _Hide from sidebar_ (a group's
menu hides all of its projects). Each host's hidden projects sit under a _N hidden_ row at the
end of its list, which carries their counts and opens to show them; right-click one there to
show it again. A hidden favorite stays there rather than under _Favorites_, and making a hidden project a
favorite shows it again. A hidden project is only left out of the sidebar: its tasks are still on its
profile's and its group's boards. Hidden projects are saved in this browser.

Archive a project you're done with by right-clicking it and picking _Archive…_, or with _Archive
project_ in its settings. It goes off the board for every browser: out of the sidebar, its
profile's and group's boards, and out of agents' `list_projects` (and `list_tasks` with `project_id='all'`).
It takes no new tasks and its agents don't start (messages, other agents' `send_to_task`, reviews
and idle compaction are refused; tasks waiting for their dependencies or a merge slot keep
waiting until it's unarchived), but its tasks, worktrees and branches are kept. It can't be
archived while one of its agents is running. Unarchive it in Settings → _Archived projects_, the only place it's
listed (its old board link says it's archived and points there).

Star a task (the star by its title, or _Star_ in its card's right-click menu) to list it under
_Starred_ at the top of the sidebar. Set a reminder to come back to a task with the bell beside its
tabs (or the card's menu): in an hour, tomorrow morning, next Monday or at a time you pick, with a
note on what for. Tasks with reminders are listed under _Reminders_, soonest first; once one comes
round it shows as due, counted on the section's heading, until you clear it or set a new time
(right-click it in the sidebar). Agents can do both too, with `starred`, `remind_at` (a delay
like `2h`, or a time) and `reminder` on `create_task` and `update_task`. Stars and
reminders are saved on the task's host; which of the two sections are collapsed is saved in this
browser.

**Pens** gather tasks from any of a profile's projects, and its tasks in no project, into
named sets: the work you're on today, a feature that spans projects, or tasks you've parked to
come back to in a few days. The profile's board shows them as tabs over its columns: _All_, with
every task, then a tab for each active pen, in the pens' order, each with how many
tasks it has; the board stays on the tab you picked last (in this browser). A task is in one pen
at most. Put one in a pen from its card's menu (_Pen: …_, or _New pen…_; with tasks picked with
the lasso, the selection bar's _Pen_ does it to all of them), by dropping its card on the pen's
tab, or by making it on that tab; _Out of …_ in its menu, or dropping it on _All_, takes it out.
The **+** after the tabs makes a pen. Right-click a tab (or click it again once it's open) to
rename, recolour, mark inactive (or active), move or delete it; deleting a pen leaves its tasks on
the board, in no pen. Each pen is **active** or **inactive** (a new pen is active): an
inactive pen keeps its tasks but has no tab, and inactive pens are listed under _N inactive_ at the
end of the tab bar, which marks one active again.

Beside _All_ are two views of the pens' tasks: **Active**, every task in an active pen, and
**Inactive**, every task in an inactive one (tasks in no pen aren't in either). Each has a row for
each of its pens, in the pens' order, across the board's columns (in the list view, a section of
its tasks; on a phone, under the column shown), headed by the pen's name and how many tasks it
has. Click a row's header to collapse it to just the header (the board remembers which, in this
browser); its **+** makes a task in that pen. A card dropped in a row's column moves to that column
and goes in that pen, and one dropped on a row's header goes in its pen.

Each pen has a **colour**: a new one gets one the profile's other pens don't have, and
_Colour…_ in its tab's menu changes it. A card whose task is in a pen has a small label over it
with the pen's name in its colour, on project boards and on the profile board's
_All_ tab (not on the pen's own tab); clicking the label opens the pen's tab.

**Stack cards** (HA-388, part of HA-386): on the kanban board, the tasks of a stack (stack levels, see _Stack levels
and GitHub's stacked pull requests_ in [concepts.md](concepts.md)) are gathered into one card, drawn as a pile, in
place of their own cards. A stack is found from its bottom task (one that starts from a branch, or whose task below is
gone) up through the tasks that land after it. Where two land after the same level (the bottom too), the stack's main line goes
on with the one stacked on it on GitHub, else the lowest numbered (as the server's merge of the whole stack takes it); the other, and whatever lands after it, is **beside** the stack (a fork) and lands on its own. A stack has
at least two tasks, and merged levels stay in it as its history. The card shows:

- _Stack_ (or _Stack #12_ when it's on GitHub), how many levels it has and how many beside it, and a dot while any of
  their agents works.
- The stack's title and description: a model writes them from the levels' titles and descriptions as the
  stack forms or its levels change, kept on the bottom task (`stack_title`, `stack_description`). _Edit its title and
  description…_ in the card's menu changes them by hand, which pins them (`stack_pinned`); _Write them again_ there has
  the model write them again (the `tasks.updateStack` RPC method with `title`, `description` or `regenerate`). Until
  they're written, the card has the bottom task's title and no description.
- What's wrong (a level that needs your attention, failed checks, a restack conflict, a level waiting for you to say
  where it goes), what its landing waits on (the lowest open level of its main line: "“…” lands next: it passed
  review"), how many merges wait for your approval, and while it merges as a whole, how far that's got (how many of its main line's levels are merged). The card names
  levels by their titles, never by key; clicking a line opens that level.
- A bar along the bottom with a part for each level in landing order, in its status colour, pulsing while its agent
  works; the tasks beside the stack come after a gap. Hovering a part names its task (with its key); clicking it opens
  it. Clicking the rest of the card opens the level that lands next.

A card sits in _Needs attention_ if any of its open levels (beside it too) is there, else _In progress_ if any is,
else _In review_, _Ready for merge_, _To do_, then _Backlog_; once every level is done it's in _Done_, and it's
archived with them (it leaves _Done_ once the last of them is archived).

The card's **spread** button (or _Spread its cards_ in its menu) shows the levels' own cards again, each in its own
column, with a tab over it with its place in the stack ("2 of 3", or "beside") that **gathers** it back into one card.
The **Stacks gathered** switch in the board's top bar (shown when the board has stacks) gathers or spreads every stack
at once, and a stack spread or gathered on its own since then stays so. Both are kept in this browser
(`ia.board.stacks` and `ia.board.stackViews`, by the stack's bottom task), for every board.

**Merging a whole stack**: once every open level of the main line is in review with its review passed (or
none, and its agent not running) or already in _Ready for merge_, at least one is in review, no open task merges into
one of them (_Merges into_) and the lowest isn't held (its task below was closed without being merged, or deleted),
drag the card to _Ready for merge_, or pick _Merge the stack_ in its menu. That moves them all there
(`tasks.mergeStack`) to merge bottom first as one run of the merge queue. Until then the card says
which levels aren't through review yet, and dropping it on _Ready for merge_ or picking _Merge the stack_ says why
not; the other columns refuse it (moving several tasks at once is too easy by accident: spread the stack to move a
level). Tasks beside the stack aren't part of it, and land on their own.

How a gathered card goes with the rest of the board:

- **Selection:** a gathered card isn't picked by the lasso or Ctrl + right-click; spread the stack to pick its levels.
  Gathering or spreading lets the picked tasks go.
- **Sorting:** sorted by hand, the card takes the place of its top-most level in its column, and a task dropped above
  it goes before that level. Sorted otherwise, it goes by its most recently active level (latest activity), its bottom
  task's age (newest, oldest), its title, or what its levels cost together.
- **Filters and search:** the card shows if any of its levels (not archived) matches the filters, and says how many
  don't. When the status filter hides the card's own column, the card goes in the
  first column shown that one of its matching levels is in (in the order above), and the levels whose status is
  filtered out count as not matching; with none of its levels in a column shown, it's hidden. The search finds the levels themselves, and
  opens the one picked. The filter bar's count is of tasks, the card's matching levels among them.
- **Column counts:** the card counts as one card in its column, and its levels don't count in their own columns while
  it's gathered.
- **List, Triage and Graph views, and rows of pens:** levels stay tasks of their own there, as before (no stack cards).
- **Phone:** the card shows in its column, and its menu button (…) stands in for dragging it.
- **Archived and filtered-out levels:** an archived level stays in the list view's _Archived_ section and on the
  card's bar; a level the filters leave out is still on the bar, and counted as not matching.

The **pens thread** (_Pens thread_, at the end of the tab bar: a conversation that arranges the pens for you) and each
pen's **own thread** (_<pen> thread_ on the pen's tab, or _Open its thread_ in its menu: one that works on that pen's
tasks, in a folder of its own for its notes) are made the first time they're opened. They run on the profile's
**Threads agent** (Settings → Profiles); an old board's come over with its import. A pen's own thread is titled _Pen: <name>_, renamed with its pen and
deleted with it, and in it `create_task` puts new tasks in the pen and `list_tasks` lists the pen's tasks unless it's
told otherwise. Any agent can arrange pens with the pen tools (`list_pens`, `create_pen`, `update_pen`, `delete_pen`,
and `pen` on `create_task`, `update_task` and `list_tasks`; `create_pen` and `update_pen` take `active`, and
`list_pens` says whether each pen is active). Pens are kept on each host, per profile; a profile's board spanning hosts
merges them by name, and a task on a host without the pen yet makes it there as it moves in. The `pens.*` RPC methods
(`pens.list`, `pens.create`, `pens.update` with `active`, `pens.delete`) and `pen` (a name) or `pen_id` on
`tasks.update` do the same; a pen's `thread_id` says which task is its own thread.

A group's _New task_ form can also start a **group task** (pick _Group task_ in its project
picker). It isn't in any project: it sits on the group's board (keyed `G-<n>`, numbered across
the profile's groups; no project can use the key `G`, and one that had it moves to `GP`) and its agent
plans the work across the group's projects, creating and starting their tasks rather than
changing the repositories itself. Its card shows how many of the tasks it created are done,
and its details list them. It works in the profile's scratch folder with the group's
repositories readable, and follows its group when the group is renamed. A group whose
projects are all ungrouped or deleted stays in the sidebar (in italics) while it has group
tasks, so they can still be opened, resumed and deleted.

Any task can have **labels**: **Plan**, **Artifact** and **Diagram**, each asking its
agent for a document besides its other work. Add them in the _New task_ form by typing `/plan`,
`/artifact` or `/diagram` (several at once work), in the task's details under _Labels_ (they can
be added and taken off at any time; the agent hears of a change the next time it starts), or
with `labels` on the `create_task` and `update_task` tools. The agent writes each in the task's
own folder (`<data dir>/documents/<task id>`, which it can write in without asking, outside the
repository), wherever it does the rest of its work: `plan.html`, an HTML plan to iterate on;
`artifact.html`, a designed HTML page like a claude.ai artifact (the agent uses the
`artifact-design` skill when it has it, but the page stays on the board); or `diagram.mmd`, a
Mermaid diagram. With a plan, it writes the plan first and waits for you to approve it before it
starts the work; once you do, it can carry it out in the task or break it into tasks, and the
card shows how many of those are done. Each label gets a tab in the task, before the thread,
showing its document as the agent writes it: HTML in a sandboxed frame (its scripts run, but it
can't reach the board or other hosts: see below), a diagram drawn in the board with zoom, an SVG
download and a button that sends a parse error back to the agent. Reply under the document to ask
for changes. The board keeps a version from each turn that changed the file (the `tasks.document` RPC method, with
`label`, and `version` for an earlier one), and the task opens on its first label's document once there's
one to read. The board's _Type_ filter finds tasks by their labels too.

An HTML document's frame has a Content-Security-Policy that lets it load only scripts, styles and
fonts from cdnjs, jsDelivr, unpkg and Google Fonts (no remote images, requests, frames or form
posts), and no WebRTC (its policy also requires Trusted Types, which keeps a `javascript:` URL frame
in it from getting WebRTC back), so a page an agent wrote (say, prompted by a poisoned issue) can't send
what's in it, or your answers to it, somewhere else. Its links open in a new tab after your click in
the page; one it opens otherwise, the board asks you about first. In a browser, a page can still
send data out in a hostname of its choosing, without a click (HA-269):

- When the policy refuses a frame (one the page makes, or the page's own frame going to another
  host), Chrome has already looked the host up and connected to it, with the hostname in TLS SNI.
- For a `<link rel="preconnect">` (in the page's HTML or added by its script), Chrome looks the host
  up and connects to it the same way.
- A frame the page makes with its own HTML (`srcdoc`) can still use WebRTC: a STUN or TURN
  server's hostname, or a TURN username.

Chrome doesn't do the first two when its _Preload pages_ setting (in Settings, under Performance) is
off. The desktop app does none of them: it makes no connection or lookup for a frame it refuses or a
preconnect link, and it takes WebRTC away in every frame. Browsers other than Chrome and Chromium
weren't checked.

Before labels, the old board had plan, artifact and diagram as types of task whose agents made only the document,
in the task's own folder, with no worktree, review or merge. Tasks made as one have it as their label since, and keep
working that way: _Ready for merge_ marks them done.

A plan's agent asks what it needs to know as questions in the plan (`<ia-question>`: a choice of
one or several, a dropdown, or text, with an optional free-text _Other_, and any named form field
in the plan counts too). Answer them in the plan; the bar above the composer counts the answered
ones. Your answers are kept in this browser until you send them, so they last when the agent
changes the plan, or the board is reloaded (_Reset_ puts back the plan's own). **Send answers**
sends them to the agent as a message, each question with its answer, and it updates the plan
with them. An earlier version's questions are shown but can't be answered.

A **scratch task** (pick **Scratch** in the _New task_ form, or pass `type: "scratch"` to `create_task`) is for whatever
you ask its agent: questions, trying things out, or planning and running work with the board tools. Its agent works in
the task's own folder (`<data dir>/documents/<task id>`). On a profile's board it starts out in no project: it sits on
that board, keyed `S-<n>` (numbered across the profile; no project can use the key `S`, and one that had it moves to
`SP`), with no repository. The form's project picker (_No project_, or a project) moves it, and on a project's board
it's in that project (or with `project_id` on `create_task`): numbered with the project's tasks, its agent reads the
repository without changing it. Like a document task it has no worktree, review or merge: moving it to _Ready for merge_
marks it done. Scratch tasks replace the scratch chats of earlier versions: those became done scratch tasks (in no
project, whichever project they were in) that keep working in their old folder, so their conversations carry on.
