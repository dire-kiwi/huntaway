# The board: profiles, projects and the sidebar

The board shows every profile at once. The sidebar lists the profiles at the top, each with a bar
of how many of its tasks are in progress (blue), need attention (amber), in review (purple) and
merging or waiting to merge (pink), leaving out the columns with none. Clicking one opens the
**profile's board**: all of its tasks together, from every project and every host that has the
profile, with its group and scratch tasks. Its *New task* form picks the project, or makes a
scratch task.

The sidebar's project list is one profile's: the one whose board you opened last, which is marked
with a bar beside its name (its initial in colour, the others' grey) and named on the *Projects*
heading. It stays while you're on other pages, and opening a project it doesn't list (from a
link, or a starred task) moves it to that project's profile. Pin a project to keep it listed
whichever profile is active by right-clicking it and picking *Pin to every profile* (a group's
menu pins the projects it lists); pinned projects show a pin, and the initial of their own
profile when it's another one. The active profile and pinned projects are saved in this browser,
and the board opens on the active profile's board.

Add a project with the **+** by the *Projects* heading. Its *Folder* tab picks a folder on the
host (a repository, or a new folder that's created for it). Its *GitHub* tab (API 55) clones a
repository instead: it lists the ones gh can reach on the host as the profile's GitHub account (see
[GitHub accounts](agent-tools.md)), or gh's active account when it has none: those the account owns, collaborates
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
added first. The dialog remembers which tab was used last. `GET /github-repos?account=&q=` lists or
searches the repositories and `POST /profiles/{id}/projects/clone` (`repo`, `repo_path`, `name`,
`key`) clones one and adds it.

The *Folder* tab can also **create a GitHub repository** for the folder (API 102): tick *Create a GitHub
repository for it*, pick *Private* (the default) or *Public*, and optionally an owner (an organization;
the profile's GitHub account by default) and a repository name (the folder's by default). The
repository is made with `gh repo create` as the profile's GitHub account and becomes the folder's `origin`.
A folder that isn't a git repository yet is made one (a folder that doesn't exist is created), and a
repository's commits are pushed; one that already has an `origin`, or is only a subfolder of a repository,
is turned down, and a repository that can't be made leaves the folder as it was. A push that fails
after the repository is made still adds the project (`github.push_error` says why).
`POST /profiles/{id}/projects/github` (`repo_path`, `visibility`: `public` or `private`, `repo_name`,
`owner`, `name`, `key`) does it and returns the project with `github: {full_name, pushed, push_error}`.

The sidebar lists projects in alphabetical order, with each group in its place by its own name
and its projects in order inside it. Right-click a project and pick *Add to favorites* to list it
under *Favorites*, a section of its own above the other projects (in alphabetical order too, and
out of its group, whose row stays while it has group tasks even if all its projects are favorites);
*Remove from favorites* puts it back. Favorites are saved in this browser.

