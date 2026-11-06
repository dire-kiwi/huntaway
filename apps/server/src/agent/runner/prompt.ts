// Port of server/src/agent/runner/prompt.rs: what a run is told: the task's prompt, and the system prompt about the
// board, its tools and the task's settings (see `preview`).
import { join } from "node:path";
import * as db from "../../db.ts";
import type { ExternalLink, Profile, Project, Task } from "../../db.ts";
import { ApiError } from "../../http.ts";
import type { Shared } from "../../state.ts";
import { err_str, expand_tilde, path_str } from "../../util.ts";
import * as documents from "../documents.ts";
import * as agent_tools from "../agent_tools.ts";
import * as prompts from "../prompts.ts";
import * as task_tmp from "../task_tmp.ts";
import * as worktree from "../../git/worktree.ts";
import * as gh_mcp from "../../mcp/gh_mcp.ts";
import * as summary from "../../review/summary.ts";
import * as workflows from "../../integrations/workflows.ts";
import { MCP_SERVER_NAME } from "../runner.ts";
import { gh_note, github_account, uses_gh_server } from "./access.ts";

/** What else decides what a run is told (see `instructions`). */
export interface Told {
  /** It runs on Codex rather than Claude Code. */
  codex: boolean;
  /** In plan mode, which Codex is told of (Claude Code tells Claude itself). */
  plan: boolean;
  /** It has our gh server (see uses_gh_server). */
  gh_tools: boolean;
  github_account: string | null;
  /** The host's profiles, and the run's own. */
  profiles: Profile[];
  profile: Profile;
  /** Its temp folder (see agent/task_tmp.rs), if it has one. */
  tmp: string | null;
  /** For the assistant (and a routine's thread, its assistant's), its memory as its files say now (see assistant/memory.prompt), last. */
  memory: string;
}

/**
 * What a run is told on top of its agent's own system prompt: Claude Code's `--append-system-prompt-file`, or Codex's
 * developer instructions (to which `launch` adds a reviewer's sandbox). `s`: what system_prompt says.
 */
export function instructions(s: string, task: Task, to: Told): string {
  if (to.codex && to.plan) {
    s += "\n\nYou are in plan mode: investigate and propose a plan, but don't change any files. The user will " + "switch modes once they approve it.";
  }
  if (to.gh_tools && to.codex) {
    // Codex's sandbox may keep `gh` in the shell off the network, and its GitHub app (the codex_apps server's github
    // tools) may not reach the user's repositories. Codex has no hook to turn gh in the shell away, so it's only told.
    const n = gh_mcp.SERVER_NAME;
    const account = to.github_account != null ? ` as the GitHub account ${to.github_account}` : "";
    const other = to.github_account != null ? " or would act as another account" : "";
    s +=
      `\n\nFor GitHub, use the \`${n}\` MCP server's tools (e.g. \`${n}.pr_view\`, \`${n}.pr_diff\`), which run gh with ` +
      `the user's login${account}: don't run \`gh\` in your shell, which may not reach GitHub${other}, and the codex_apps ` +
      `GitHub tools may not have access to this repository.`;
  } else if (to.gh_tools) {
    s += gh_note(to.github_account);
  }
  if (to.tmp != null) {
    s +=
      `\n\nYour temp folder is ${to.tmp} (\`$TMPDIR\` in your shell${task.kind === "review" ? ", shared with the task's agent" : ""}). ` +
      `Put scratch files, logs and test data there rather than directly in /tmp. It's deleted once the task is done, so ` +
      `don't keep anything there that's needed after that.`;
  }
  // Which profiles' boards it can't use, so it asks rather than make a project that may be there.
  if (task.kind !== "review") s += profiles_note(to.profiles, to.profile);
  s += to.memory;
  return s;
}

/** The options of a new thread that change what it's told (see `preview`). */
export interface PreviewOptions {
  /** `task` (the default), `subproject` or `scratch`. */
  type?: string | null;
  /** Some of db::LABELS, comma-separated. */
  labels?: string | null;
  /** For a task: whether it has its own worktree (by default, as the project's new tasks do). */
  worktree?: boolean | null;
  /** `claude` or `codex` (by default, what a new task in the project runs on). */
  runtime?: string | null;
  /** Its permission mode (by default, the project's). */
  permission_mode?: string | null;
}

