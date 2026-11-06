# Personal agents and Huntaway

Research for task HA-117: what personal agents such as xAI's Grok Bot do, and which of those features a **personal mode**
for Huntaway could have. A personal mode is a way of using the board that isn't about code projects. It has an
assistant you talk to from anywhere. The assistant remembers you, checks things on a schedule, acts in your accounts
(mail, calendar, files, the web) and asks before it does anything that matters.

The facts about other products come from their docs and help pages, read on 2026-11-03, and are linked below. Some
vendor pages couldn't be fetched (OpenAI's help centre and `x.ai/bot` returned 403). Claims that come from only one
third-party blog are marked _(3P)_. None of the products was installed or run. Huntaway is described as of
`master` at `cd5700a` (API 95).

**In one line:** all the personal agents share one shape: a long-lived assistant thread, memory you can edit,
schedules and event triggers that wake it, connectors to mail, calendar and files, a way to reach it from your phone
(often a messaging app), and a rule that reading and drafting are free while sending, paying and deleting ask first.
Huntaway already has the engine for most of this: agents that keep running through restarts, automations,
scratch tasks, push, permission cards, documents, profiles and board tools. What it lacks is the personal layer on
top: one assistant that lasts instead of a task per request, memory that carries over, routines outside projects,
connectors, and channels other than the board.

## The products

### Grok Bot (xAI)

