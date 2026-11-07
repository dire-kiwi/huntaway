# Workflows

A project's workflows (in its settings under _Workflows_) are graphs of nodes that run on its tasks: a task's way across
the board, column by column, and the steps between the columns (reviews, summaries, pull requests, messages to the
task's agent). Agents can read and change them too, with the board's `list_workflows`, `create_workflow`,
`update_workflow`, `delete_workflow` and `run_workflow` tools (a change other than turning one off asks you first).

This page covers hosts from API 127 (HA-276). Older hosts have a start node that runs when a task enters a column, and
a _Move task_ step, instead of column nodes and values; see [the end of this page](#workflows-from-before-column-nodes).

## The editor

- **Add a step** and **Add a value** add a node where there's room in view. Click a node to change it in the panel on
  the right.
- **Connect** a step to the next one by dragging from one of its outcomes (a circle on its right) onto the next step.
  **Wire** a value by dragging from a value (a diamond on its right) onto an input (a diamond on its left).
- **Remove** a node or a line: select it and press Delete, Backspace or X (as in Blender), or use the bin in the
  panel. Right-drag across lines to cut every line the knife crosses. A selected line has a _Remove_ button too.
- **Pan** by dragging the background, or with the middle button anywhere. **Zoom** with the scroll wheel (around the
  pointer) or the corner's − and +; the percentage goes back to 100%, and _Fit_ shows the whole workflow.
- Nothing is saved until you press _Save_ (or _Create workflow_); closing with changes asks first.

## How a run goes

A run starts at a **column** node when a task enters its column, or at the **start** node when you run the workflow by
hand from the task's details (a workflow without a start runs by hand from its node for the task's column). From there
it follows the lines out of the outcome each node ends on.

- A node runs once every node with a line into it has finished and one of those lines was taken (_any of its inputs_,
  the default) or all of them (_all of its inputs_, which a node with several lines into it can be set to). Otherwise
  it's skipped, and so are the nodes only it leads to. Nodes side by side run at the same time, so two reviewers after
  a column review together.
- A **line into a column** moves the task there, and that's where that path of the run ends: what comes after the
  column belongs to the run that starts there. That's how a workflow goes round (work, review, fixes, review again)
  without a loop. Any other loop is refused.
- Where the task's agent works in a column (In progress, Ready for merge, or a column with a prompt), the column's
  `done` waits for that work, and meanwhile the task stays in In progress rather than going to In review. A run that
  ends without moving the task sends it to In review, as it would go without a workflow, or to Needs attention, saying
  why, if a step failed or the run was stopped.
- A run keeps the graph it started with, so changing a workflow doesn't change runs in progress. A run is stopped when
  the task's agent starts working again (its work is changing), except one waiting for that work in a column; when you
  stop the task; when the task leaves the column a run waits in; when the workflow is turned off (a run waiting in a
  column); or when it's deleted.
- A column where the agent works belongs to one workflow that's on: a second one is refused when it's saved or turned
  on. A workflow has one node per column, at most 80 nodes, and at most 8 agent steps.

## Values and inputs

Nodes have two kinds of sockets, as in Blender's node editor: **outcomes** (circles), which say where a run goes next,
and **values** (diamonds), which are text. Every text field of a step is also an **input**: wire a value into it and the
wire replaces the field's own text (the panel then says where the value comes from, with a button to unwire it).

- A value is read when the step it goes into runs. A step's value is what it did in the run, or, if it didn't run in
  this one, what it did in the workflow's last run on the task that ran it. So In progress's prompt can take the issues
  of the last review.
- A value node's value can't depend on itself through other value nodes. A wire from a step back into a step before it
  is fine: it reads that step's last output.
- An input takes one wire; a value can go into any number of inputs.
- A wire into an input the node no longer has (a name taken out of a compose template, a join with fewer inputs) goes
  when the node changes.

### Templates

A step's own text, a _Text_ node and a _Compose_ template can use these, filled in when it's read:

| Template                           | Is                                                        |
| ---------------------------------- | --------------------------------------------------------- |
| `{{task.key}}`                     | The task's key, such as `HA-276`                          |
| `{{task.title}}`                   | Its title                                                 |
| `{{task.description}}`             | Its description                                           |
| `{{branch}}`                       | Its branch                                                |
| `{{commit}}`                       | The commit the run started on (empty in a start prompt)   |
| `{{workflow}}`                     | The workflow's name                                       |
| `{{issues}}`                       | The serious issues the run's review steps found, numbered |
| `{{<node id>.text}}`               | That agent step's output in the run                       |
| `{{<node id>.issues}}`, `.verdict` | That review step's issues, numbered, or `pass`/`issues`   |

A template a name doesn't match is left as it is. In the editor, typing `{{` in a step's text lists the templates it can use, the
other steps' outputs by their ids among them (an _Open a PR_ step's `.text` is its pull request's address): pick one with the
arrow keys and Enter or Tab, or click it, and Escape closes the list.

## Steps

### Column

A column of the board: In progress, In review, Ready for merge, Needs attention, To do, Backlog or Done.

| Socket              | Kind    | Is                                                                             |
| ------------------- | ------- | ------------------------------------------------------------------------------ |
| line in             | in      | Moves the task to this column (not into Done, which a merge does)              |
| `prompt`            | input   | What the task's agent is sent when the task enters the column (see below)      |
| `done`              | outcome | The column's work is done (see below); a run that starts here goes on from it  |
| `what happens next` | value   | What the board does once the work is done, as the agent is told it (see below) |

- **In progress**: the prompt is what the agent starts with, after the task's title and description, in place of the
  project's start prompt (blank: the project's). A line into In progress for a task that has started gives its agent
  the issues the run found, or, if its prompt is wired or there are none, the prompt (blank: the project's start
  prompt, as it started with). `done` comes when the agent's turn ends without a
  question for you, or with **Done when: the agent says so**, only once it calls the board's `finish_work` tool in its
  turn (a turn that ends without it moves the task to Needs attention, whether it did the work or revised a plan task's
  plan as it went). Only code tasks, which get In progress's prompt, are asked for it; the fixes and messages the
  workflow sends them end saying so too. The agent's work after a message you send it counts as well. Lines back into
  In progress give the agent its work at most **Rounds** times in a row (3 when blank), as a _Send_ step does: once
  they're used up the task isn't moved but goes to Needs attention, with the issues the run found. A run that could
  have gone back into In progress but went another way (its review passed, say) gives the rounds back.
