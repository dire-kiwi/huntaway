// Port of server/src/mcp.rs.
/**
 * The board's MCP server: its tools' schemas and the JSON-RPC that lists and calls them (`handle`). The board serves it
 * over HTTP to the runs it starts (mcp/http.ts), so they have no helper process of their own.
 *
 * `huntaway mcp` is the stdio server that runs started before that (HA-180) launched, one per run: it relays every call
 * to the server that started the run. Each call keeps one id across retries, so a server restart mid-call is harmless.
 *
 * The `mcp` folder has the rest of the board's MCP side: the tools runs call (`tools`), the GitHub server (`gh_mcp`),
 * `wait` and its pull request watches, and permission prompts and questions.
 *
 * `huntaway mcp` is a short-lived process per agent, so this file imports nothing of the server's but `util.ts` and `hosts/proto.ts` (no
 * database, no other parts): the few constants the tool schemas show are mirrored below, and `mcp.test.ts` checks
 * that they match the modules that own them.
 */
import { createInterface } from "node:readline";
import { new_id, sleep, err_str } from "./util.ts";
import { VERSION } from "./hosts/proto.ts";

// ---------- constants mirrored from the modules that own them (see mcp.test.ts) ----------

/** db::STATUSES */
export const STATUSES = ["todo", "in_progress", "needs_attention", "in_review", "ready_for_merge", "done", "backlog"];
/** db::PERMISSION_MODES */
export const PERMISSION_MODES = ["default", "acceptEdits", "auto", "plan", "dontAsk", "bypassPermissions"];
/** db::RESOLUTIONS */
export const RESOLUTIONS = ["done", "not_done", "wont_fix"];
/** db::LABELS */
export const LABELS = ["plan", "artifact", "diagram"];
/** db::TASK_TYPES */
export const TASK_TYPES = ["scratch"];
/** db::THREAD_EFFORTS */
export const THREAD_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
/** mcp::questions::MAX_OPTIONS */
export const MAX_OPTIONS = 9;
/** mcp::wait::DEFAULT_SECS, MAX_SECS, UNWATCHED_MAX_SECS */
export const WAIT_DEFAULT_SECS = 600;
export const WAIT_MAX_SECS = 3600;
export const WAIT_UNWATCHED_MAX_SECS = 30;
/** mcp::pr_watch::EVENTS */
export const PR_EVENTS = ["checks_failed", "checks_passed", "comments", "conflicts"];
/** integrations::automations::MIN_INTERVAL_MINUTES */
export const MIN_INTERVAL_MINUTES = 5;
/** mcp::tools::TASK_FIELD_DEFAULT_LIMIT, TASK_FIELD_MAX_LIMIT */
export const TASK_FIELD_DEFAULT_LIMIT = 2000;
export const TASK_FIELD_MAX_LIMIT = 4000;

/**
 * Where `handle` sends a run's tool calls: a helper's line to its server (`Ctx`), or the board itself, for a run it
 * serves over HTTP (see mcp/http.ts).
 */
export interface Caller {
  /** A review thread's run: it gets the reviewers' tools. */
  review: boolean;
  call(tool: string, args: any): Promise<any>;
}

/** A run's line to the server that started it: board tool calls and permission prompts. */
export class Ctx implements Caller {
  url: string;
  token: string;
  run_id: string;
  review = false;

  constructor(url: string, token: string, run_id: string) {
    this.url = url;
    this.token = token;
    this.run_id = run_id;
  }

  async call(tool: string, args: any): Promise<any> {
    const call_id = new_id();
    // Only helpers whose schema offers get_task_field may receive bounded task details.
    const body = JSON.stringify({ run_id: this.run_id, call_id, tool, args: args ?? null, task_fields: true });
    // Since the server stopped answering; a call can take long (`wait`) before that.
    let failing_since: number | null = null;
    let delay = 500;
    for (;;) {
      // [permanent, error], or the result.
      let outcome: { ok: any } | { err: Error; permanent: boolean };
      try {
        const res = await fetch(`${this.url}/api/internal/mcp`, {
          method: "POST",
          headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
          body,
        });
        if (!res.ok) {
          // A 4xx (other than a timeout or rate limit) is the server's answer, not it being down: a stale token, say,
          // would otherwise be retried for half an hour.
          const permanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
          await res.arrayBuffer().catch(() => {});
          outcome = { err: new Error(`server returned ${res.status} ${res.statusText}`.trim()), permanent };
        } else outcome = { ok: await res.json() };
      } catch (e) {
        outcome = { err: e instanceof Error ? e : new Error(String(e)), permanent: false };
      }
      if ("ok" in outcome) {
        const v = outcome.ok;
        if (v && typeof v.error === "string") throw new Error(v.error);
        return v?.result ?? null;
      }
      if (outcome.permanent) throw new Error("huntaway server refused the call", { cause: outcome.err });
      failing_since ??= Date.now();
      // The server is restarting; retry with the same call id so nothing runs twice.
      if (Date.now() - failing_since >= 1800_000) throw new Error("huntaway server unreachable", { cause: outcome.err });
      await sleep(delay);
      delay = Math.min(delay * 2, 5000);
    }
  }
}