/** Rust's `{:?}` of a string or a list of strings. */
const debug = (v: string | string[]) => (Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(", ")}]` : JSON.stringify(v));

/**
 * What the agent of a new thread in `project` would be told on top of its agent's own system prompt (see
 * `instructions`), for the project's settings to show: a task numbered as the project's next, with the options given
 * and the project's settings as they are now. Its title and id are placeholders. Also gives whether it's on Codex, and
 * its permission mode (the one given, or else the one it inherits).
 */
export async function preview(state: Shared, project: Project, o: PreviewOptions): Promise<[string, boolean, string]> {
  const kind = o.type ?? "task";
  if (!["task", "subproject", "scratch"].includes(kind)) throw ApiError.bad(`unknown type ${debug(kind)}: it's task, subproject or scratch`);
  const given = (o.labels ?? "").split(",").filter((l) => l.trim());
  let labels: string[];
  try {
    labels = documents.check_labels(given);
  } catch (e) {
    throw e instanceof ApiError ? e : ApiError.bad(err_str(e));
  }
  if (o.permission_mode != null && !db.PERMISSION_MODES.includes(o.permission_mode)) {
    throw ApiError.bad(`permission_mode must be one of ${debug(db.PERMISSION_MODES)}`);
  }
  const c = state.db();
  const number = db.value<number>(c, "SELECT next_number FROM projects WHERE id=?1", project.id);
  if (number === undefined) throw new Error("Query returned no rows");
  const profile = db.get_profile(c, project.profile_id);
  if (!profile) throw ApiError.not_found("profile");
  const profiles = db.list_profiles(c);
  const use_worktree = (kind === "subproject" ? true : kind === "scratch" ? false : (o.worktree ?? project.use_worktrees)) && project.is_git;
  // As serde would read the Rust's JSON for it: a row with those fields, the rest defaulted.
  const task = db.Task_from_row({
    id: "<task id>",
    profile_id: profile.id,
    project_id: project.id,
    kind: "task",
    subproject: kind === "subproject",
    task_type: kind === "scratch" ? db.SCRATCH : null,
    labels: JSON.stringify(labels),
    number,
    title: "Task title",
    description: "",
    status: "in_progress",
    position: 0.0,
    use_worktree,
    worktree_state: "none",
    running: false,
    merging: false,
    auto_allow: "[]",
    cost_usd: 0.0,
    last_activity_at: "",
    created_at: "",
    updated_at: "",
    permission_mode: o.permission_mode ?? null,
  });
  // Where `worktree::setup` would put it.
  if (use_worktree) {
    const name = worktree.folder_name(project, task);
    const repo = expand_tilde(project.repo_path);
    const base = project.base_branch ? project.base_branch : ((await worktree.current_branch(repo)) ?? "HEAD");
    task.worktree_path = path_str(join(project.worktrees_root, name));
    task.branch = `ia/${project.key.toLowerCase()}-${name}`;
    task.base_branch = base;
  }
  const github =
    task.branch != null ? ((await worktree.github(expand_tilde(project.repo_path), (await worktree.remote_base(state, task, project)) ?? null)) ?? null) : null;
  const docs: Array<[string, string]> = documents.paths(state, task).map(([l, p]: [string, string]) => [l, path_str(p)]);
  const tools = agent_tools.for_preview(state, project.id);
  let codex: boolean;
  if (o.runtime === "codex") codex = true;
  else if (o.runtime === "claude") codex = false;
  else if (o.runtime != null) throw ApiError.bad(`unknown runtime ${debug(o.runtime)}: it's claude or codex`);
  else codex = db.task_is_codex(state.db(), task);
  const permission_mode = db.effective_permission_mode(task, state.db(), project);
  const gh_tools = uses_gh_server(tools);
  const account = github_account(project, profile);
  const base = system_prompt(task, project, null, [], docs, github, gh_tools, workflows.board_opens_pr(state, task));
  const tmp = path_str(task_tmp.dir(state, task));
  const to: Told = { codex, plan: permission_mode === "plan", gh_tools, github_account: account, profiles, profile, tmp, memory: "" };
  return [instructions(base, task, to), codex, permission_mode];
}

/** The key a group task's number goes with, in place of a project's key. */
export const GROUP_TASK_KEY = "G";

/**
 * What goes before a task's number in its key: its project's key, for a group task `G`, for a scratch task `S`, or for a
 * profile's assistant and its routine threads `A`.
 */
