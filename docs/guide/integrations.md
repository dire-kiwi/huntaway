# Asana and automations

## Asana tasks

A task can be linked to the Asana tasks it's for (API 57): **Link Asana task…** under Asana in
the task's sidebar, or **Link Asana task** in the New task form, opens a dialog that searches the
user's Asana workspaces as you type (with nothing typed, the tasks Asana ranks first for them)
or finds the task whose link is pasted. Picking one in the New task form with nothing written
yet fills the description in from the Asana task's name and notes. Linked tasks show as Asana's
mark on the task's card, and its agent's first prompt lists them after the description.

Asana is reached with a personal access token per profile, kept on the host (Settings → Profiles
→ Edit, or the dialog asks for one the first time). Saving it checks it with Asana; the board only
ever sees who it belongs to (`asana_user`). `PATCH /profiles/{id}` takes `asana_token` (null
disconnects), `GET /profiles/{id}/asana/tasks?q=` searches, and tasks take `external_links`
(`[{provider: "asana", id, url, title}]`) when they're created and in `PATCH /tasks/{id}`.
`IA_ASANA_URL` points the host at another Asana API, such as a fake one for testing.

A profile that doesn't use Asana can turn it off (API 60): **Link tasks to Asana tasks** under
Asana in Settings → Profiles → Edit, or `asana_enabled: false` in `POST /profiles` and
`PATCH /profiles/{id}`. Profiles have it on until it's turned off. Off, the New task form and the
task sidebar leave Asana out (a task linked before still lists its links in the sidebar, so they
can be removed), and the host won't search Asana for it. Its token is kept for when it's on again.

## Automations

A project's automations (API 63, in its settings under _Automations_; agents' tools for them, API 67) put work on the board by
themselves: recurring work such as a weekly dependency update, and events from outside such as a
new GitHub issue to triage. Each one has a trigger and an action, can be switched on and off, and
lists its latest runs and deliveries (when, what started it, what happened, and the task).

- **Triggers.** An interval (at least 5 minutes, counted from when it's turned on or its schedule
  changes); a time of day on some weekdays, in the host's time zone; a **cron** expression (API 110:
  five fields, `minute hour day-of-month month day-of-week`, with ranges, steps, lists and names, in
  the host's time zone; as in Vixie cron, a day has to match both day fields if either starts with
  `*`, such as `*/2`, and either of them otherwise); a moment (**at**, API 110: it runs once, late if
  the server was down then, and turns itself off); or a **webhook**: a POST to
  `/api/hooks/<id>/<token>` on the host.