/**
 * A run's line to its server, from the run's `mcpServers` entry for the board (a Codex run's adapter makes its own calls
 * with it): a stdio helper's environment, or the URL and secret of the board's HTTP server for the run (mcp/http.ts),
 * whose secret `/api/internal/mcp` takes too.
 */
export function Ctx_from_server(entry: any): Ctx {
  if (typeof entry?.url === "string") {
    const m = /^(.*)\/api\/mcp\/([^/]+)\/[^/]+$/.exec(entry.url);
    const auth = entry.headers?.Authorization ?? entry.headers?.authorization;
    if (!m || typeof auth !== "string" || !auth.startsWith("Bearer ")) throw new Error("mcp.json's board server isn't this board's");
    return new Ctx(m[1], auth.slice(7), decodeURIComponent(m[2]));
  }
  const env = entry?.env ?? {};
  const get = (k: string): string => {
    if (typeof env[k] !== "string") throw new Error(`${k} missing from mcp.json`);
    return env[k];
  };
  return new Ctx(get("IA_URL"), get("IA_TOKEN"), get("IA_RUN_ID"));
}

/** Sent with `initialize`; Claude Code adds it to the agent's system prompt. */
const INSTRUCTIONS =
  "Tools for the Huntaway board, a kanban board where each task is worked by its own Claude agent. " +
  "The board has a profile for each Claude login (e.g. work, personal), each with its own projects and tasks. Besides your own " +
  "profile's, you can use the boards of the profiles that let your agents in (each profile chooses which, in Settings → Profiles). " +
  "list_projects shows every project you can use, labelled with its profile and host. The other tools take a project or task " +
  "from any of them by id or key; an unqualified key means your own profile's board first, and one used on several other boards " +
  "must be qualified as <profile>:<key> (e.g. work:SD-3) or with the profile argument. A task created in another profile's " +
  "project runs under that profile's Claude login. Don't create a project the user refers to as if it existed: if " +
  "list_projects doesn't show it, it may be on a profile's board you can't use, so ask the user.";

/** What a reviewer reports (offered to review threads only). */
function submit_review_tool(): any {
  return {
    name: "submit_review",
    description: "Report the outcome of your review. Call it once, when the review is complete. Serious issues are sent to the task's agent to fix.",
    inputSchema: {
      type: "object",
      properties: {
        verdict: {
          type: "string",
          enum: ["pass", "needs_fixes"],
          description: "needs_fixes if anything must be fixed before merging (list it in serious_issues); pass if it's ready to merge as far as correctness goes",
        },
        summary: { type: "string", description: "A few sentences: what you reviewed and what you found, including minor issues and suggestions worth mentioning" },
        serious_issues: {
          type: "array",
          items: { type: "string" },
          description:
            "Problems that must be fixed before merging: bugs that cause wrong behaviour, crashes, data loss, security holes, or a broken build or tests. One entry per issue: where (file:line), what goes wrong, and how to fix it. Empty if there are none. Style, nits and optional suggestions don't belong here.",
        },
        minor_issues: {
          type: "array",
          items: { type: "string" },
          description:
            "Minor issues and suggestions that don't block merging but may be worth a follow-up: one short entry each. Empty if there are none. Mention them in the summary too.",
        },
      },
      required: ["verdict", "summary", "serious_issues"],
    },
  };
}

/**
 * The only tools review threads get: they read untrusted content (diffs, pull requests, the repository), so they read
 * the board, wait, ask and report, but don't create, change, start, message or delete tasks or projects. The server
 * checks it (tools::execute_mcp), not just this list.
 */
const FOR_REVIEWERS = ["list_projects", "list_tasks", "get_task", "get_task_field", "get_project", "wait", "request_user_input", "submit_review"];

/** Whether a review thread may call `tool`. permission_prompt is Claude Code's own, for the reviewer's other tools. */
export function for_reviewers(tool: string): boolean {
  return tool === "permission_prompt" || FOR_REVIEWERS.includes(tool);
}

/**
 * What a thread in plan mode may call: it only reads the board until its plan is approved, so it can't start agents
 * (create_task with start, send_to_task, run_automation) or change anything. The server checks it (tools::execute_mcp):
 * a run's tool list stays as it started while its mode changes.
 */
const FOR_PLANNING = ["list_projects", "list_tasks", "get_task", "get_task_field", "get_project", "list_automations", "wait", "request_user_input", "submit_review"];

/** Whether a thread in plan mode may call `tool`. */
export function for_planning(tool: string): boolean {
  return tool === "permission_prompt" || FOR_PLANNING.includes(tool);
}

/** The board's tools, and for a review thread only those `for_reviewers`, with `submit_review`. */
function tools(review: boolean): any[] {
  let list = board_tools();
  if (review) {
    list.push(submit_review_tool());
    list = list.filter((t) => typeof t.name === "string" && for_reviewers(t.name));
  }
  return list;
}

/** The names of the tools in `tools(review)`. */
export function tool_names(review: boolean): string[] {
  return tools(review).map((t) => t.name).filter((n) => typeof n === "string");
}