- **Ready for merge**: the prompt is how the agent merges, in place of the project's merge instructions. `done` comes
  once the task is merged.
- **Any other column with a prompt**: the prompt is sent to the task's agent when the task enters the column, and
  `done` waits for that work as In progress's does. With nothing after `done` that moves the task, it goes to In
  review then (for In review's own prompt, without sending it again).
- **A column without a prompt** (and Needs attention and Done, which have none): `done` comes as soon as the task
  enters it. With nothing after it, entering it runs nothing.
- **What happens next**: the board adds a line to the prompt saying how the agent says it's done, and what it does then,
  from the steps after `done` up to the next column, when they go well. For example: "When you're done, end your turn
  with a summary of what you did. The board then pushes your branch and opens its pull request (so don't open one
  yourself) and moves the task to In review." The editor shows it under _Added to the prompt_. Wire `what happens next`
  somewhere (into a compose template, say) and it goes only there. While an _Open a PR_ step follows In progress's
  `done`, the agent's instructions also stop telling it to push and open a pull request itself (not while it merges,
  when it pushes what the merge needs).

### Start

Where a run you start from the task's details begins (_Run_ in the task's details, or the `run_workflow` tool). A
workflow has one at most; one with only a start runs only by hand.

| Socket | Kind    | Is                |
| ------ | ------- | ----------------- |
| `then` | outcome | The run has begun |

A run by hand starts with fresh rounds, and its _changed_ check always says yes.

### Check

A check on the task.

| Socket  | Kind    | Is              |
| ------- | ------- | --------------- |
| line in | in      | Make the check  |
| `yes`   | outcome | The check holds |
| `no`    | outcome | It doesn't      |

It checks one of:

- **The work changed since its last run**: the task's commit, or its agent's latest run, differ from the workflow's last
  finished run on the task that got as far as this check (always yes for a run by hand).
- **The task has commits of its own**: its branch has commits its base branch doesn't (no for a task without a worktree).
- **The task has a pull request.**
- **The task is of a type**: code or scratch.
- **The task has a label**: plan, artifact or diagram.

### Agent (Review, Summary, Skill on its input)

An agent in a thread of its own, with read-only tools in the task's worktree, in a fresh conversation each run (the
thread keeps every run's messages). _Review_, _Summary_ and _Skill on its input_ are agent steps set up for those jobs.

| Socket    | Kind    | Is                                                             |
| --------- | ------- | -------------------------------------------------------------- |
| line in   | in      | Start the agent                                                |
| `prompt`  | input   | Its instructions                                               |
| `done`    | outcome | It finished, writing its output (for _Writes text_)            |
| `pass`    | outcome | It found nothing that must be fixed (for _Pass or issues_)     |
| `issues`  | outcome | It found serious issues (for _Pass or issues_)                 |
| `failed`  | outcome | It couldn't run, failed, asked you something, or didn't report |
| `text`    | value   | Its output: its last message, or a review's summary            |
| `issues`  | value   | A review's serious issues, numbered                            |
| `verdict` | value   | A review's verdict: `pass` or `issues`                         |

- **Output**: _Text_ (its last message is its output) or _Verdict_ (it reports pass or the issues it found with
  `submit_review`, as a reviewer does).