Rename a project, change its key or point it at a moved repository folder in its settings (or
with the `update_project` tool, API 45). After a key change the old task keys (e.g. `OS-2`) still
find their tasks, and no other project can take them. A new repository path must be the same
repository (told by its worktrees, the commits its history started from, or its tasks' branches);
*Move the folder there* (`move_repo`) moves the folder itself, with the project's agents stopped.
Either way paths inside the folder (worktrees kept there, the worktrees folder) move with it, the
task worktrees are reconnected (`git worktree repair`), and conversations that ran in the old
folders can still be resumed.

Group projects by right-clicking one in the sidebar (or with *Group* in its settings). A group
shows as a collapsible folder with its projects underneath, and clicking it opens one board
(or list) with all of their tasks. Right-click a group to rename or ungroup it. Groups are
saved on the host, per project, so projects on different hosts are in separate groups; which
groups are collapsed is saved in this browser.

Hide a project from the sidebar by right-clicking it and picking *Hide from sidebar* (a group's
menu hides all of its projects). Each host's hidden projects sit under a *N hidden* row at the
end of its list, which carries their counts and opens to show them; right-click one there to
show it again. A hidden favorite stays there rather than under *Favorites*, and making a hidden project a
favorite shows it again. A hidden project is only left out of the sidebar: its tasks are still on its
profile's and its group's boards. Hidden projects are saved in this browser.

Archive a project you're done with by right-clicking it and picking *Archive…*, or with *Archive
project* in its settings (API 46). It goes off the board for every browser: out of the sidebar, its
profile's and group's boards, and out of agents' `list_projects` (and `list_tasks` with `project_id='all'`).
It takes no new tasks and its agents don't start (messages, other agents' `send_to_task`, reviews
and idle compaction are refused; tasks waiting for their dependencies or a merge slot keep
waiting until it's unarchived), but its tasks, worktrees and branches are kept. It can't be
archived while one of its agents is running. Unarchive it in Settings → *Archived projects*, the only place it's
listed (its old board link says it's archived and points there).

Star a task (the star by its title, or *Star* in its card's right-click menu) to list it under
*Starred* at the top of the sidebar. Set a reminder to come back to a task with the bell beside its
tabs (or the card's menu): in an hour, tomorrow morning, next Monday or at a time you pick, with a
note on what for. Tasks with reminders are listed under *Reminders*, soonest first; once one comes
round it shows as due, counted on the section's heading, until you clear it or set a new time
(right-click it in the sidebar). Agents can do both too, with `starred`, `remind_at` (a delay
like `2h`, or a time) and `reminder` on `create_task` and `update_task` (API 48). Stars and
reminders are saved on the task's host; which of the two sections are collapsed is saved in this
browser.

A group's *New task* form can also start a **group task** (pick *Group task* in its project
picker). It isn't in any project: it sits on the group's board (keyed `G-<n>`, numbered across
the profile's groups; no project can use the key `G`, and one that had it moves to `GP`) and its agent
plans the work across the group's projects, creating and starting their tasks rather than
changing the repositories itself. Its card shows how many of the tasks it created are done,
and its details list them. It works in the profile's scratch folder with the group's
repositories readable, and follows its group when the group is renamed. A group whose
projects are all ungrouped or deleted stays in the sidebar (in italics) while it has group
tasks, so they can still be opened, resumed and deleted.

Any task can have **labels** (API 71): **Plan**, **Artifact** and **Diagram**, each asking its
agent for a document besides its other work. Add them in the *New task* form by typing `/plan`,
`/artifact` or `/diagram` (several at once work), in the task's details under *Labels* (they can
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
can't reach the board), a diagram drawn in the board with zoom, an SVG download and a button that
sends a parse error back to the agent. Reply under the document to ask for changes. The board
keeps a version from each turn that changed the file (`GET /tasks/{id}/document?label=plan`, with
`&version=N` for an earlier one), and the task opens on its first label's document once there's
one to read. The board's *Type* filter finds tasks by their labels too.

Before API 71, plan, artifact and diagram were types of task whose agents made only the document,
in the task's own folder, with no worktree, review or merge. Tasks made as one have it as their
label since, and keep working that way: *Ready for merge* marks them done. A host before API 71
still makes a task of that type when the board gives a new task one label (and refuses several).

A plan's agent asks what it needs to know as questions in the plan (`<ia-question>`: a choice of
one or several, a dropdown, or text, with an optional free-text *Other*, and any named form field
in the plan counts too). Answer them in the plan; the bar above the composer counts the answered
ones. Your answers are kept in this browser until you send them, so they last when the agent
changes the plan, or the board is reloaded (*Reset* puts back the plan's own). **Send answers**
sends them to the agent as a message, each question with its answer, and it updates the plan
with them. An earlier version's questions are shown but can't be answered.

A **scratch task** (pick **Scratch** in the *New task* form, or pass `type: "scratch"` to
`create_task`) is for whatever you ask its agent: questions, trying things out, or planning and
running work with the board tools. Its agent works in the task's own folder
(`<data dir>/documents/<task id>`). On a profile's board it starts out in no project (API 47): it
sits on that board, keyed `S-<n>` (numbered across the profile; no project can use the key `S`, and
one that had it moves to `SP`), with no repository. The form's project picker (*No project*, or a
project) moves it, and on a project's or subproject's board it's in that project (API 51, or with
`project_id` or `subproject` on `create_task`): numbered with the project's tasks, its agent reads
the repository (and the subproject's worktree) without changing it, and the tasks it creates go in
the subproject. A scratch task in a subproject isn't part of the subproject's work, so the
subproject's column and progress leave it out, and the subproject is merged without waiting for
it. Like a document task it has no worktree, review or merge: moving it to *Ready for merge*
marks it done. Scratch tasks replace the scratch chats of earlier versions:
those became done scratch tasks (in no project, whichever project they were in) that keep
working in their old folder, so their conversations carry on.