function board_tools(): any[] {
  const status_enum = STATUSES;
  const permission_modes = [...PERMISSION_MODES, ""];
  const resolution = { type: "string", enum: RESOLUTIONS, description: "How a done task ended. Only with status done; defaults to done." };
  const profile = {
    type: "string",
    description: "The profile whose board to use (e.g. work), if not your own; must be one that lets your agents in (see list_projects)",
  };
  const task_ref = {
    type: "string",
    description: "Task id or key like ABC-12; <profile>:ABC-12 for a task on another profile's board whose key is also used elsewhere",
  };
  const labels = {
    type: "array",
    items: { type: "string", enum: LABELS },
    description:
      "Documents the task's agent writes besides its other work, each shown in a tab of the task (get_task gives their files): 'plan', an HTML plan it writes first and iterates on with the user before doing the work; 'artifact', an HTML page (an explainer, dashboard or prototype); 'diagram', a Mermaid diagram. On update_task it replaces the task's labels; [] clears them.",
  };
  const depends_on = {
    type: "array",
    items: { type: "string" },
    description:
      "Tasks in the same project (ids or keys like ABC-12) that have to be merged (done) before this task's agent starts. Until then, starting it queues it in in_progress. Replaces the task's current list; [] clears it.",
  };
  const start_from = {
    type: "string",
    description:
      "What the task's git worktree starts from, before it's made (by default the project's base branch): another task's key (e.g. ABC-12) to stack this task on its branch, a branch (local or on the remote), a pull request (#12 or its URL), or a commit SHA. A task or pull request's branch is what this task's pull request targets and its changes are compared with. Prefix with task:, branch:, pr: or commit: if it could be read as another. Only before the task's branch exists; not for a subproject's tasks. Empty string resets it.",
  };
  const starred = { type: "boolean", description: "Star the task (true) or unstar it (false): starred tasks are listed in the board's sidebar" };
  const remind_at = {
    type: "string",
    description:
      "Remind the user of the task later: it's listed under Reminders in the board's sidebar, and shows as due from this time on. A delay from now (30m, 2h, 1d 12h, 1w), a time like 2026-05-01T09:00:00Z, or a date and time in the host's time zone (2026-05-01 09:00; a date alone means 9:00). Replaces any reminder it has; an empty string clears it.",
  };
  const reminder = { type: "string", description: "What the reminder is for, shown with it (with remind_at, or to change the note of the reminder the task has)" };
  const copy_files = {
    type: "string",
    description:
      "Needs approval. Git-ignored files copied into each new worktree from the repository folder before the setup script, as .gitignore-style patterns, one per line (.env, /config/local.json, !*.bak), like a .worktreeinclude file (which is read too). Only files git ignores are copied, and none the worktree already has.",
  };
  const link_folders = {
    type: "string",
    description:
      "Needs approval. Git-ignored folders of the repository (paths relative to it, one per line, e.g. models/cache) symlinked into each new worktree instead of copied, so changes in them change the original",
  };
  const project_ref = "Project id, key or name (<profile>:<key> for another profile's board), or 'all'";
  const project_one = "Project id, key or name (<profile>:<key> for another profile's board); defaults to the current project";
  const list: any[] = [
    {
      name: "permission_prompt",
      description: "Internal: asks the user to approve a tool call.",
      inputSchema: {
        type: "object",
        properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } },
        required: ["tool_name", "input"],
      },
    },
    {
      name: "request_user_input",
      description:
        "Flag this task as 'Needs attention' because you need an answer, decision or information from the user. " +
        "The board shows your question as a card in the thread. When the possible answers are known (a choice between approaches, " +
        "yes or no, which of several things to do), give them as options: the user then answers with a click (or keys 1-9), and " +
        "can still write their own answer unless allow_other is false. After calling it, end your turn with the question (and " +
        "what the user needs to know to answer it); the user's reply (the options they picked, or what they wrote) will resume " +
        `the conversation. Up to ${MAX_OPTIONS} options.`,
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string", description: "The question, short enough to show on the task's card (e.g. 'Which database should the cache use?')" },
          options: {
            type: "array",
            maxItems: MAX_OPTIONS,
            description: "The answers to pick from, if they're known; put the one you recommend first",
            items: {
              type: "object",
              properties: {
                label: { type: "string", description: "The answer, in a few words" },
                description: { type: "string", description: "What picking it means, or its trade-offs" },
              },
              required: ["label"],
            },
          },
          multi_select: { type: "boolean", description: "Let the user pick more than one option (default false)" },
          allow_other: { type: "boolean", description: "Offer a free-text answer besides the options (default true)" },
        },
        required: ["question"],
      },
    },
    {
      name: "wait",
      description:
        "Wait without doing anything, e.g. for the tasks you created to finish, for a pull request's checks or reviews, or for a deploy or a background command. " +
        "The call blocks until the wait period is over, one of the listed tasks changes status, there's news about your pull_request, a subagent completes, fails or stops, your command exits, a message is sent to you, the run is " +
        "stopped, or you make another tool call (your subagents' tool calls other than board tools don't count), and says which. Meanwhile your task stays where it is (it doesn't need the user's attention) and the board shows it " +
        "as waiting rather than working, with your reason. Use it instead of sleeping or polling in a loop; call it again to keep " +
        `waiting. Without tasks, a command or a pull request, a wait lasts ${WAIT_UNWATCHED_MAX_SECS} seconds at most, as little but a message or a subagent can end it early: for CI ` +
        "or reviews on a pull request, give pull_request; for a deploy, give a command that exits once it's ready, or check and wait again. To wait for the user, use request_user_input instead.",
      inputSchema: {
        type: "object",
        properties: {
          reason: { type: "string", description: "What you're waiting for, shown on the board (e.g. 'waiting on OBP-1 and OWC-1', 'waiting for CI and review')" },
          seconds: {
            type: "number",
            minimum: 1,
            maximum: WAIT_MAX_SECS,
            description: `How long to wait at most (with tasks, a command or a pull request: default ${WAIT_DEFAULT_SECS}, at most ${WAIT_MAX_SECS}; without them: default and at most ${WAIT_UNWATCHED_MAX_SECS})`,
          },
          tasks: {
            type: "array",
            items: { type: "string" },
            description: "Tasks (ids or keys like ABC-12, on this host) to watch: the wait ends as soon as one of them changes status",
          },
          pull_request: {
            type: "string",
            description:
              "A pull request to watch: its number (in your task's repository), OWNER/REPO#NUMBER or URL. The wait ends on news about it you haven't been told yet (see pull_request_events): its head commit's checks finished (one failed, or all the required ones passed), someone other than your GitHub account commented or reviewed, it started to conflict with its base branch, or it was merged or closed. It says what happened in pull_request: the failed checks with their links, new comments with their author, file, line and text, and its merge state. What you've been told is remembered across waits, so after acting on the news wait on it again: a comment made meanwhile ends that wait straight away. The first wait on a pull request reports how its checks ended and a conflict, but not its earlier comments. GitHub is read every minute or so, as your GitHub account.",
          },
          pull_request_events: {
            type: "array",
            items: { type: "string", enum: PR_EVENTS },
            description:
              "With pull_request, the news that ends the wait (default all of it): checks_failed, checks_passed, comments (comments and reviews), conflicts. Its being merged or closed always does.",
          },
          command: {
            type: "string",
            description:
              "A shell command (bash) to run in your working directory while you wait: the wait ends as soon as it exits, and returns its exit code and the end of its output. Use one that blocks until what you're waiting for is ready (e.g. 'gh run watch 123'), or loop until it is (e.g. 'until curl -sf https://example.com/health; do sleep 15; done'). It's approved like your Bash calls, and stopped with everything it started if the wait ends first. For a pull request, give pull_request instead.",
          },
        },
        required: ["reason"],
      },
    },
    {
      name: "list_projects",
      description:
        "List projects (id, key, name, repository path, profile, host) on every board you can use: your own profile's and those of other profiles (e.g. work, personal) that let your agents in, on every linked host. Projects the user has archived are left out. Check here before creating a project: one the user names may be on another profile's board.",
      inputSchema: { type: "object", properties: { profile } },
    },
    {
      name: "list_tasks",
      description:
        "List tasks. Defaults to the current project (or, for a subproject and its tasks, the subproject's tasks); pass project_id='all' for every project on your profile's board (with profile, on that board; profile='all' for every board you can use).",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string", description: project_ref },
          profile,
          status: { type: "string", enum: status_enum },
          subproject: { type: "string", description: "Only the tasks of this subproject (task id or key), 'none' for top-level tasks only, or 'all'" },
          include_assistant: { type: "boolean", description: "Also list your profile's assistant (key A-<n>), which is left out otherwise" },
        },
      },
    },
    {
      name: "get_task",
      description:
        "Get a bounded overview of a task. Small fields are included inline; field_lengths lists every available field's length in Unicode characters, and omitted_fields names fields too large to include. Read any field (e.g. description, last_message, review, created_tasks) with get_task_field. Lengths count plain text for strings and pretty JSON for other values, including null.",
      inputSchema: { type: "object", properties: { task_id: task_ref, profile }, required: ["task_id"] },
    },
    {
      name: "get_task_field",
      description:
        "Read one task field in bounded pages. Use a field name from get_task's field_lengths. Strings return plain text; other values return pretty JSON (format says which). offset, limit, length and total_length count Unicode characters, starting at offset 0. Follow next_offset until null; an offset at or past the end returns empty content. Reads use the current field value, so a task changing between calls may change the pages.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: task_ref,
          profile,
          field: { type: "string", description: "Top-level field name from get_task's field_lengths (e.g. description, last_message, review or created_tasks)" },
          offset: { type: "integer", minimum: 0, default: 0, description: "Zero-based character offset" },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: TASK_FIELD_MAX_LIMIT,
            default: TASK_FIELD_DEFAULT_LIMIT,
            description: "Maximum number of characters to return",
          },
        },
        required: ["task_id", "field"],
      },
    },
    {
      name: "create_task",
      description:
        "Create a task on the board. Set start=true to immediately launch an agent on it (in its own git worktree by default); with depends_on, it's queued in in_progress and its agent starts once those tasks are merged. A task in another profile's project runs under that profile's Claude config and login.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string", description: "Full instructions for the agent that will work on it (markdown)" },
          project_id: {
            type: "string",
            description: "Defaults to the current project. Also takes a key or name, or <profile>:<key> for a project on another profile's board (e.g. work:SD)",
          },
          profile,
          status: { type: "string", enum: status_enum },
          resolution,
          use_worktree: { type: "boolean" },
          start: { type: "boolean" },
          subproject: {
            type: "string",
            description:
              "Add the task to this subproject (task id or key): it branches from the subproject's branch and merges back into it. Defaults to your own subproject, if you're in one; 'none' for a top-level task.",
          },
          is_subproject: { type: "boolean", description: "Make the new task a subproject, with its own board of tasks that merge into its branch" },
          labels,
          type: {
            type: "string",
            enum: ["scratch", "subproject"],
            description:
              "'scratch' for a scratch task, whose agent works in its own folder for whatever the user asks, without a worktree, branch or merge: in no project (keyed S-<n>) unless you give project_id or subproject, where it can read the repository (and the subproject's worktree). Or 'subproject', the same as is_subproject. Leave out for a normal task.",
          },
          depends_on,
          start_from,
          starred,
          remind_at,
          reminder,
          now: { type: "boolean", default: true, description: "New tasks start in the board's Now view; pass false to start this one in Later instead." },
        },
        required: ["title"],
      },
    },
    {
      name: "update_task",
      description:
        "Update a task's title, description, status (and, for a done task, its resolution), pull request, preview URL, labels, dependencies or what its worktree starts from (before it's made), star it, or set a reminder to come back to it later (remind_at, e.g. when the user asks to be reminded or work has to wait until a later date). Moving a task to ready_for_merge asks its agent to merge its work (where merges need the user's approval, to summarize it first, and to merge once the user approves), after which the agent sets it to done (a task with no changes to merge goes straight to done). Tasks merge one at a time: a merge that needs changes moves its task to in_progress with remerge, to let the next task merge while it makes them.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: task_ref,
          profile,
          title: { type: "string" },
          description: { type: "string" },
          status: { type: "string", enum: status_enum },
          resolution,
          pr_url: { type: "string", description: "The task's pull request; the board links it from the task's card. Empty string clears it." },
          preview_url: {
            type: "string",
            description:
              "Where the task's work can be tried (e.g. its PR's preview deployment); the board shows whether it's up. A project that previews its pull requests fills it in from pr_url. Empty string clears it.",
          },
          labels,
          remerge: {
            type: "boolean",
            description:
              "With status in_progress, on a task that's merging: it steps out of the merge queue so the next task can merge, and rejoins the end of the queue when its agent's run ends, rather than going to in_review.",
          },
          depends_on,
          start_from,
          starred,
          remind_at,
          reminder,
          now: {
            type: "boolean",
            description:
              "Put the task in the board's Now view (true) or send it back to Later (false). Tasks start in Now (create_task can start one in Later), and any update to one (or a message to it) puts it back there; a task with no activity for a day (the host's setting) goes back.",
          },
        },
        required: ["task_id"],
      },
    },
    {
      name: "delete_task",
      description:
        "Delete a task: stop its agent, delete its thread and remove its worktree, discarding uncommitted changes (a subproject's tasks go with it). " +
        "It asks the user to confirm first (say why in reason): the call waits for their answer, and if they don't confirm, nothing is deleted. " +
        "Only when the user asks for it, or a task you created is no longer wanted; you can't delete your own task or the subproject you're in. " +
        "To close a task while keeping it, set it to done (with a resolution) with update_task instead.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: task_ref,
          profile,
          delete_branch: {
            type: "boolean",
            description: "Also delete the task's git branch (and its tasks' branches, for a subproject); kept by default",
          },
          reason: { type: "string", description: "Why it should be deleted, shown to the user when they're asked to confirm" },
        },
        required: ["task_id"],
      },
    },
    {
      name: "send_to_task",
      description:
        "Send a message to a task's agent, starting or resuming it. If that agent is currently running, the message goes to it straight away and it reads it after its current step (or, if it can't take messages while it works, it's queued and delivered when its run ends).",
      inputSchema: { type: "object", properties: { task_id: task_ref, profile, message: { type: "string" } }, required: ["task_id", "message"] },
    },
    {
      name: "get_project",
      description: "Get a project's settings, including its prompt instructions (see update_project).",
      inputSchema: { type: "object", properties: { project_id: { type: "string", description: project_one }, profile } },
    },
    {
      name: "update_project",
      description:
        "Change a project's settings; leave out the ones to keep. The prompt instructions are what the board tells agents as a task moves across the board, " +
        "and each replaces a default: start_prompt is sent to a task's agent when it starts (moving to in_progress), after the task's " +
        "title and description; review_prompt tells the reviewer what to look for when the task moves to in_review, after where its " +
        "changes are (the board adds how to report the verdict); merge_prompt tells the agent how to merge when the task moves to " +
        "ready_for_merge, after which branch to merge into which (the board adds asking the user if it can't, stepping out of the merge queue to make changes, and setting the task to " +
        "done). An empty string resets a prompt, base_branch, model or permission_mode to the default. Only change these when the user asks. " +
        "Changing permission_mode, a script, repo_path (and move_repo), use_worktrees or worktrees_root asks the user to approve the whole change first " +
        "(say why in reason): the call waits for their answer, and if they don't approve it nothing changes. A project's agent configs " +
        "can only be changed by the user.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string", description: project_one },
          profile,
          name: { type: "string", description: "The project's display name" },
          key: {
            type: "string",
            description:
              "The prefix of the project's task keys (e.g. ABC for ABC-12), letters and digits. Its tasks' keys change with it; the old keys still find them, and stay the project's.",
          },
          base_branch: { type: "string", description: "The branch new task branches start from and merge into" },
          model: { type: "string", description: "The model the project's agents use, over the profile's and host's default" },
          start_prompt: { type: "string" },
          review_prompt: { type: "string" },
          merge_prompt: { type: "string" },
          auto_review: { type: "boolean", description: "Review each task's changes when it moves to in_review" },
          review_rounds: {
            type: "integer",
            minimum: 0,
            maximum: 20,
            description: "How many times in a row a review's serious issues go back to the agent to fix before the task is left for the user",
          },
          group_name: {
            type: "string",
            description: "The sidebar group the project is in, shared with the host's other projects of that group name; an empty string takes it out of its group",
          },
          reviewers: {
            type: ["array", "null"],
            maxItems: 6,
            description:
              "Who reviews each task, each in its own review thread; their serious issues are combined. An empty list uses the profile's reviewers (by default one reviewer with the task's own config). claude_config_id is an agent config's id (omit it for the task's config), model and effort override the defaults. prompt replaces the project's review_prompt for this reviewer (what it looks for), and skills are names of skills it uses (named in its prompt); the board's own (a project's own or global ones) among them are on in its thread whether or not they are for the project.",
            items: {
              type: "object",
              properties: {
                claude_config_id: { type: "string" },
                model: { type: "string" },
                effort: { type: "string" },
                prompt: { type: "string" },
                skills: { type: "array", items: { type: "string" } },
              },
            },
          },
          permission_mode: {
            type: "string",
            enum: permission_modes,
            description: "Needs approval. What the project's agents may do without asking the user, over the host's default",
          },
          setup_script: { type: "string", description: "Needs approval. Runs in a task's new worktree" },
          teardown_script: { type: "string", description: "Needs approval. Runs in a task's worktree before it's removed" },
          copy_files,
          link_folders,
          status_script: { type: "string", description: "Needs approval. Runs whenever one of the project's tasks changes status" },
          status_scripts: {
            type: "object",
            additionalProperties: { type: "string" },
            description: "Needs approval. A script per status (the keys), run when a task moves into it; replaces them all, and a blank script is none",
          },
          repo_path: {
            type: "string",
            description:
              "Needs approval. The project's repository folder, e.g. after the folder was moved or renamed: it must be the same repository (or, with move_repo, a path that doesn't exist yet). Task worktrees are reconnected to it.",
          },
          move_repo: {
            type: "boolean",
            description:
              "Needs approval. With repo_path, move the repository folder from where it is now to repo_path, rather than pointing the project at a folder that has already moved. The project's agents must not be running.",
          },
          use_worktrees: { type: "boolean", description: "Needs approval. Whether new tasks get a git worktree of their own" },
          worktrees_root: { type: "string", description: "Needs approval. The folder tasks' worktrees go in" },
          reason: { type: "string", description: "Why you're making the change, shown to the user when it needs their approval" },
        },
      },
    },
    {
      name: "create_project",
      description:
        "Add a project (a local repository directory) to your profile's board (or, with profile, to that profile's). A missing directory is created. Only when the user asks for a new project: first check list_projects, since the project may already be on another profile's board, and if it might be on a board you can't use, ask the user instead. " +
        "It asks the user to approve the folder first (say why in reason): the call waits for their answer, and if they don't approve it nothing is added.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          repo_path: { type: "string", description: "The folder, as an absolute path or starting with ~/" },
          profile,
          reason: { type: "string", description: "Why you're adding it, shown to the user when they're asked to approve it" },
        },
        required: ["repo_path"],
      },
    },
  ];
  const props = list.find((t) => t.name === "update_project")?.inputSchema?.properties;
  if (props) {
    props.auto_summary = { type: "boolean", description: "Once a task's review passes, have an agent summarise its changes for the user to read before merging" };
    props.summarizer = {
      type: ["object", "null"],
      description: "The one summarizer, for when there's only one: the same as summarizers with a list of one, and null the same as an empty list. Prefer summarizers.",
      properties: { claude_config_id: { type: "string" }, model: { type: "string" }, effort: { type: "string" } },
    };
    props.summarizers = {
      type: ["array", "null"],
      description:
        "Who writes those summaries, each in a thread of its own, so which skills and prompts summarise best can be compared: claude_config_id is an agent config's id (omit it for the task's config), model and effort override the defaults; name says which is which where the summaries are shown; skills are skills it uses while writing (their names, e.g. \"summarize-changes\"); prompt replaces the board's instructions on how to write the summary. [{}] is one with the task's config and the defaults; an empty list or null uses the profile's summarizers.",
      items: {
        type: "object",
        properties: {
          claude_config_id: { type: "string" },
          model: { type: "string" },
          effort: { type: "string" },
          name: { type: "string" },
          skills: { type: "array", items: { type: "string" } },
          prompt: { type: "string" },
        },
      },
    };
  }
  list.push(...automation_tools(profile, project_one));
  return list;
}