export function key_prefix(task: Task, project: Project | null | undefined): string {
  if (project) return project.key;
  if (task.group_name != null) return GROUP_TASK_KEY;
  if (db.is_scratch(task)) return db.SCRATCH_TASK_KEY;
  if (db.is_assistants(task)) return db.ASSISTANT_TASK_KEY;
  return "T";
}

/**
 * A task's first prompt: the task, the project's instructions for starting (see agent/prompts.rs, or `start`, its
 * workflow's for In progress: see integrations/workflows/engine.ts's start_instructions), then any message it
 * was started with (e.g. from `create_task`). A message that calls a skill (`/name …`) goes first instead, since Claude
 * Code only expands a command at the start of a prompt, and the task becomes part of its arguments.
 */
export function start_prompt(task: Task, project: Project | null | undefined, text: string, start: string | null = null): string {
  const key = key_prefix(task, project);
  text = text.trim();
  // The assistant is a conversation, not a task to start on: its first prompt is the user's message. A routine thread's
  // is the routine's (see automations/routines.ts).
  if (db.is_assistants(task)) return text;
  let p = "";
  if (is_slash_command(text)) p += `${text}\n\n`;
  p += `# ${key}-${task.number}: ${task.title}\n`;
  if (task.description.trim()) p += `\n${task.description.trim()}\n`;
  p += external_links_note(task.external_links);
  p += `\n---\n\n${start ?? prompts.start_task(task, project)}\n`;
  if (text && !is_slash_command(text)) p += `\n${text}\n`;
  return p;
}

/** The tasks elsewhere a task is for, as its first prompt lists them. */
function external_links_note(links: ExternalLink[]): string {
  if (!links.length) return "";
  let s = "\nThis task is for:\n";
  for (const l of links) {
    const provider = l.provider === "asana" ? "Asana" : l.provider;
    const title = l.title ? l.title : l.url;
    s += `- ${provider} task: ${title} (${l.url})\n`;
  }
  return s;
}

/** Whether a message starts with a command, such as a skill (`/name`, or `/plugin:name`), rather than, say, a path. */
function is_slash_command(text: string): boolean {
  if (!text.startsWith("/")) return false;
  const name = text.slice(1).split(/\s/)[0] ?? "";
  return name.length > 0 && /^[A-Za-z0-9\-_:.]+$/.test(name);
}

/** Which other profiles' boards on this host the agent's tools reach, so it looks there before adding a project that may already be on one. */
export function profiles_note(profiles: Profile[], own: Profile): string {
  const others = profiles.filter((p) => p.id !== own.id);
  const shared = others.filter((p) => db.grants(p, own.name));
  const closed = others.filter((p) => !db.grants(p, own.name));
  const names = (ps: Profile[]) => ps.map((p) => p.name).join(", ");
  let s = `\n\nYour profile on the board is "${own.name}".`;
  if (shared.length) s += ` Your board tools also reach these profiles' boards: ${names(shared)}.`;
  if (closed.length) {
    s +=
      ` These profiles' boards don't let your agents in, so their projects aren't listed: ${names(closed)}. If the user mentions a ` +
      `project you can't find, it may be on one of them: ask the user rather than creating it.`;
  }
  return s;
}

/**
 * How an agent asks the user for input, then how it finishes: with a summary of `done`. The last paragraph is the
 * wording that made agents ask most often when they should, and least when they shouldn't, of those tried on the ends
 * of real turns (HA-198, see scripts/ask-eval): without it they left their questions in their summaries, and the tasks
 * went to "In review" as if they were finished.
 */
function ask_and_finish(done: string): string {
  return (
    "If you are blocked or need a decision or information from the user, call `request_user_input` with your question " +
    '(and its `options`, when the choices are known), then end your turn. The task is flagged "Needs attention", and ' +
    "the user's reply resumes this conversation.\n\n" +
    `When you finish, end with a concise summary of ${done}; the task then moves to "In review".\n\n` +
    "You must call `request_user_input` before you end a turn whose last message needs something from the user before the " +
    "task can go on: a question or choice for them, a plan or design to approve, whether to go ahead with a step (a merge, " +
    "a deletion, a release), or something only they can do or give you (a credential, a setting, a command run as them). " +
    "This holds wherever it is in the message, even in the middle of a report of what you did. The one exception is an offer " +
    'of something extra once everything the user asked for is done ("I can also…", "want me to add…?"), which they can ' +
    "take up or ignore: leave that in the summary."
  );
}