An early beta since 2026-08-11, included in X's Premium, Super and Ultra plans and drawing on a weekly allowance shared
with Cursor ([pricing](https://docs.x.ai/x-subscription/pricing), [FAQ](https://docs.x.ai/grok-bot/faq)). "An
agent with a computer" ([Grok Bot 101](https://x.ai/bot/guides/grok-bot-101)).

- **Bots:** each Bot is a named teammate with a job, its own conversation, memory, skills and routines. A _primary
  Bot_ is the front door that coordinates the others. Bots message each other, and group chats hold 2–6 Bots
  ([Bots](https://docs.x.ai/grok-bot/bots), [chat](https://docs.x.ai/grok-bot/chat-and-collaboration)).
  Templates copy "the recipe, not the meal": instructions, skills and routines, but not secrets or personal memories
  ([templates](https://x.ai/bot/guides/templates-for-grok-bot)).
- **Computer:** all Bots share one persistent cloud computer with a browser, terminal and `/workspace`. Sign-ins
  persist, and you take over the screen for passkeys, CAPTCHAs and QR codes. Its web traffic can go out through your
  desktop so that sites see your home IP ([computer and apps](https://docs.x.ai/grok-bot/computer-and-apps)).
- **Vault:** logins, cards and contacts that Bots use without seeing the values. To sign in, a Bot tries the vault,
  then 1Password, then a secure form that types your answer straight into the page ([vault](https://docs.x.ai/grok-bot/vault)).
- **Channels:** desktop and phone apps, Slack, X Chat, voice (dictation, live chat, voice memos), tagging `@bot` on
  an X post, Siri and Shortcuts actions, and an email address per Bot ([mobile](https://docs.x.ai/grok-bot/mobile),
  [tag on X](https://docs.x.ai/grok-bot/tag-on-x)).
- **Memory:** per Bot: rules, preferences and a dated work log. A few facts (your name, time zone) are shared by all
  Bots. There's no memory screen: you ask "what do you remember?" or "forget that". Memory can be imported from
  another assistant with a copy-and-paste prompt.
- **Skills and routines:** skills are saved procedures, and _Teach a task_ turns a screen recording of up to 10
  minutes into a draft skill. Routines run on a schedule (at least 5 minutes apart) or on events (Slack, GitHub,
  Linear, Sentry, mail to the Bot, webhooks). There are 50 per Bot, the last 20 runs are kept, and you can Test, Pause
  and Resume them ([skills and routines](https://docs.x.ai/grok-bot/skills-routines-and-automations)).
- **Approvals:** _Auto Review_ is a model that checks each action and either runs it or shows a card: Allow once,
  Always allow (which saves a rule) or Deny. You can write up to 20 plain-language "Allow automatically" rules and 20
  "Ask first" rules, and "Ask first" wins. Cards from background work expire after 30 minutes. Mail from routines
  waits as a draft until you press Send. There's no audit log, and the docs say Bots aren't a security boundary
  from each other ([approvals](https://docs.x.ai/grok-bot/approvals-security-and-privacy)).
- **Complaints:** the weekly allowance runs out in days
  ([forum](https://forum.cursor.com/t/grok-bot-ultra-users-how-do-you-make-the-weekly-allowance-last-mine-reached-99-in-three-days/171221)).
  Sites block its datacenter IPs. You can't see or pick the model. Bots get into loops and make noise _(3P,
  [flaviocopes](https://flaviocopes.com/grok-bot/))_.

### OpenClaw (was Clawdbot, then Moltbot)

The open-source, self-hosted agent that went viral in January 2026, now run by the OpenClaw Foundation
([repository](https://github.com/openclaw/openclaw)). It's the closest analogue to Huntaway: a daemon on your own
machine that wraps an agent runtime.

- **Gateway:** one Node daemon per host. It's the control plane for sessions, channels and tools, binds to loopback,
  and keeps its state in SQLite. It has its own runtime, and can also drive Codex's app-server or the Claude Code CLI
  ([architecture](https://docs.openclaw.ai/concepts/architecture), [runtimes](https://docs.openclaw.ai/concepts/agent-runtimes)).
- **Channels:** built-in web chat, plus plugins for Telegram, WhatsApp, Signal, iMessage, Discord, Slack, Teams,
  Matrix, SMS and about 20 more ([channels](https://docs.openclaw.ai/channels)). An unknown sender gets an 8-character
  pairing code that the owner approves, and approving a DM doesn't let that sender in groups
  ([pairing](https://docs.openclaw.ai/channels/pairing)). In groups the agent answers only when mentioned, and the
  other messages are kept as context ([groups](https://docs.openclaw.ai/channels/groups)).
- **Memory as files:** the workspace holds `SOUL.md` (persona), `USER.md` (you), `AGENTS.md` (rules), `MEMORY.md`
  (curated long-term facts, never loaded in groups) and `memory/YYYY-MM-DD.md` daily logs, and the docs recommend
  keeping it in a private git repository. A silent turn before compaction appends to the daily log. A background
  _dreaming_ pass promotes items into `MEMORY.md` and writes `DREAMS.md` for you to review. `memory_search` is
  vector plus keyword search ([memory](https://docs.openclaw.ai/concepts/memory), [workspace](https://docs.openclaw.ai/concepts/agent-workspace)).
- **Proactivity:** the original _heartbeat_ (a 30-minute check driven by `HEARTBEAT.md`) has been replaced by
  ordinary jobs. Setup makes a "Proactive check" job every 30 minutes with active hours, and a job says nothing when
  it replies `NO_REPLY`. Jobs are one-shot, interval or cron, and run in the main session or in a fresh one. Webhooks,
  condition watchers and "standing intents" trigger work too
  ([heartbeat](https://docs.openclaw.ai/gateway/heartbeat), [cron jobs](https://docs.openclaw.ai/automation/cron-jobs)).
- **Sessions:** DMs share the main session by default, and `dmScope` can split them per person or channel.
  `identityLinks` merges one person's accounts across channels. Sub-agents run in the background and report back
  ([sessions](https://docs.openclaw.ai/concepts/session), [sub-agents](https://docs.openclaw.ai/tools/subagents)).
- **Tools:** skills from the ClawHub registry. _Skill Workshop_ lets the agent write and version its own skills. A
  browser runs either as a Chrome profile of its own or attached to your signed-in Chrome. _Nodes_ (phone, Mac,
  watch) offer camera, location, notifications and SMS. There's a voice talk mode and wake words
  ([skills](https://docs.openclaw.ai/tools/skills), [browser](https://docs.openclaw.ai/tools/browser), [nodes](https://docs.openclaw.ai/nodes)).
- **Security:** one trusted operator per gateway, and the sandbox is off by default. Exec approvals are `deny`,
  `allowlist` or `full`, with an ask mode, and when no UI is reachable they fall back to deny. "Allow always" is bound
  to the exact argv and folder ([exec approvals](https://docs.openclaw.ai/tools/exec-approvals)). The prompt-injection
  guidance is to send untrusted mail to a read-only _reader agent_
  ([prompt injection](https://docs.openclaw.ai/gateway/security/prompt-injection)).
- **What went wrong:** in CVE-2026-25253, the Control UI trusted a `?gatewayUrl=` parameter and sent its token there,
  so one click gave remote code execution, even on loopback-only gateways
  ([advisory](https://github.com/openclaw/openclaw/security/advisories/GHSA-g8p2-7wf7-98mq)). Tens of thousands of
  gateways were found exposed on the internet. Hundreds of malicious ClawHub skills turned up before the registry
  started scanning them _(3P, [eSecurity Planet](https://esecurityplanet.com/threats/hundreds-of-malicious-skills-found-in-openclaws-clawhub))_.
- **What people use it for** _(3P)_: morning briefings, inbox triage, reminders and to-dos, research, coding from a
  phone, and errands.

**Relatives.** [NanoClaw](https://github.com/qwibitai/nanoclaw) runs Claude Code through the Agent SDK. It puts each
group in its own container, where it sees only the folders mounted into it. Credentials are injected by a gateway
outside the container. Scheduled jobs have _script gates_ that skip the run when there's nothing to do. Channels are
added as skills that edit the code. [Hermes Agent](https://github.com/NousResearch/hermes-agent) (Nous Research) is
about learning: it writes and refines skills from finished tasks, and searches past sessions with SQLite FTS5.
[NemoClaw](https://github.com/NVIDIA/NemoClaw) (NVIDIA) runs OpenClaw or Hermes in sandboxes, with an egress policy
and an operator approval flow.

### The big assistants

Between May and October 2026 each big vendor shipped an always-on agent that runs in the cloud.

- **ChatGPT dots** (2026-09-29). A dot has a cloud computer and browser with _Take over_ and _Return control_. It's
  reached in the app, in Slack and Teams, and by iMessage or RCS (US Pro beta), and you pick which channel gets which
  updates. It decides itself when to follow up. Before it acts, a review decides whether it proceeds, needs your
  approval, or hands the step to you. You can add rules, but they can't override the built-in limits
  ([dots](https://learn.chatgpt.com/docs/dots)). Pulse was retired in June 2026, and proactive updates moved into
  Scheduled Tasks, which can now trigger on an event such as mail arriving _(secondary)_.
- **Claude Duet** (2026-10-21). One thread, by text or voice, in an app or on claude.ai. It sends a morning brief and
  then stays quiet. It checks connected accounts every few hours and says it may miss things between checks. It reads
  and drafts on its own, and asks before it sends, pays, signs or deletes ([Duet](https://claude.com/product/claude-duet)).
  **Dispatch** sends a goal from the phone to Claude Desktop, which splits it into child tasks shown as Running,
  Awaiting input, Completed or Error. A permission prompt nobody answers within 10 minutes is denied, and the task
  carries on without that action ([Dispatch](https://claude.com/docs/cowork/guide/dispatch.md)). Memory is a set of
  topic entries you can view and edit, with incognito chats and import from other assistants
  ([memory](https://support.claude.com/en/articles/11817273)). Claude in Chrome has a list of actions it refuses
  outright: purchases, creating accounts, permanent deletion, and following instructions found in pages or mail
  ([Chrome](https://support.claude.com/en/articles/12902446)).
- **Gemini Spark and Daily Brief** (2026-05-19). Daily Brief is a morning digest from Gmail and Calendar that you
  tune with thumbs up and down. Spark is a 24/7 agent on a cloud VM. Schedules run at a time or on an event such as
  "flight delayed", and are listed on a _Scheduled_ page. It confirms before sending messages, changing or deleting
  data, buying, submitting forms or signing in ([agent](https://support.google.com/gemini/answer/16596215),
  [Spark](https://blog.google/innovation-and-ai/products/gemini-app/next-evolution-gemini-app/)).
- **Poke, Lindy.** These have no app: you text them over iMessage, SMS, WhatsApp or Telegram, and they message you
  first with briefings and triaged mail. Lindy follows standing instructions such as "after each meeting, send notes
  to Slack", and every email it writes is a draft you review
  ([Lindy](https://docs.lindy.ai/features/imessage-sms), [Poke](https://appleinsider.com/articles/26/06/04/first-ai-agent-for-messages-business-chat-approved-by-apple)).

## What they all have, and what stands out

**Table stakes** (most of them have these):

1. One long-lived assistant thread, not a chat per request.
2. Memory you can see and edit, search over past conversations, and import from another assistant.
3. Scheduled and event-triggered work, listed on one page where you pause, edit and test it.
4. A morning brief built from mail and calendar.
5. Connectors for mail, calendar and files, plus MCP or an app catalogue.
6. A browser that keeps its sign-ins, and a way for you to take over for logins and payments.
7. Reading and drafting run freely; sending, paying, deleting and signing ask first.
8. Push to the phone, and a phone app or a messaging channel to answer from.

**Distinctive ideas worth copying:**

- **Reaching it through a messaging app** (Poke, Lindy, OpenClaw, dots). Owner-only, with pairing codes for anyone
  else, and a choice of which channel gets which updates.
- **Memory as plain files you can edit** (OpenClaw), with a nightly consolidation pass whose changes you review.
- **Quiet unless something's found** (OpenClaw's `NO_REPLY`, Duet's "quiet until something needs you"), and
  _script gates_ that skip the model when nothing changed (NanoClaw).
- **Approvals that expire and default to deny** (Dispatch: 10 minutes; Grok Bot: 30), so background work never waits
  for ever.
- **Three outcomes for an action, not two:** proceed, ask, or hand the step to the user. Plus your own plain-language
  rules on top of limits that can't be overridden (dots, Grok Bot, Claude in Chrome).
- **A front-door assistant that hands work to specialists** (Grok Bot's primary Bot; Dispatch's child tasks with
  statuses, which are a kanban board in all but name).
- **Being honest about cost and coverage:** Duet says it checks every few hours. Grok Bot's weekly allowance
  complaints show why a budget matters.
- **Feedback that tunes routines:** Daily Brief's thumbs up and down.
- **Skills learned from use:** Grok Bot's _Teach a task_, OpenClaw's Skill Workshop and Hermes' learning loop.

## What Huntaway already has

| Personal agent need                           | Huntaway now                                                                                                                                                                   | Gap                                                                                                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A place to talk to it that isn't a repository | Scratch tasks in no project (`S-<n>`), each working in its own folder (`<data dir>/documents/<task id>`)                                                                       | Each is a new conversation. There's no single long-lived assistant, and nothing carries over from one scratch task to the next                                        |
| Remembering you                               | Claude Code's own memory: `CLAUDE.md` in the config dir, and auto-memory per working directory                                                                                 | The board doesn't show it or let you edit it. Each scratch task has a different folder, so auto-memory doesn't build up                                               |
| Waking on a schedule or an event              | Automations: interval, time of day, and signed webhooks with filters and coalescing; actions that create a task or message one; untrusted values wrapped in `<untrusted-data>` | Automations belong to a project. There's no cron expression or one-shot time, no "say nothing if nothing's new", no precheck, and no budget                           |
| Reaching you                                  | Web push to an installed PWA, reminders, _Needs attention_, question cards                                                                                                     | It only pushes board events. You can't answer from the notification, and there are no channels such as Telegram, Signal or email                                      |
| Reaching it                                   | The narrow phone layout, over Tailscale or a managed tunnel                                                                                                                    | No share target, quick capture or voice                                                                                                                               |
| Tools                                         | Skills and MCP servers per host, profile and project; the `gh` server with a GitHub account per profile; claude.ai connectors through the Claude login                         | No mail, calendar, files or notes integrations set up or curated, and no secrets store that hides values from the agent                                               |
| Asking first                                  | Six permission modes, approval cards, server-side confirmation for automations and project changes, `request_user_input`                                                       | Approvals are per tool call. There's no "ask before sending mail, never before reading it", no expiry, and no extra confirmation for an action someone else would see |
| Keeping lives apart                           | Profiles with their own Claude logins, GitHub accounts and boards; cross-profile access, off by default                                                                        | Fits: a personal mode belongs to a profile                                                                                                                            |
| Rich results                                  | Plan, Artifact and Diagram documents, with a version per turn; attachments                                                                                                     | Fits: a brief, a trip plan or a research report is an artifact                                                                                                        |
| Always on                                     | `ia-shim` keeps runs going through restarts; a host can be a home server or a VPS; a hub links several                                                                         | Fits, except that nothing wakes an idle assistant between your messages (automations could)                                                                           |
| Handing off work                              | Board tools across profiles, scratch, group and subproject tasks, `wait`, `!model` fan-out                                                                                     | Fits: the assistant can start a code task in a project, as Grok Bot's primary Bot hands technical requests to its engineer Bot                                        |

So Huntaway already has the hard parts: supervised runs, schedules and webhooks, permission prompts, push and
documents. What's missing is the personal layer.

## Features for a personal mode

The proposal is an **Assistant** for each profile: a long-lived agent thread with a workspace of its own, outside
every project. It sits at the top of the profile's sidebar, above _Projects_. Code work stays on the project boards,
and the assistant can hand work to them.

### First: the assistant itself

1. **Assistant thread.** One long-lived thread per profile (more later, see 13), opened from the sidebar and pinned
   there. It always works in the same folder, `<data dir>/assistants/<id>/`, so Claude Code's auto-memory builds up
   too. It never goes to review or merge, and it compacts when it gets long (Huntaway already has `/compact` and idle
   compaction). Under the hood it could be a scratch task of a new kind, so the runner, thread UI, steering, queued
   messages, permission cards and documents all come with it. It gets the profile's skills and MCP servers, and a
   model and permission mode of its own. The model should default to a strong one, because injection resistance
   depends on it.
2. **Memory you can see and edit.** Plain Markdown in the workspace, as OpenClaw does it:
   - `USER.md` holds facts about you, `MEMORY.md` lasting notes, and `memory/YYYY-MM-DD.md` a log for each day.
     `SOUL.md` is optional, for tone and name.
   - The first two are loaded on every run, with a size cap, and the daily logs are searched rather than loaded.
   - A **Memory** tab shows and edits the files. "Remember…" and "forget…" in chat work too.
   - Each change is a commit in the workspace's own git repository, so a bad edit can be undone.
   - Import from another assistant works as Grok Bot and Claude do: give the user a prompt to paste into the other
     assistant, then paste its answer back in.
3. **Routines: automations outside projects.** Let an automation belong to a profile rather than a project, with a
   new action, _Message the assistant_. That action either goes into the main thread or starts a fresh run, as
   OpenClaw's isolated jobs do, and the run's result is posted back to the thread. On top of today's triggers:
   - Cron expressions and one-shot times ("at 4pm tomorrow"), so "remind me to…" becomes a one-shot routine.
   - **Active hours**, and **quiet runs**: a run that ends with `NO_REPLY` (or an empty report) leaves no message and
     pushes nothing.
   - A **precheck** command (NanoClaw's script gates): the model only runs when the command says something changed.
     Today's `wait` with a command is close to this already.
   - A **budget** per routine and per day, using the cost per run Huntaway already records.
   - A _Routines_ page that lists every routine with its next run, last result and cost, and lets you pause, run now
     and test each one.
   - The assistant creates routines with the automation tools it already has, which already ask you first.
4. **Morning brief.** A built-in routine template: on weekdays at a time you pick, the assistant reads your mail,
   calendar, reminders and the board's _Needs attention_, writes `brief.html` as an Artifact with a version for each
   day, and pushes one notification. Thumbs up and down on the brief's items are written into `MEMORY.md` as
   preferences, as Daily Brief does.
5. **Approval rules for the outside world.**
   - Keep permission prompts, and add rules per integration: "read mail: allow", "send mail: ask", "pay: never".
     These are Claude Code allow, ask and deny lists on MCP tool names, written by the assistant's settings page, so
     it's a settings UI more than new machinery.
   - Plain-language rules (Grok Bot, dots) need a reviewer model and can come later. The _Auto_ mode (Claude's
     classifier) is already a model reviewer, much like Grok Bot's Auto Review, so it may be enough for "everything
     else".
   - **Drafts by default:** mail tools save a draft, and Send is a separate tool that always asks.
   - **Expiry:** a prompt raised by a routine run that nobody answers within N minutes (default 30) is denied, and the
     run carries on without that action, so a routine never hangs on a card.
   - **Approve from the notification:** a push with Allow and Deny buttons, using the service worker's notification
     actions.
6. **An action log.** A list of what the assistant did outside the board: mail sent, events made, files shared, money
   spent. It's built from the tool calls of runs that the rules marked as _ask_ or _never_. Grok Bot has none and
   tells you to keep your own.

### Next: reaching it from anywhere

7. **Telegram channel, then others.** A Telegram bot is the easiest first channel: long polling works from a host on a
   LAN with no inbound port. Messages go to the assistant's thread, and its replies, notifications and approvals (as
   inline Allow and Deny buttons) come back.
   - **Owner only.** Your own account is linked with a code shown on the board, and unknown senders get nothing.
     Pairing codes for family members can come later.
   - **Choosing what goes where.** For each event, pick push, Telegram or both.
   - **Later channels:** Signal (`signal-cli`), Matrix and email. Mail is the cheapest to add: point a forwarding
     address (Cloudflare Email Workers, Mailgun or similar) at a webhook routine, and you have _email the assistant_.
     Webhook values are already treated as untrusted.
8. **Phone capture.** Make the installed PWA a **share target**, so a link, photo or text shared to Huntaway goes to
   the assistant. Add a quick-capture field, and dictation in the composer (the browser's speech recognition, or
   Whisper on the host). A notification that opens the assistant's composer instead of the board.
9. **Hand-offs to projects.** The assistant is the front door to the board too: "what needs me?" summarises _Needs
   attention_, reviews and reminders across projects and hosts, and "fix the login bug in huntaway" makes and starts
   a project task, then reports back when it's done (with `wait`). Most of this is prompting plus the board tools it
   already has, with cross-profile access where the user allows it.

### Then: acting in your accounts

10. **Integrations pack.** Curated, tested MCP servers with a guided setup on the assistant's settings page:
    - Google Workspace (Gmail, Calendar, Drive), or IMAP, SMTP and CalDAV for self-hosted mail and calendars.
    - Todoist or Things, Notion, an Obsidian vault (just a folder), Home Assistant, and banking that only reads.
    - Each comes with default approval rules (see 5).
    - claude.ai connectors already reach some of these through the Claude login, so this is mostly picking, setting
      up and setting rules.
11. **Secrets the agent can't read.** API keys and passwords kept by the host and injected into an MCP server's
    environment, never put in the thread or the workspace. This is Grok Bot's vault and NanoClaw's credential gateway.
    Huntaway's `gh` server already works this way: it gets a per-call token and refuses `gh auth token`.
12. **Watchers.** "Tell me when the price drops", "when my parcel ships", "when this page changes". Each is a one-off
    routine with a precheck and a stop condition, which deletes itself once it has fired.

### Later

13. **Several assistants with roles.** A family manager, a chief of staff, a researcher. Each has its own memory,
    tools, rules and channel, and they share `USER.md`. Templates can be exported without secrets or personal memory
    ("the recipe, not the meal").
14. **A browser with saved sign-ins.** A headful Chromium profile per assistant, driven over CDP (Playwright or Chrome
    DevTools MCP), with _Take over_ in the board over noVNC or a screencast. This is the biggest piece, and every
    product has one, but connectors and MCP cover most needs first.
15. **Memory consolidation.** A nightly routine that turns daily logs into `MEMORY.md` changes and shows you the diff
    to accept, as OpenClaw's dreaming and `DREAMS.md` do.
16. **Search across past threads.** SQLite FTS5 over the assistant's threads (Huntaway keeps them all), as a tool
    (`search_history`) and in the UI.
17. **Skills the assistant writes.** "Remember how to do this" saves a `SKILL.md` in the workspace, with a version,
    for you to review. Recording a browser session as a skill (_Teach a task_) needs 14 first.
18. **Voice talk mode.** A push-to-talk loop in the PWA: speech to text, with replies read out.

## Risks

A personal assistant is the case Simon Willison's "lethal trifecta" warns about: it has private data (mail, files),
reads untrusted content (incoming mail, web pages, webhooks) and can send things out (mail, messages, `curl`).
OpenClaw's incidents show what goes wrong. Points for Huntaway:

- **Don't let it run unattended in Bypass.** Background routines should use the default mode plus the rules in 5.
  Sending, paying, deleting and sharing should always ask, whatever the thread's mode, as automation changes do now.
- **Untrusted input stays marked.** Mail and webhook content go in `<untrusted-data>`, as automation templates already
  do. For mail-heavy routines, consider OpenClaw's reader/actor split: a run that reads untrusted content gets no
  tools that send things out, and only passes a summary on to a run that can.
- **The board's token is the keys to the house.** CVE-2026-25253 was the UI trusting a URL parameter that told it
  where to send its token. Channels and share targets must never take a server address or token from their input,
  and channel bots must check the sender, not only the chat.
- **It isn't a sandbox.** As the README says about profiles, agents run as the server's OS user and can read its
  token and database. An assistant holding mail credentials raises the stakes. Run it on a separate host or OS user
  (Huntaway's hosts already allow this), or in a container, as NanoClaw does.
- **Skills from strangers.** ClawHub's malicious skills are the warning. Install no public-registry skills without
  review, and show the diff of any skill the assistant writes.
- **Cost.** A routine every 30 minutes on a strong model adds up, as Grok Bot's users found. Prechecks, quiet runs,
  budgets and showing the cost per routine all matter, and Huntaway already tracks cost per run.

## A first slice

The smallest version that feels like a personal agent is 1, 2, 3 (profile-level routines with quiet runs), 4 and
the expiry and push-approval parts of 5. Telegram (7) is the next step and the one users notice most. Suggested
tasks:

1. Assistant: a long-lived thread per profile, with its own workspace folder and a sidebar entry (data model, API, UI).
2. Memory files: loading, a Memory tab, git history, import.
3. Profile-level automations with a _Message the assistant_ action, cron and one-shot triggers, active hours,
   `NO_REPLY` quiet runs, prechecks and budgets; a Routines page.
4. A morning brief template, written as an Artifact.
5. Approval rules per integration on the assistant's settings page, expiry for background prompts, and push
   notifications with Allow and Deny.
6. A Telegram channel: owner pairing, messages both ways, approvals by button.
7. A PWA share target and dictation.

## Open questions

- Should the assistant run on this host, or on a separate host or OS user because it holds mail credentials?
- Which first channel matters most: Telegram, Signal, email or iMessage (which needs a Mac)?
- Google Workspace, or self-hosted mail and calendar (IMAP and CalDAV)?
- One assistant per profile, or several with roles from the start?
- Should code tasks the assistant starts go to the usual project boards (the proposal), or stay with the assistant?