/** The tools for a project's automations (see integrations/automations.rs). */
function automation_tools(profile: any, project_one: string): any[] {
  const automation_ref = { type: "string", description: "The automation's id, or its name in project_id (see list_automations)" };
  const trigger = {
    type: "object",
    description:
      `What starts it: {kind: 'interval', every_minutes} (${MIN_INTERVAL_MINUTES} minutes to 31 days, counted from when it's turned on or changed); ` +
      "{kind: 'daily', time: 'HH:MM', weekdays} (in the host's time zone, on those weekdays, or every day with none); " +
      "or {kind: 'webhook', filters, coalesce_seconds, coalesce_key}: each POST to its URL that passes all the filters. " +
      "Use the fields of its kind.",
    properties: {
      kind: { type: "string", enum: ["interval", "daily", "webhook"] },
      every_minutes: { type: "integer", minimum: MIN_INTERVAL_MINUTES },
      time: { type: "string", description: "A time of day like 09:30" },
      weekdays: { type: "array", items: { type: "string", enum: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] } },
      filters: {
        type: "array",
        description: "Conditions a delivery must meet: path names a value as templates do (event, action, labels, body.issue.user.login…)",
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            op: { type: "string", enum: ["equals", "not_equals", "starts_with", "contains", "in", "not_in", "exists", "not_exists"] },
            value: { description: "A string, or a list for in and not_in; none for exists and not_exists" },
          },
          required: ["path", "op"],
        },
      },
      coalesce_seconds: {
        type: "integer",
        minimum: 0,
        maximum: 3600,
        description: "Deliveries within this many seconds of the first make one run, with the latest one's values (0: each runs by itself)",
      },
      coalesce_key: { type: "string", description: "With coalescing, only deliveries with the same key (a template such as {{body.issue.number}}) go together" },
    },
    required: ["kind"],
  };
  const action = {
    type: "object",
    description:
      "What it does: {kind: 'create_task', title, description, task_type, labels, claude_config_id, model, effort, status, start} creates a task in the automation's project, " +
      "or {kind: 'send_to_task', task_id, message} sends a message to one of the project's tasks. Title, description and message are templates: " +
      "{{body.<path>}}, {{headers.<name>}}, {{query.<name>}}, {{event}}, {{action}}, {{labels}} and {{delivery}} from a webhook delivery " +
      "(marked as untrusted data for the agent), and {{date}}, {{time}}, {{now}}, {{automation}} and {{count}} from the board.",
    properties: {
      kind: { type: "string", enum: ["create_task", "send_to_task"] },
      title: { type: "string" },
      description: { type: "string", description: "Instructions for the new task's agent (markdown)" },
      task_type: { type: "string", enum: TASK_TYPES, description: "Leave out for a code task" },
      labels: {
        type: "array",
        items: { type: "string", enum: LABELS },
        description: "Documents the task's agent writes besides its other work: a plan, an artifact (an HTML page) or a diagram",
      },
      claude_config_id: { type: "string", description: "One of the project's agent configs; leave out for its default" },
      model: { type: "string" },
      effort: { type: "string", enum: THREAD_EFFORTS },
      status: { type: "string", enum: ["todo", "backlog"], description: "Where the task goes (default todo); a started task moves to in_progress" },
      start: { type: "boolean", description: "Start the new task's agent straight away" },
      task_id: { type: "string", description: "The task to message: an id or key of a task in the same project" },
      message: { type: "string" },
    },
    required: ["kind"],
  };
  const asks = "It asks the user to approve it first (say why in reason): the call waits for their answer, and if they don't approve it nothing changes.";
  return [
    {
      name: "list_automations",
      description:
        "List a project's automations: what starts each one (an interval, a time of day or a webhook), what it does (create a task or message one), whether it's on, when it next runs, and its latest run. The time zone the times of day are in comes with them.",
      inputSchema: { type: "object", properties: { project_id: { type: "string", description: project_one }, profile } },
    },
    {
      name: "create_automation",
      description:
        "Add an automation to a project: it creates a task there, or sends a message to one of its tasks, on a schedule or whenever its webhook URL gets a delivery " +
        `(e.g. from GitHub). Only when the user asks for one. ${asks} ` +
        "For a webhook, the result has its hook_path (and webhook_url, if the host's public address is set), which lets whoever has it start runs, so only give it to " +
        "where the deliveries come from; with generate_secret, the secret to sign deliveries with is in the result, once.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string", description: project_one },
          profile,
          name: { type: "string" },
          trigger,
          action,
          enabled: { type: "boolean", description: "On straight away (default true)" },
          generate_secret: {
            type: "boolean",
            description: "For a webhook: make a secret that deliveries must be signed with (X-Hub-Signature-256, as GitHub's webhook Secret does)",
          },
          reason: { type: "string", description: "Why, shown to the user when they're asked to approve it" },
        },
        required: ["name", "trigger", "action"],
      },
    },
    {
      name: "update_automation",
      description:
        "Change a project's automation; leave out what to keep. Turning it off (enabled false) or renaming it is done straight away; any other change, " +
        `including turning it on, asks the user. ${asks}`,
      inputSchema: {
        type: "object",
        properties: {
          automation_id: automation_ref,
          project_id: { type: "string", description: project_one },
          profile,
          name: { type: "string" },
          trigger,
          action,
          enabled: { type: "boolean" },
          generate_secret: { type: "boolean", description: "For a webhook: a new signing secret, returned once in the result" },
          remove_secret: { type: "boolean", description: "For a webhook: stop checking deliveries' signatures" },
          rotate_url: { type: "boolean", description: "For a webhook: a new URL (the old one stops working)" },
          reason: { type: "string", description: "Why, shown to the user when they're asked to approve it" },
        },
        required: ["automation_id"],
      },
    },
    {
      name: "delete_automation",
      description: `Delete a project's automation (its run history goes with it; the tasks it made stay). Only when the user asks for it. ${asks}`,
      inputSchema: {
        type: "object",
        properties: {
          automation_id: automation_ref,
          project_id: { type: "string", description: project_one },
          profile,
          reason: { type: "string", description: "Why, shown to the user when they're asked to confirm" },
        },
        required: ["automation_id"],
      },
    },
    {
      name: "run_automation",
      description:
        "Run an automation once now, on or off, as its Run now (or, for a webhook, Test) does on the board: a webhook's run is a test delivery of payload (else the latest delivery's body) through its filters and templates, without the signature check, duplicate check or coalescing. Returns the run: its status, detail and task.",
      inputSchema: {
        type: "object",
        properties: {
          automation_id: automation_ref,
          project_id: { type: "string", description: project_one },
          profile,
          payload: { description: "For a webhook: the test delivery's JSON body" },
          event: { type: "string", description: "For a webhook: the test delivery's event (X-GitHub-Event), e.g. issues" },
        },
        required: ["automation_id"],
      },
    },
  ];
}