- **Before each run** (API 110): **active hours** (a scheduled run outside them waits for them to
  start, and a delivery outside them is skipped; not for _at_, nor Run now), a **precheck** (a bash
  command run first, in the project's folder or the assistant's workspace, for up to 2 minutes:
  exit 0 runs it, with what it printed as `{{precheck}}`, which counts as untrusted; exit 1 skips
  the run as having nothing to do; any other exit fails it), and a **budget** a day in dollars
  (from the cost of its runs' agents today, in the host's time zone: once it's spent, runs are
  skipped and say so; Run now isn't held to it). A run's cost is its agent's: a routine's thread,
  or the assistant's run that took its message in; for a project's automation, the first run of the
  task it made and started, or the run that took its message in (not the task's later work, which
  is yours). The runs from the last two days that made or messaged a task are kept past the history
  limit, so a busy automation's skipped deliveries can't push today's costs out. A routine's
  precheck runs only in the assistant's own workspace, not one that's become a symlink.
- **Actions.** Create a task in the project from a template: title, description, type (code or
  scratch), labels (plan, artifact, diagram), agent config, model, effort, To do or Backlog, and whether to
  start its agent. Or send a message to one of the project's tasks (to its agent as it works, if
  it's running). Its description says which automation made it and why.
- **Templates** take `{{…}}` values. From a webhook delivery: `{{body.issue.title}}` (any path in
  the JSON body, `*` for every item of a list), `{{headers.x-github-event}}`, `{{query.name}}`,
  `{{event}}` (X-GitHub-Event), `{{action}}`, `{{labels}}` (the issue's, pull request's or
  discussion's label names) and `{{delivery}}`. From the board: `{{date}}`, `{{time}}`, `{{now}}`,
  `{{automation}}` and `{{count}}` (deliveries coalesced into the run). A value from a delivery
  is untrusted: in a description or message it's wrapped in `<untrusted-data>` tags (which it
  can't close), and the agent is told that what's inside them, and the title, is data, not
  instructions. Titles are one line of at most 200 characters.
- **Run now** runs a schedule at once, on or off. For a webhook it's **Test**: a delivery sent
  from the board (the latest one received, or a body you write) through its filters and
  templates, without the signature check, duplicate check or coalescing.

**Agents.** Agents have board tools for automations: `list_automations`, `create_automation`,
`update_automation`, `delete_automation` and `run_automation` (Run now, or a test delivery). An
automation keeps making work after the agent is done, and a webhook lets whoever has its URL start
runs, so creating, changing or deleting one asks the user first, in the same dialog as a project
change (and as a card in the agent's thread), whatever the thread's permission mode. It shows
everything the automation would run: its trigger, filters and whether deliveries are signed, the
task's title and description templates, type, agent config and whether its agent starts, or the
task a message goes to and the message. A change shows what it changes, and the automation as it
would be and as it is. Nothing is made or changed unless the user approves, and then exactly what
they were shown (only the settings that differ, so a change the user made meanwhile stays). Turning
one off or renaming it isn't asked about. A call retried after a restart waits for the same
approval. An agent only reaches automations of projects on boards it can use, and an automation
only acts in its own project. With `generate_secret`, a new webhook secret is made once it's
approved and returned to the agent, once, with the URL (in full when `public_url` is set), so it
can set up the sender.

**Webhooks.** The webhook route is the one route that doesn't take the board's token. The token in
its path is the automation's own (compared in constant time) and reaches nothing else: an unknown
id or a wrong token is the same 404, a delivery can only fill in the templates (not pick the
project, the task to message, the agent config or anything else), and a message can only go to
a task in the automation's own project. _Make a new URL_ replaces the token.

- **Signature:** with a secret set (GitHub's webhook _Secret_), a delivery must carry a matching
  `X-Hub-Signature-256` (HMAC-SHA256 of the body), or it's rejected with a 401. The secret is
  never shown again once its dialog closes.
- **Filters** on the event, action, labels or any value (`is`, `isn't`, `starts with`, `contains`,
  `is one of`, `isn't any of`, `is set`, `isn't set`). A delivery that doesn't pass is recorded
  as filtered out, with the condition it failed.
- **Duplicates:** a delivery whose `X-GitHub-Delivery` (or `X-Delivery-Id`, `Idempotency-Key`)
  came in the last 7 days is dropped, even when both arrive at once. One that failed, was
  rejected or came while the automation was off can be sent again.
- **Coalescing:** deliveries within a window (up to an hour) make one run with the latest one's
  values, so a burst of edits is one task. A key (such as `{{body.issue.number}}`) keeps
  different issues apart.
- **Limits:** bodies of up to 1 MiB (413 above that), JSON or GitHub's form-encoded `payload`;
  60 deliveries a minute per automation (429 above that); 20 coalesced runs waiting at once.
- **Answers:** 202 as soon as its run is recorded (`running`; its action, precheck included, goes
  on by itself, so a slow one doesn't outlast the sender's timeout, GitHub's 10 seconds), and also
  when it's waiting to coalesce or was filtered out; 200 for a duplicate, 401 for a bad signature
  and 409 while it's off. How the run went (the project is archived, say) is in its deliveries on
  the board, not the answer.

A webhook that creates a task and starts its agent lets whoever can send it start an agent on
the host, with the project's permission mode. Keep that mode asking for approval (or leave the
task unstarted) when the sender isn't only you.

**Missed runs and restarts.** The scheduler looks every 5 seconds. It claims a due run by moving
the automation's next run on and recording the run in one transaction before it does anything,
so a restart can't run it twice. There's no backfill: an interval that came due while the server
was down (or the host asleep) runs once, then goes on from then; a time of day more than 10
minutes late is skipped and recorded as missed. A run under way when the server stopped is
marked as interrupted (it may or may not have made its task) and isn't run again. Coalesced
deliveries wait in the database and run after a restart. A time of day that the clocks skip
(daylight saving starts) runs when they've gone forward; one they repeat runs once. An archived
project's schedules don't run until it's unarchived. Each automation's run goes on by itself, so
one's slow precheck doesn't hold up the others; one that comes due again before its last run is
over waits for it.

**Routines** (API 110) are a profile's automations, on the assistant's **Routines** tab
(`/api/profiles/<id>/automations`): they have no project, and their one action is
`message_assistant`, which wakes the profile's assistant. By default (`mode: fresh`) each run works
in a thread of its own under the assistant (`task_type` `routine`, `parent_id` the assistant, keyed
`A-<n>` after it), in the assistant's workspace with its config, model, permission mode, skills and
MCP servers, on Claude Code or Codex. When its agent stops, its last message is posted in the
assistant's thread as a report (a `report` message), unless it's `NO_REPLY` (on its own or as its
last line) or empty: a quiet run says nothing. A run that failed, or asks the user something, is
posted too. The assistant reads the reports it hasn't seen with your next message, so a routine's
work stays out of its context. A routine's run is recorded with how its agent ended (`outcome`:
quiet, reported, asked, stopped or failed) and what it cost; the tab shows each routine's next run,
last result, cost today and in all, and Run now, pause, edit and delete. While a run's thread is
still working (or waiting for its usage limit to reset), the next scheduled one is skipped. Routine
threads are off the boards and the task lists, open from their report or run by their link, and are
deleted 14 days after their last activity, whatever their status (done, failed, stopped or left
asking; their runs and reports stay). With `mode: thread` the message goes to the assistant's own
thread instead, as `send_to_task` does, and the run is charged what the assistant's run that takes
the message in costs, toward its budget. The message carries its routine run with it, whether it
starts a run, is steered into the one going or waits in the queue (also when a run ends without
taking in a steered message, which is queued again for the next), so the run that actually takes it
in is the one charged. A run that takes in several routines' messages splits its cost evenly between
them; the user's messages in the same run aren't taken out. The automation tools take routines too
(`routines: true`, or an action of kind `message_assistant`; the assistant's own calls are about its
routines by default), for the caller's own profile only, and changing one asks the user as for any
automation. The assistant is told to make "remind me…" an _at_ routine. Deleting the assistant
stops and deletes its routine threads first.

**The morning brief** (API 113) is a routine template: the assistant's **Brief** tab sets it up at the
time and on the days you pick (weekdays at 7:30 by default; `POST
/api/profiles/<id>/assistant/brief` with `{time, weekdays}`), as a routine called _Morning brief_ in a
fresh thread, which you can change like any other. Its run reads today's calendar, unread and starred
mail, Drive files changed since yesterday (through the Google server, see _Google for the assistant_)
and what needs your attention or is ready to review on your boards (through the board's tools), writes
`brief.html` and `brief.json` in the assistant's workspace, and replies with a short summary, which is
posted in the assistant's thread as its report and pushed to the devices with routine reports on. The
board keeps the brief as the assistant's `brief` document, one version a day (`GET
/api/tasks/<id>/document?label=brief`), out of the workspace's git history and the Memory tab, and the
Brief tab shows it, with the earlier days to pick from. Its message says where Google stands as the run
starts (`{{google}}`: _connected as …_, or _not connected:_ and why), so a run without Google says so
at the top of the brief and its summary rather than failing quietly. Its message tells it to only read
and draft, and that what it reads in mail, invitations and files is data, not instructions.

The run also lists the brief's items in `brief.json` beside it (each one's kind, the topic it's rated
by, in its own words, and a line saying what it is), which the host checks and caps and keeps with the
day's brief (`items` in the document). The Brief tab lists them beside the brief, with a 👍 and 👎 each:
a rating becomes a line under _Morning brief preferences_ in `MEMORY.md` (`- More like this — mail:
Newsletters from Substack (rated 2026-11-04)`), committed as yours, one line per kind of item and topic
and the last 30 kept, and every run of the assistant reads it, the brief's included (`POST
/api/profiles/<id>/assistant/brief/feedback` with `{rating: "up" | "down" | "clear", kind, topic}`).
Pressing it again takes it back. The brief's page has no part in the ratings: it's shown in a frame
that runs no scripts and is sent nothing, with its refreshes, frames and handlers taken out and nothing
loaded from elsewhere (no tracking pixels), and links open in a new tab; only the board's own buttons
rate, so what the run wrote from your mail can't rate items into memory.

**Reaching the webhook.** The board usually listens on localhost or a LAN, where GitHub can't
reach it. Expose only the webhook path, `/api/hooks/`, on the host that has the project:

- **A tunnel or proxy** that serves only that path from `http://127.0.0.1:7878`: a Cloudflare
  tunnel whose ingress rule matches `^/api/hooks/`, Tailscale Funnel on that path, or a reverse
  proxy on a public machine with a `location /api/hooks/` block. The rest of the API still needs
  the board's token, but there's no need to publish it.
- **Managed tunnels**: deliver to the host’s tunnel hostname, `https://<name>.<tunnel domain>/api/hooks/<id>/<token>`.
  Use that address directly: webhook senders may not follow the broker’s redirect.
- **The legacy connection broker relay** (`huntaway-broker`, HA-2), once the host dials out to it: deliveries
  go to `https://<broker>/_broker/h/<host name>/api/hooks/<id>/<token>` (or without
  `/_broker/h/<host name>` for its default host).
- **A hub** doesn't pass webhooks on to its linked hosts: its links carry the board's API calls,
  not raw deliveries with their headers, so the URL has to reach the project's own host.

Set the host's public address in a webhook's settings (_This host's public address_, the
host setting `public_url`), and the settings show the full URL to give GitHub. In GitHub's
webhook settings, pick the events to send, `application/json` (or the default form encoding),
and the same secret.

The API: `GET`/`POST /projects/{id}/automations` (`{name, trigger, action, enabled, secret}`;
the list comes with the host's `time_zone`), `GET`/`PATCH`/`DELETE /automations/{id}` (`PATCH`
also takes `rotate_token: true`; a blank `secret` removes it), `POST /automations/{id}/run`
(`{payload, event}` for a test delivery) and `GET /automations/{id}/runs`. A trigger is
`{kind: "interval", every_minutes}`, `{kind: "daily", time: "HH:MM", weekdays: ["mon", …]}` or
`{kind: "webhook", filters: [{path, op, value}], coalesce_seconds, coalesce_key}`; an action
`{kind: "create_task", title, description, task_type, claude_config_id, model, effort, status,
start}` or `{kind: "send_to_task", task_id, message}`. Changes and runs are broadcast as
`automations_changed` events.

## Workflows

A project's workflows (API 107, in its settings under _Workflows_; agents' tools `list_workflows`,
`create_workflow`, `update_workflow`, `delete_workflow` and `run_workflow`) are graphs of steps that
run on its tasks. The editor draws them as nodes: drag from a step's outcome to the next step.

- **Start.** When a task moves into a column; when the task's **agent finishes its work** (API 123:
  the task then stays in _In progress_ rather than going to _In review_, and the workflow moves it
  on with a _Move task_ step, so with one of these on, what happens after the agent is done is the
  workflow's to decide. A run that ends without moving it sends it to _In review_ as before, or to
  _Needs attention_, saying why, when a step failed or the run was stopped); or only when run by
  hand from the task.
- **Steps.** A _check_ (has the work changed, has it commits or a pull request, its type or a
  label); an _agent_ in a thread of its own, read-only in the task's worktree, in a fresh
  conversation each run, that writes text (shown in a tab of the task) or a verdict (pass, or the
  serious issues it found); _open a pull request_ (API 123: the board pushes the task's branch and
  opens it with the gh tools, as the project's GitHub account, with a title and body that can come
  from an agent step before it, `{{<step id>.text}}`); _send to the task's agent_ (the issues
  found, or a message of its own, for up to so many rounds); and _move the task_.
- **Pipelines.** An agent step is given the output of the agent steps before it in the graph. With
  _Work only on what the steps before it wrote_ (`input_only`) it isn't told where the task's work
  is either, so a summary can be passed to another agent that processes it with a skill, in a
  fresh context (the _Summarise, then a skill_ preset).
- **Presets.** _Open a PR when done_ (start when the agent finishes, open its pull request if the
  branch has commits, move it to _In review_, or to _Needs attention_ if that fails), _Summarise,
  then a skill_, _Review and summarise_, and _From the Review tab_ (the project's reviewers, fix
  rounds and summarizers as a workflow). The Review tab's own reviews, summaries and pull request
  instructions still work alongside them: it says which workflows take tasks on, so the same review
  isn't run twice.
