// Port of server/src/agent/runner/launch.rs: launching a run: preparing its worktree, prompt, MCP config and sandbox,
// then starting the agent.
import { statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as db from "../../db.ts";
import type { Run, Task } from "../../db.ts";
import type { Shared } from "../../state.ts";
import { context, err_str, expand_tilde, new_id, path_str } from "../../util.ts";
import * as runs from "../runs.ts";
import * as documents from "../documents.ts";
import * as memory from "../assistant/memory.ts";
import * as agent_tools from "../agent_tools.ts";
import * as codex from "../codex.ts";
import * as task_tmp from "../task_tmp.ts";
import * as worktree from "../../git/worktree.ts";
import * as relocate from "../../git/relocate.ts";
import * as checkpoints from "../../git/checkpoints.ts";
import * as gh_mcp from "../../mcp/gh_mcp.ts";
import * as review from "../../review.ts";
import * as attachments from "../../attachments.ts";
import { Cancelled, MCP_SERVER_NAME, load } from "../runner.ts";
import {
  board_tools_allowed,
  cache_dirs,
  codex_run_effort,
  gh_allowed,
  gh_hook_settings,
  git_common_dir,
  github_account,
  ignored_dirs,
  review_filesystem,
  uses_gh_server,
} from "./access.ts";
import { as_told } from "./merge.ts";
import { instructions, start_prompt, system_prompt, type Told } from "./prompt.ts";
import { set_writes_documents, user_input, write_steers } from "./queue.ts";

/** The nearest effort Claude has to one only Codex models offer. */
export function claude_effort(e: string): string {
  return e === "ultra" ? "max" : e === "minimal" ? "low" : e;
}

/**
 * Keep the effort a run was started with, as the agent is given it, for the statistics of the reviews of its work (see
 * review/stats.rs). The agent's own default is kept as an empty effort, so it isn't taken for a run from before this.
 */
export function record_effort(state: Shared, run_id: string, effort: string | null) {
  try {
    db.run(state.db(), "UPDATE runs SET effort=?2 WHERE id=?1", run_id, effort?.trim() ?? "");
  } catch (e) {
    console.warn(`run ${run_id}: recording a run's effort: ${err_str(e)}`);
  }
}

const is_dir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Prepare the working directory and start claude. `cancelled` says whether the launch was stopped meanwhile (Rust drops
 * the launch's future at its next await): it then throws `Cancelled` at its next step rather than go on.
 */
export async function launch(state: Shared, run: Run, text: string, cancelled: () => boolean = () => false): Promise<void> {
  const check = () => {
    if (cancelled()) throw new Cancelled();
  };
  const task_id = run.task_id;
  // Not in the folder the project is moving from.
  const project_id = db.get_task(state.db(), task_id)?.project_id ?? null;
  if (project_id != null) {
    await relocate.settled(state, project_id);
    check();
  }
  let [task, project, profile] = load(state, task_id);
  // `/plan` gives the task the plan label, if it was sent some other way than `send_run`.
  if (task.kind === "task" && run.kind !== "compact" && documents.plan_command(text) != null) {
    task = documents.add_plan(state, task);
  }
  // A thread created while its profile had no configs takes the default it has now, and keeps it from here on with its
  // conversation.
  if (task.claude_config_id == null && task.session_id == null) {
    const config = db.task_claude_config(state.db(), task);
    if (config) {
      const t = state.update_task(task_id, [["claude_config_id", config.id]]);
      if (!t) throw new Error("task not found");
      task = t;
    }
  }
  // A review thread works on the task it reviews; a task may be part of a subproject.
  let parent: Task | null = task.parent_id ? db.get_task(state.db(), task.parent_id) : null;

  // The assistant works only in a workspace of its own: not one that's become a symlink, which could be another's.
  if (db.is_assistant(task)) {
    try {
      memory.checked(state, task);
    } catch (e) {
      throw context("the assistant's workspace", e);
    }
  }
  // Resolve the working directory for this thread.
  const add_dirs: string[] = [];
  // (`work_dir` says the same for a thread whose run is going.)
  const doc_dir = documents.work_dir(state, task);
  let cwd: string;
  if (doc_dir != null) {
    // A scratch task works in its own folder, reading its project if it's in one, as does a task that makes only
    // documents (see documents::documents_only). One in a subproject reads the subproject's worktree as well.
    if (project) add_dirs.push(project.repo_path);
    if (parent && task.kind === "task" && parent.subproject && parent.worktree_state === "ready" && parent.worktree_path != null) {
      add_dirs.push(parent.worktree_path);
    }
    cwd = path_str(doc_dir);
  } else if (task.kind === "review" && project) {
    if (parent && parent.worktree_state === "ready") {
      if (parent.worktree_path == null) throw new Error("worktree path missing");
      cwd = parent.worktree_path;
    } else if (parent && parent.use_worktree) {
      throw new Error("the task's worktree isn't set up");
    } else {
      cwd = project.repo_path;
    }
  } else if (project && task.use_worktree) {
    if (task.worktree_state !== "ready") state.add_event(task_id, "info", "Setting up worktree…");
    task = await worktree.setup(state, task_id);
    check();
    if (task.worktree_path == null) throw new Error("worktree path missing");
    cwd = task.worktree_path;
  } else if (project) {
    cwd = project.repo_path;
  } else {
    cwd = path_str(state.profile_scratch_dir(profile.id));
  }
  // A group task plans across its group's projects, so it can read their repositories.
  const group = task.group_name != null && !project && task.kind === "task" ? db.group_projects(state.db(), task.profile_id, task.group_name) : [];
  add_dirs.push(...group.map((p) => p.repo_path));
  await mkdir(expand_tilde(cwd), { recursive: true }).catch(() => {});
  check();
  // A checkpoint of the worktree before the agent changes it (see git/checkpoints.rs), taken after any rewind asked for
  // meanwhile, whose conversation rollback this run makes.
  await checkpoints.before_run(state, task, run);
  check();
  const reloaded = db.get_task(state.db(), task_id);
  if (!reloaded) throw new Error("task not found");
  task = reloaded;
  const rewind = checkpoints.pending_rewind(task) ?? null;
  // A labelled task's agent writes its documents in the task's own folder, wherever it works.
  const docs: Array<[string, string]> = documents.paths(state, task).map(([l, p]: [string, string]) => [l, path_str(p)]);
  const own = documents.dir(state, task.id);
  const own_dir = docs.length && doc_dir !== own ? path_str(own) : null;
  if (own_dir != null) {
    await mkdir(own_dir, { recursive: true }).catch(() => {});
    check();
    add_dirs.push(own_dir);
  }
  set_writes_documents(run.id, own_dir != null || doc_dir === documents.dir(state, task.id));
  // Setting up a subproject task's worktree may have set up the subproject's too.
  if (task.parent_id != null && task.kind === "task") parent = db.get_task(state.db(), task.parent_id);
  const told = as_told(state, task, project);
  // A task with its own branch in a repository on GitHub opens a pull request for it.
  let github: worktree.Github | null = null;
  if (project && task.branch != null && task.kind === "task") {
    const base = await worktree.remote_base(state, task, project);
    check();
    github = (await worktree.github(project.repo_path, base ?? null)) ?? null;
    check();
  }

  // `/plan`: the system prompt has the plan's instructions, as the task has the label (see above).
  const plan = task.kind === "task" && run.kind !== "compact" ? documents.plan_command(text) : null;
  const plan_file = docs.find(([l]) => l === "plan");
  if (plan != null && plan_file) text = documents.plan_prompt(plan_file[1], plan, true);
  let prompt = task.session_id == null && task.kind === "task" && run.kind !== "compact" ? start_prompt(task, project, text) : text;
  // Every run but a `/compact` takes messages while it works (see `can_steer`); the prompt is its first.
  const input = run.kind !== "compact";
  if (input) prompt = `${user_input(new_id(), prompt)}\n`;

  const permission_mode = db.effective_permission_mode(task, state.db(), project);
  const blank = (m: string | null | undefined) => m == null || !m.trim();
  const host_model = db.get_setting(state.db(), "default_model");
  const model = [task.model, project?.model ?? null, profile.default_model, host_model].find((m) => !blank(m)) ?? null;
  const effort = task.effort != null && task.effort.trim() ? task.effort : db.get_setting(state.db(), "default_effort");

  const account = github_account(project, profile);
  // The task's own temp folder, its TMPDIR, which goes once it's done (see agent/task_tmp.rs).
  const tmp = task_tmp.ensure(state, task);
  const tmp_env: Array<[string, string]> = tmp != null ? [["TMPDIR", tmp]] : [];

  const config = db.task_claude_config(state.db(), task);
  const is_codex = config != null && db.is_codex(config);
  // The assistant's memory files, loaded here rather than by the agent so Claude and Codex both get them.
  const told_memory = await memory.for_run(state, task);
  check();
  // The project's own skills and MCP servers, and the ones it turns off (for the assistant, its profile's).
  const tools: agent_tools.RunTools = agent_tools.for_task_run(state, task, project);
  if (is_codex) {
    // Claude's models don't run on Codex; a thread's own pick is used as given.
    const inherited = [project?.model ?? null, profile.default_model, db.get_setting(state.db(), "default_model")];
    const codex_model =
      task.model != null && task.model.trim() ? task.model : (inherited.find((m) => m != null && m.trim() && !codex.is_claude_model(m)) ?? null);
    // Not every Codex model takes every effort, and the effort can come from elsewhere than the model (the host's
    // default is Claude's and Codex's both, and a task on its default model inherits a model it wasn't picked for): one
    // the model doesn't take gives way to the model's own default (when its models can be listed).
    const codex_effort = config ? await codex_run_effort(config, codex_model, effort) : effort;
    check();
    record_effort(state, run.id, codex_effort);
    const [approval_policy, approvals_reviewer, sandbox] = codex.policy(permission_mode, task.kind === "review");
    const gh_tools = uses_gh_server(tools);
    const base = system_prompt(told, project, parent, group, docs, github, gh_tools);
    const profiles = db.list_profiles(state.db());
    const to: Told = { codex: true, plan: permission_mode === "plan", gh_tools, github_account: account, profiles, profile, tmp, memory: told_memory };
    let instr = instructions(base, task, to);
    const own_gh = Object.hasOwn(tools.mcp_servers, gh_mcp.SERVER_NAME);
    // Reviewers read and report (see the Claude arguments below).
    const disabled_mcp_tools: Record<string, string[]> = {};
    if (task.kind === "review" && !own_gh) disabled_mcp_tools[gh_mcp.SERVER_NAME] = [...gh_mcp.WRITES];
    // In their read-only sandbox, reviewers can still build and run the tests to check what they find, as long as it
    // doesn't change the work.
    const git_dir = await git_common_dir(cwd);
    check();
    let filesystem: Record<string, string> = {};
    if (task.kind === "review" && sandbox === "read-only") {
      const work = [path_str(expand_tilde(cwd)), ...(git_dir != null ? [git_dir] : [])];
      const ignored = await ignored_dirs(cwd);
      check();
      filesystem = review_filesystem([...cache_dirs(), ...ignored], work);
      instr +=
        "\n\nYour sandbox can't change the work: its files are read-only. You can write to the temp directories (/tmp), " +
        "package caches and the working directory's git-ignored directories, such as build output, so you can build it " +
        "and run its tests to check what you find. If a build needs to write anywhere else in the working directory, " +
        "point it at /tmp instead (e.g. `CARGO_TARGET_DIR`).";
    }
    const writable_roots: string[] = [...(git_dir != null ? [git_dir] : []), ...cache_dirs()];
    if (own_dir != null) writable_roots.push(own_dir);
    if (tmp != null) writable_roots.push(tmp);
    const spec: any = {
      cwd,
      thread_id: task.session_id,
      model: codex_model,
      effort: codex_effort,
      approval_policy,
      approvals_reviewer,
      sandbox,
      plan: permission_mode === "plan",
      compact: run.kind === "compact",
      developer_instructions: instr,
      input,
      writable_roots,
      filesystem,
      skills_dir: tools.skills_dir != null ? `${tools.skills_dir}/.claude/skills` : null,
      approved_mcp_servers: Object.keys(tools.mcp_servers).filter((n) => tools.allowed.includes(agent_tools.tool_prefix(n))),
      disabled_mcp_tools,
      review_waits: approvals_reviewer === "auto_review",
    };
    if (rewind?.before_turn != null) spec.revert_before_turn = rewind.before_turn;
    const l: runs.Launch = {
      run_id: run.id,
      cwd,
      args: [],
      env: tmp_env,
      config_dir: db.task_config_dir(state.db(), task),
      prompt,
      input,
      review: task.kind === "review",
      mcp_servers: tools.mcp_servers,
      github_account: account,
      codex: spec,
    };
    console.log(`task ${task_id} run ${run.id}: starting codex (${run.kind}) in ${cwd}, resume=${task.session_id != null}`);
    await started(state, run, l, check);
    rewound(state, task_id, rewind);
    return;
  }

  const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
  // Echoed back, the messages show where in the turn the agent took them in.
  if (input) args.push("--input-format", "stream-json", "--replay-user-messages");
  // The project's own skills and MCP servers, and the ones it turns off.
  const gh_tools = uses_gh_server(tools);
  const base = system_prompt(told, project, parent, group, docs, github, gh_tools);
  const profiles = db.list_profiles(state.db());
  const to: Told = { codex: false, plan: permission_mode === "plan", gh_tools, github_account: account, profiles, profile, tmp, memory: told_memory };
  // In a file rather than an argument: the assistant's memory and a project's documents can make it longer than the most
  // an argument may be (128 KiB on Linux).
  const prompt_file = join(runs.run_dir(state, run.id), "system-prompt.md");
  await mkdir(runs.run_dir(state, run.id), { recursive: true });
  try {
    await writeFile(prompt_file, instructions(base, task, to));
  } catch (e) {
    throw context("writing the run's instructions", e);
  }
  check();
  args.push("--append-system-prompt-file", path_str(prompt_file));
  args.push("--permission-mode", permission_mode);
  if (permission_mode !== "bypassPermissions") args.push("--permission-prompt-tool", `mcp__${MCP_SERVER_NAME}__permission_prompt`);
  if (gh_tools) args.push("--settings", gh_hook_settings(state.exe));
  // Our board tools never need approval, nor do some of the gh server's (see gh_allowed).
  args.push("--allowedTools");
  args.push(...board_tools_allowed(permission_mode, task.kind === "review"));
  const own_gh = Object.hasOwn(tools.mcp_servers, gh_mcp.SERVER_NAME);
  const gh_tool = (t: string) => `mcp__${gh_mcp.SERVER_NAME}__${t}`;
  if (!own_gh) args.push(...gh_allowed(task).map(gh_tool));
  args.push(...tools.allowed);
  const disallowed = [...tools.disallowed];
  if (task.kind === "review") {
    // Reviewers read and report; they don't change the work.
    args.push(...review.ALLOWED_TOOLS);
    disallowed.push(...review.DISALLOWED_TOOLS);
    if (!own_gh) disallowed.push(...gh_mcp.WRITES.map(gh_tool));
  }
  if (disallowed.length) args.push("--disallowedTools", disallowed.join(" "));
  if (tools.skills_dir != null) add_dirs.push(tools.skills_dir);
  if (task.session_id != null) {
    args.push("--resume", task.session_id);
    if (rewind?.resume_at != null) args.push("--resume-session-at", rewind.resume_at);
  }
  if (model != null) args.push("--model", model);
  record_effort(state, run.id, effort != null ? claude_effort(effort) : null);
  if (effort != null) args.push("--effort", claude_effort(effort));
  // Files attached to prompts (see attachments.rs).
  const att = attachments.dir(state);
  if (is_dir(att)) add_dirs.push(path_str(att));
  if (tmp != null) add_dirs.push(tmp);
  for (const d of add_dirs) args.push("--add-dir", d);
  const l: runs.Launch = {
    run_id: run.id,
    cwd,
    args,
    // Permission prompts block until the user answers in the UI. A config with a proxy sends its requests there (see
    // ClaudeConfig::api_env).
    env: [["MCP_TOOL_TIMEOUT", "86400000"], ...tmp_env, ...(config ? db.api_env(config) : [])],
    config_dir: db.task_config_dir(state.db(), task),
    prompt,
    input,
    review: task.kind === "review",
    mcp_servers: tools.mcp_servers,
    github_account: account,
    codex: null,
  };
  console.log(`task ${task_id} run ${run.id}: starting claude (${run.kind}) in ${cwd}, resume=${task.session_id != null}`);
  await started(state, run, l, check);
  rewound(state, task_id, rewind);
}

/**
 * A run started with the conversation rollback a rewind asked for (see git/checkpoints.rs): it's done with. One for
 * another session than the run's is dropped too.
 */
function rewound(state: Shared, task_id: string, rewind: checkpoints.Rewind | null) {
  try {
    state.update_task_if(task_id, [["rewind", null]], (c) => db.get_task(c, task_id)?.rewind != null);
  } catch (e) {
    console.warn(`task ${task_id}: clearing the conversation rollback: ${err_str(e)}`);
  }
  if (rewind) state.add_event(task_id, "info", `The conversation goes on from before turn ${rewind.turn}`);
}

async function started(state: Shared, run: Run, l: runs.Launch, check: () => void) {
  const task_id = run.task_id;
  // Not if it was stopped meanwhile: an agent started now would work unseen.
  check();
  await runs.start(state, l);
  // Stopped while ia-shim started: the launch's end reaps it (see runner::launch_ended).
  check();
  db.run(state.db(), "UPDATE runs SET status='running' WHERE id=?1", run.id);
  // Preparing is over; from here a stop goes to the agent. Messages sent meanwhile go to it now.
  const h = state.runs.get(task_id);
  if (h) {
    h.cancel = null;
    const t = write_steers(state, task_id);
    if (t) state.emit_task(t);
  }
  runs.follow(state, run.id, 0);
}