/** The tool schemas check_args checks against, made once. */
let schemas: any[] | null = null;

/**
 * Checks an agent's arguments against the tool's schema: an argument the tool doesn't have, or a missing required one,
 * is an error that names the tool's arguments. Claude Code doesn't check them itself for a deferred tool whose schema
 * the agent never loaded (with ToolSearch), and an agent that guesses (`task` for `task_id`) would otherwise get "not
 * found" or, where the argument is optional, the default (its own project) instead. Returns the error, or null.
 */
export function check_args(tool: string, args: any): string | null {
  schemas ??= [...board_tools(), submit_review_tool()];
  // Internal, and filled in by Claude Code.
  const schema = tool === "permission_prompt" ? undefined : schemas.find((t) => t.name === tool);
  if (!schema) return null;
  const props: Record<string, any> = schema.inputSchema.properties;
  // serde_json's maps are sorted by key.
  const names = () => Object.keys(props).sort().join(", ");
  const hint = "If you haven't loaded this tool's schema (e.g. with ToolSearch), load it first.";
  let given: Record<string, any>;
  if (args === null || args === undefined) given = {};
  else if (typeof args === "object" && !Array.isArray(args)) given = args;
  else return `${tool}'s arguments must be an object`;
  // `host` picks a linked host (see tools::dispatch).
  const extra = Object.keys(given).sort().find((k) => !Object.hasOwn(props, k) && k !== "host");
  if (extra !== undefined) return `${tool} has no argument ${JSON.stringify(extra)}; its arguments are ${names()}. ${hint}`;
  for (const r of schema.inputSchema.required ?? []) {
    const v = given[r];
    if (v === undefined || v === null || v === "") return `${tool} needs ${r} (its arguments are ${names()}). ${hint}`;
  }
  return null;
}