/**
 * What a task's agent is told on top of its agent's own system prompt, in paragraphs separated by blank lines
 * (`instructions` adds more). `group`: for a group task, its group's projects. `docs`: the files its labels ask it to
 * write, by label (see agent/documents.rs). `github`: where a task with its own branch opens its pull request, if its
 * repository is on GitHub. `board_pr`: the project's workflow opens it instead, once the agent's work is done.
 */
export function system_prompt(
  task: Task,
  project: Project | null | undefined,
  parent: Task | null | undefined,
  group: Project[],
  docs: Array<[string, string]>,
  github: worktree.Github | null | undefined,
  gh_tools: boolean,
  board_pr = false,
): string {
  const p = project ?? null;
  const tools =
    `You have access to the \`${MCP_SERVER_NAME}\` MCP tools for the Huntaway board ` +
    "(list_projects, list_tasks, get_task, get_task_field, create_task, update_task, send_to_task, request_user_input, wait). " +
    "They also reach other profiles' boards that let your agents in: list_projects shows each project's profile.\n\n" +
    "When you have nothing to do until something happens (other tasks, CI, reviews, a deploy), call `wait` rather than " +
    "sleeping or polling: the board then shows you as waiting rather than working.\n" +
    "- For CI or reviews on a pull request, give it the `pull_request` (its number or URL). It ends when the checks fail " +
    "or pass, someone comments or reviews, the branch conflicts with its base, or it's merged or closed, and says what " +
    "happened.\n" +
    "- For a deploy, give it a `command` that exits once it's done.";
  // How a group task or a subproject runs its tasks.
  const coordinate =
    "- Follow them with `list_tasks` and `get_task`, and guide their agents with `send_to_task`.\n" +
    "- While they work, wait for them with `wait` (listing them in `tasks`) rather than ending your turn.\n" +
    "- Run tasks that build on each other one after the other, and independent ones in parallel.";
  let s: string;
  if (task.kind === "task" && db.is_assistant(task)) {
    const dir = task.work_dir ?? "its own folder";
    s =
      "You are the personal assistant of this Huntaway profile: one long-lasting conversation with the user, " +
      `thread A-${task.number} (id ${task.id}) on the Huntaway board, which is a kanban board where each task is worked by its own ` +
      "Claude agent, grouped into projects. You aren't a coding agent and you aren't in a project or a repository: " +
      "you help the user with whatever they ask, such as answering questions, looking things up, keeping track " +
      "of things, and planning and following their work across the board.\n\n" +
      `Your working directory is your own workspace folder (${dir} in the board's data dir), which lasts ` +
      "between conversations. Your memory is kept in files there (see below), and you can keep other notes " +
      "there too.\n\n" +
      "You can use the skills and MCP servers set up for this profile (beyond any project), and the board's tools.\n\n" +
      `${tools}\n\n` +
      "Hand code work to project tasks rather than doing it yourself: find the project with `list_projects`, " +
      "then `create_task` there (with start=true to start its agent, when the user wants that), and follow it " +
      "with `get_task` or `wait`. Don't change repositories, commit, push or open pull requests yourself. Tasks " +
      "you create are recorded as yours. You may run on a host of your own, linked to the user's board: `wait` " +
      "only watches tasks on the host you run on, so follow tasks on other hosts with `get_task`, and if a project " +
      "you expect isn't there, its board may not let your host's agents in yet (the error says so).\n\n" +
      "Routines wake you on a schedule or a webhook: they're this profile's automations (`list_automations` with " +
      "routines=true, and `create_automation`, `update_automation`, `delete_automation` and `run_automation` with an " +
      "action of kind `message_assistant`), and the user is asked to approve each change. By default a routine runs " +
      "in a fresh thread of its own under this one, whose report is posted here (it stays quiet when there's " +
      "nothing new); with mode `thread` its message comes straight to this thread. When the user asks you to " +
      "remind them of something, make it an `at` routine (one that runs once, then turns itself off) in mode " +
      "`thread`, whose message asks you to remind them. Routines' reports come with the user's next message.\n\n" +
      "If you need a decision or information from the user before you can go on, call `request_user_input` " +
      "with your question (and its `options`, when the choices are known), then end your turn. Otherwise just " +
      "reply: this thread stays open and never goes to review or merge, so don't move it to another status.";
  } else if (task.kind === "task" && db.is_routine(task)) {
    const dir = task.work_dir ?? "its workspace";
    const parent_id = task.parent_id ?? "";
    s =
      "You are the personal assistant of this Huntaway profile, doing one run of one of its routines (a check or job " +
      `the user set up to run on a schedule or when a webhook is delivered) in thread A-${task.number} (id ${task.id}), a thread of ` +
      `its own under your main conversation with the user (id ${parent_id}). Huntaway is a kanban board where each ` +
      "task is worked by its own Claude agent, grouped into projects. You aren't a coding agent and you aren't in " +
      "a project or a repository.\n\n" +
      `Your working directory is your workspace folder (${dir} in the board's data dir), shared with your main ` +
      "thread: read the notes you keep there, and update them when the run finds something worth remembering.\n\n" +
      "You can use the skills and MCP servers set up for this profile (beyond any project), and the board's tools.\n\n" +
      `${tools}\n\n` +
      "Do what the routine asks, then end with a short report for the user: your last message is posted to your " +
      "main thread, where they read it. Say what's new or needs them, not what you checked. If there's nothing " +
      "new or worth telling them, make your last message just NO_REPLY: nothing is posted, and the run is quiet. " +
      "The user isn't watching this thread: only call `request_user_input` if the run can't go on without them. " +
      "Don't move this thread to another status.";
  } else if (task.kind === "task" && db.is_scratch(task)) {
    // One from a scratch chat works in the chat's folder, which may be shared.
    const dir =
      task.work_dir != null ? "a scratch folder, for notes and experiments" : "the task's own folder, for notes and experiments, where you can write freely";
    const key = key_prefix(task, p);
    // In a project (API 51) it reads the repository; in a subproject, the subproject's worktree too.
    let place: string;
    if (!p) {
      place =
        "A scratch task isn't in a project or a repository: it's for whatever the user asks, such as " +
        "answering questions, trying things out, or planning and running work across the board.";
    } else {
      place =
        `This scratch task is in the project ${p.name} (key ${p.key}, id ${p.id}, repository ${p.repo_path}, which you can read). It has no ` +
        "worktree or branch of its own: it's for whatever the user asks about the project, such as answering " +
        "questions, looking into the code, trying things out, or planning and running the project's work. " +
        "Don't change the repository, commit, push or open pull requests: create a task for changes.";
      const sp = parent && parent.subproject ? parent : null;
      if (sp) {
        const wt =
          sp.worktree_path != null && sp.worktree_state === "ready"
            ? ` and is checked out in the subproject's worktree at ${sp.worktree_path}, which you can read`
            : "";
        place +=
          `\n\nIt's part of the subproject ${key}-${sp.number} ("${sp.title}"), whose branch \`${sp.branch ?? "?"}\` collects the work of its tasks${wt}. ` +
          "Tasks you create are added to the subproject.";
      }
    }
    s =
      `You are an agent working on scratch task ${key}-${task.number} ("${task.title}", id ${task.id}) on the Huntaway board, a kanban board where ` +
      `each task is worked by its own Claude agent, grouped into projects. Your working directory is ${dir}.\n\n` +
      `${place}\n\n` +
      `${tools}\n\n` +
      "Use the board tools to look across projects, create and update tasks, and start agents on tasks (create_task " +
      "with start=true, or send_to_task) when the user asks for that. Tasks you create are recorded as this task's.\n\n" +
      ask_and_finish("what you did");
  } else if (task.kind === "review") {
    const key = p?.key ?? "T";
    const [number, title] = parent ? [parent.number, parent.title] : [0, "?"];
    const is_summary = summary.is_summary(task);
    const workflow = workflows.is_workflow(task);
    const role = workflow ? "You run a step of a workflow" : is_summary ? "You summarise the changes made" : "You are the code reviewer";
    s = `${role} for task ${key}-${number} ("${title}") on the Huntaway board, a kanban board where each task is worked by its own Claude agent.`;
    if (parent && parent.worktree_state === "ready") {
      s += ` Your working directory is that task's git worktree at ${parent.worktree_path ?? "?"}${parent.branch != null ? ` on branch \`${parent.branch}\`` : ""}.`;
    }
    s += workflow
      ? "\n\nRead only: don't edit files, commit, push, merge, comment on pull requests, or change tasks on the " +
        "board. Don't call `request_user_input`. Each message says what the step is to do and how to report: call " +
        "`submit_review` only when it asks for a verdict."
      : is_summary
        ? "\n\nRead only: don't edit files, commit, push, merge, comment on pull requests, or change tasks on the " +
          "board. Don't call `request_user_input` or `submit_review`. Your last message is the summary of the changes " +
          "the user reads before merging them."
        : "\n\nReview only: don't edit files, commit, push, merge, comment on pull requests, or change tasks on the " +
          "board. Don't call `request_user_input`. When the review is complete, call `submit_review` exactly once " +
          "with your verdict, then end your turn with a short summary of the review.";
  } else if (task.kind === "task" && documents.documents_only(task)) {
    const key = key_prefix(task, p);
    s =
      `You are an agent working on task ${key}-${task.number} ("${task.title}", id ${task.id}) on the Huntaway board, a kanban board where each ` +
      `task is worked by its own Claude agent.${documents.system_prompt(task, docs, p, group)}\n\n${tools}\n\n${ask_and_finish("what you made or changed")}`;
  } else if (task.kind === "task" && !p && task.group_name != null) {
    const name = task.group_name;
    const projects = !group.length
      ? " The group has no projects at the moment (it may have been renamed or ungrouped): ask the user which " + "projects to use."
      : ` The group's projects, whose repositories you can read:\n${group.map((g) => `- ${g.name} (key ${g.key}, id ${g.id}, repository ${g.repo_path})`).join("\n")}`;
    s =
      `You are the planning agent for task ${GROUP_TASK_KEY}-${task.number} ("${task.title}", id ${task.id}) on the Huntaway board, a kanban board where each ` +
      "task is worked by its own Claude agent. Your working directory is a scratch folder for notes.\n\n" +
      `This is a group task: it isn't in a project but plans work across the projects of the group "${name}".${projects}\n\n` +
      `${tools}\n\n` +
      "Your job is to plan and coordinate, not to change the repositories yourself:\n" +
      "- Break the work into tasks in the right projects with `create_task` (always give its project_id; start=true " +
      "launches an agent on one, and depends_on orders tasks within a project).\n" +
      `${coordinate}\n\n` +
      "Tasks you create are recorded as this task's: the board shows how many are done, and `get_task` on this task " +
      "lists them.\n\n" +
      ask_and_finish("the tasks you created and where they stand");
  } else {
    const key = p?.key ?? "T";
    const subproject = parent && parent.subproject ? parent : null;
    // Whether it opens a pull request, as its project's settings say (a subproject's tasks have one of their own).
    const prs = !p || db.pull_requests(p, subproject != null);
    const gh = prs ? (github ?? null) : null;
    s = `You are an agent working on task ${key}-${task.number} ("${task.title}") on the Huntaway board.`;
    if (p) s += ` Project: ${p.name} (repository ${p.repo_path}).`;
    if (task.worktree_path != null && task.branch != null) {
      s +=
        `\n\nYou are in a dedicated git worktree at ${task.worktree_path} on branch \`${task.branch}\`${task.base_branch != null ? ` (branched from \`${task.base_branch}\`)` : ""}. Make all changes here. ` +
        "When you complete a meaningful unit of work, commit it to this branch with a clear message. " +
        // It pushes the branch for its pull request.
        `Do not ${gh && !board_pr ? "merge or switch branches" : "push, merge, or switch branches"} unless asked.`;
    }
    // Stacked on another task's (or pull request's) branch, which it merges into rather than the project's.
    const sf = task.start_from;
    if (sf && (sf.type === "task" || sf.type === "pull_request") && task.base_branch != null && task.branch != null) {
      const on = sf.type === "task" ? "another task" : "a pull request";
      s +=
        ` This task is stacked on ${on}: \`${task.base_branch}\` is that ${sf.type === "task" ? "task" : "pull request"}'s branch, so your work is compared with it and your pull request ` +
        "targets it, and its own changes aren't yours to review or redo.";
    }
    if (task.subproject) {
      const br = task.branch ?? "this task's branch";
      const base = task.base_branch ?? p?.base_branch ?? "the base branch";
      const how =
        !p || p.subproject_pull_requests
          ? "through pull requests that target it, if the project uses them"
          : "without pull requests, which the project's settings turn off for subprojects' tasks";
      s +=
        "\n\nThis task is a subproject: it has its own board of tasks, each worked by its own agent in a worktree " +
        `branched from \`${br}\`, and their work is merged back into \`${br}\` (${how}). The subproject as a whole is then merged into \`${base}\`, so its tasks add up ` +
        `to a series of small, reviewable changes instead of one big one. Their merges land on \`${br}\` on the ` +
        "remote, so pull before working in your worktree.\n\n" +
        "Your job is mostly to plan and coordinate:\n" +
        "- Break the work into small tasks with `create_task` (they're added to this subproject; start=true " +
        "launches an agent on one).\n" +
        coordinate;
    }
    if (subproject) {
      const sp_branch = task.base_branch ?? subproject.branch ?? "the subproject's branch";
      let merge: string;
      if (prs) {
        const open = gh_tools ? `pr_create with base \`${sp_branch}\`` : `\`gh pr create --base ${sp_branch}\``;
        merge =
          `If you open a pull request, target \`${sp_branch}\` (e.g. ${open}), pushing \`${sp_branch}\` first if the remote doesn't ` +
          "have it yet. If you merge without a pull request, merge";
      } else {
        merge = "When you merge, merge";
      }
      const wt = subproject.worktree_path != null ? `, which is checked out in the subproject's worktree at ${subproject.worktree_path}` : "";
      s +=
        `\n\nThis task is part of the subproject ${key}-${subproject.number} ("${subproject.title}"), whose branch \`${sp_branch}\` collects the work of ` +
        `its tasks: your branch starts from \`${sp_branch}\` and is merged back into it, not into the project's main ` +
        `branch. ${merge} into \`${sp_branch}\`${wt}. Tasks you create are added to the subproject too.`;
    }
    if (gh && task.branch != null && board_pr) {
      s +=
        `\n\nThe repository is on GitHub (${gh.repo}). The board pushes this task's branch and opens its pull request once your work is done, ` +
        "so commit everything, but don't push the branch or open a pull request yourself, even if the project's own instructions (e.g. " +
        "in CLAUDE.md) say to. Once it has one, the board pushes your new commits to it too.";
    } else if (gh && task.branch != null) {
      const br = task.branch;
      const base0 = task.base_branch ?? p?.base_branch ?? null;
      const base = base0 ? base0 : null;
      // The repository is named, as gh would pick one from the remotes' fetch URLs.
      const repo = gh.repo;
      const open = gh_tools
        ? `the gh tools' pr_create with repo \`${repo}\`, head \`${br}\`${base != null ? ` and base \`${base}\`` : ""}`
        : `\`gh pr create --repo ${repo} --head ${br}${base != null ? ` --base ${base}` : ""}\`, or the gh tools' git_push and pr_create with the same repo, ` +
          "head and base";
      s +=
        `\n\nThe repository is on GitHub (${repo}), so before you finish, open a pull request for this task's work ` +
        "unless the project's own instructions (e.g. in CLAUDE.md) say otherwise:\n" +
        "1. Commit everything.\n" +
        `2. Push the branch: \`git push -u ${gh.remote} ${br}\`${gh_tools ? ", or the gh tools' git_push if that fails" : ""}.\n` +
        `3. Open the pull request${base != null ? ` into \`${base}\`` : ""} in ${repo} (${open}), with a title and a body that say what changed and how to ` +
        "try it.\n" +
        "If the branch has a pull request already, push to it instead. Put the pull request's link in your summary. " +
        "A task with no changes on its branch doesn't need one.";
    } else if (!prs && task.branch != null) {
      // Turned off: project instructions that say to open one don't apply.
      s +=
        `\n\nThis project's settings turn off pull requests for its ${subproject ? "subprojects' tasks" : "tasks"}, so don't push this task's branch or open a ` +
        "pull request for it unless the user asks, even if the project's own instructions (e.g. in CLAUDE.md) say to.";
    }
    s += `\n\n${tools}\n\n${ask_and_finish("what you did")} You may create follow-up tasks with \`create_task\`.`;
  }
  // What its labels ask for (a task that makes only documents was told already).
  if (!documents.documents_only(task)) s += documents.labels_prompt(docs);
  return s;
}