- **Tab**: the task panel tab its output shows in; steps can share one.
- **Agent**: the agent config, model and effort it runs with (blank: the task's).
- **Instructions**: what it's asked to do; blank is the project's review instructions for a verdict, or "report on the
  work" for text. The board adds where the work is, what the agent steps before it in the graph said, and how to
  report. A review that ran before, whose issues were sent to the agent since, is asked to check they're fixed.
- **Skills**: skills it's asked to use.
- **Work only on what the steps before it wrote** (`input_only`): it isn't told where the task's work is, only what the
  steps before it said, so it can process a summary (with a skill, say) in a fresh context.

### Open a PR

Pushes the task's branch and opens its pull request with the gh tools, as the project's GitHub account, into the branch
it started from.

| Socket    | Kind    | Is                                                                                                            |
| --------- | ------- | ------------------------------------------------------------------------------------------------------------- |
| line in   | in      | Push and open it                                                                                              |
| `title`   | input   | Its title (blank: the task's key and title)                                                                   |
| `body`    | input   | Its body (blank: the task's agent's last message)                                                             |
| `opened`  | outcome | It opened the pull request                                                                                    |
| `had one` | outcome | The task has one already, which it pushed the branch's new commits to                                         |
| `failed`  | outcome | The task has no worktree, its branch no commits of its own, its repository isn't on GitHub, or GitHub refused |
| `url`     | value   | The pull request's link                                                                                       |

_Open it as a draft_ opens a draft.

### Send to the task's agent

Sends a message to the task's agent, which ends the run (the agent's work is changing): once the agent is done, the
workflow goes on from In progress (or, without an In progress node, from the column the task enters).

| Socket          | Kind    | Is                                                                   |
| --------------- | ------- | -------------------------------------------------------------------- |
| line in         | in      | Send it                                                              |
| `message`       | input   | The message (blank: the serious issues the run's review steps found) |
| `out of rounds` | outcome | It has sent its rounds in a row already, so it didn't send           |

**Rounds**: how many times in a row it sends. They carry from one run to the next, and start again once a run that
could reach the send goes another way (its review passes, say) or when you run the workflow by hand. Out of rounds,
with nothing after `out of rounds`, the task moves to Needs attention, with the issues.

## Values

Value nodes have no line in or outcome: no run goes into them. Their values are read when a step they're wired into
runs.

### Text

| Socket | Kind  | Is                                     |
| ------ | ----- | -------------------------------------- |
| `text` | value | Its text, with its templates filled in |

### Task

| Socket         | Kind  | Is                              |
| -------------- | ----- | ------------------------------- |
| `title`        | value | The task's title                |
| `description`  | value | Its description                 |
| `key`          | value | Its key, such as `HA-276`       |
| `branch`       | value | Its branch                      |
| `commit`       | value | The commit the run started on   |
| `pull request` | value | Its pull request's link         |
| `labels`       | value | Its labels, separated by commas |

### Project prompt

| Socket | Kind  | Is                                                                                                          |
| ------ | ----- | ----------------------------------------------------------------------------------------------------------- |
| `text` | value | The project's prompt for starting a task, reviewing it or merging it (its Prompts settings, or the board's) |

### Compose

A template whose `{{name}}`s (names without a dot) are its inputs.

| Socket   | Kind  | Is                                                                                                                      |
| -------- | ----- | ----------------------------------------------------------------------------------------------------------------------- |
| `<name>` | input | One for each `{{name}}` in the template; unwired, it's the template's own value (such as `{{issues}}`) or left as it is |
| `text`   | value | The template with its inputs and templates filled in                                                                    |

### Join

| Socket    | Kind  | Is                                                                               |
| --------- | ----- | -------------------------------------------------------------------------------- |
| `1` … `8` | input | The texts to join (_Inputs_ sets how many)                                       |
| `text`    | value | Those with text, in order, with _Between them_ between each (`\n` is a new line) |

### Switch

| Socket | Kind  | Is                             |
| ------ | ----- | ------------------------------ |
| `yes`  | input | The value when the check holds |
| `no`   | input | The value when it doesn't      |
| `text` | value | One or the other               |

It checks whether the task has a pull request, is of a type, or has a label (as a _Check_ does, without git).

## An example

The _Work, PR and review_ preset, with the In progress prompt built from values:

```
[Task] title ─┐
[Text "Use TDD"] ─┼─► [Compose "Build {{title}}. {{rules}} Last review: {{issues}}"] ─► prompt [In progress]
[Reviewer] issues ┘                                                                       │ done
                                                                                         ▼
                        [Has commits?] ─yes─► [Open a PR] ─opened/had one─► [In review] ─done─► [Reviewer]
                                         └no───────────────────────────────────────┘          │ issues
                                                                                              ▼
                                                                          [Send to the task's agent]
```

The task starts with the composed prompt, followed by what happens next. When its agent is done, the board opens its
pull request and moves it to In review, where the reviewer runs. Its issues go back to the agent (up to the send's
rounds), whose work is done in In progress again: the pull request gets the new commits, and the review runs again, with
the last review's issues in the prompt and in the reviewer's recheck.

## Workflows from before column nodes

Workflows saved before HA-276 keep working. Their start on a column (or on the agent finishing, which is In progress) is
read as that column's node, and their _Move task_ steps as lines into a column. Two changes in how they run: a start on
In progress or Ready for merge now runs once the agent's work there is done, or the task is merged, rather than as the
task enters the column; and a moved-to column with steps after it starts a run of its own there.