/** An MCP request's response, or null for a notification. */
export async function handle(ctx: Caller, req: any): Promise<any | null> {
  if (!req || typeof req !== "object" || !Object.hasOwn(req, "id")) return null; // notifications get no response
  const id = req.id;
  const method = typeof req.method === "string" ? req.method : "";
  let result: any;
  let error: any = null;
  switch (method) {
    case "initialize":
      result = {
        protocolVersion: typeof req.params?.protocolVersion === "string" ? req.params.protocolVersion : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "huntaway", version: VERSION },
        instructions: INSTRUCTIONS,
      };
      break;
    case "ping":
      result = {};
      break;
    case "tools/list":
      result = { tools: tools(ctx.review) };
      break;
    case "tools/call": {
      const name = typeof req.params?.name === "string" ? req.params.name : "";
      const args = req.params?.arguments ?? null;
      try {
        const v = await ctx.call(name, args);
        // permission_prompt must return the raw decision JSON as text.
        result = { content: [{ type: "text", text: name === "permission_prompt" ? JSON.stringify(v) : JSON.stringify(v, null, 2) }] };
      } catch (e) {
        result = { content: [{ type: "text", text: `Error: ${err_str(e)}` }], isError: true };
      }
      break;
    }
    default:
      error = { code: -32601, message: `method not found: ${method}` };
  }
  return error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result };
}

export async function serve_stdio(): Promise<void> {
  const env = (k: string) => {
    const v = process.env[k];
    if (v === undefined) throw new Error(`${k} not set`);
    return v;
  };
  const ctx = new Ctx(env("IA_URL"), env("IA_TOKEN"), env("IA_RUN_ID"));
  ctx.review = process.env.IA_REVIEW === "1";
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    let req: any;
    try {
      req = JSON.parse(line);
    } catch {
      continue;
    }
    // Requests are handled concurrently: permission prompts can block for a long time.
    handle(ctx, req)
      .then((resp) => {
        if (resp) process.stdout.write(`${JSON.stringify(resp)}\n`);
      })
      .catch((e) => console.error("mcp:", e));
  }
  // Claude Code closed our stdin: the calls still going (a `wait`, a prompt) go with us, as they do in Rust.
  process.exit(0);
}

// `bin/huntaway mcp` runs this file directly, so the helper doesn't load the whole server (see main.ts).
if (import.meta.main) {
  serve_stdio().catch((e) => {
    console.error(`Error: ${err_str(e)}`);
    process.exit(1);
  });
}
