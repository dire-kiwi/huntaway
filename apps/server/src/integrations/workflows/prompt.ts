// Port of server/src/integrations/workflows/prompt.rs (HA-173's branch, ported by HA-189).
// What a workflow's agent steps are asked, and the messages its sends make: templates filled in from the task and the
// run's earlier steps.
import type { Task, UserReplies } from "../../db.ts";
import * as review from "../../review.ts";
import type { NodeRun, Output, Run } from "../workflows.ts";

/** How much of the task agent's last message, and of an earlier step's output, goes in a prompt. */
const QUOTE_CHARS = 6000;

/** What an agent step's prompt needs to know about the task's work. */
export interface Work {
  key: string;
  branch: string;
  base: string | null;
  commit: string;
  /** The branch has no commits of its own: the agent worked somewhere else (or not at all). */
  elsewhere: boolean;
  /** Its work starts later than where it left its base branch (see worktree::work_scope). */
  own_start: boolean;
  last_message: string | null;
}

function quote(s: string): string {
  let t = s.trim();
  const cs = [...t];
  if (cs.length > QUOTE_CHARS) t = cs.slice(0, QUOTE_CHARS).join("") + " [...]";
  return t
    .split(/\r?\n/)
    .map((l) => `> ${l}`)
    .join("\n");
}

/** The issues the run's verdict steps found, each with its step's name when there are several, as a numbered list. */
export function issues(run: Run): string[] {
  const steps: Array<[string, NodeRun]> = [];
  for (const n of run.graph.nodes) {
    if (n.kind !== "agent" || n.output !== "verdict") continue;
    const r = run.nodes[n.id];
    if (r && r.port === "issues") steps.push([n.name, r]);
  }
  const several = steps.length > 1;
  return steps.flatMap(([name, r]) => (r.issues ?? []).map((i) => (several ? `(${name}) ${i}` : i)));
}

function numbered(list: string[]): string {
  return list.map((s, i) => `${i + 1}. ${s}`).join("\n\n");
}

/**
 * `text` with its `{{…}}` filled in: `task.key`, `task.title`, `task.description`, `branch`, `commit`, `workflow`,
 * `issues` (those the run found), and `<node id>.text`, `<node id>.issues` and `<node id>.verdict` for its steps.
 */
export function render(text: string, task: Task, key: string, workflow: string, run: Run | null): string {
  let out = "";
  let rest = text;
  for (;;) {
    const i = rest.indexOf("{{");
    if (i < 0) break;
    out += rest.slice(0, i);
    const after = rest.slice(i + 2);
    const j = after.indexOf("}}");
    if (j < 0) return out + rest.slice(i);
    const name = after.slice(0, j).trim();
    let value: string | null = null;
    switch (name) {
      case "task.key":
        value = key;
        break;
      case "task.title":
        value = task.title;
        break;
      case "task.description":
        value = task.description;
        break;
      case "branch":
        value = task.branch ?? "";
        break;
      case "commit":
        value = run?.head ?? "";
        break;
      case "workflow":
        value = workflow;
        break;
      case "issues":
        value = run ? numbered(issues(run)) : "";
        break;
      default: {
        const dot = name.indexOf(".");
        const r = dot >= 0 ? run?.nodes[name.slice(0, dot)] : undefined;
        if (r) {
          const field = name.slice(dot + 1);
          if (field === "text") value = r.text ?? "";
          else if (field === "issues") value = numbered(r.issues ?? []);
          else if (field === "verdict") value = r.verdict ?? "";
        }
      }
    }
    out += value ?? rest.slice(i, i + 2 + j + 2);
    rest = after.slice(j + 2);
  }
  return out + rest;
}

/** What the task's agent is sent by a send step with no message of its own: the issues the run found. */
export function fixes(workflow: string, list: string[]): string {
  const what = list.length === 1 ? "a serious issue" : "serious issues";
  return (
    `The workflow "${workflow}" found ${what} in your changes:\n\n${numbered(list)}\n\nFix them, then commit (and push, if the branch has a pull ` +
    "request), and end with a summary of what you changed. You don't have to agree: if you think an issue is mistaken, or fixing it " +
    "needs a decision or information from the user, leave that issue alone and call `request_user_input` explaining your reasoning " +
    'or question, so the task moves to "Needs attention" for the user to decide.'
  );
}

/**
 * An agent step's prompt: the task, where its work is, what the steps before it said, what the step is asked to do
 * (`instructions`, already filled in), and how it reports. With `input_only`, it's not told where the work is (nor
 * what the user said of it): it works on what the steps before it said.
 */
export function agent(
  task: Task,
  work: Work,
  workflow: string,
  step: string,
  instructions: string,
  output: Output,
  skills: string[],
  codex: boolean,
  earlier: Array<[string, string]>,
  replies: UserReplies | null,
  recheck: string[],
  input_only = false,
): string {
  const key = work.key;
  let p = `You are "${step}", a step of the workflow "${workflow}", for task ${key}: "${task.title}".\n`;
  if (input_only) {
    p +=
      "\nYou work on what the steps before you said, which is below, rather than on the task's changes: you don't need to read " +
      "them unless your instructions ask you to.\n";
    if (!earlier.length) p += "\nNo step before you wrote any output.\n";
  } else if (task.description.trim()) p += `\nThe task's description:\n\n${task.description.trim()}\n`;
  const { branch, commit } = work;
  if (input_only) {
    // Not where the work is.
  } else if (work.elsewhere) {
    p +=
      `\nThe task's branch \`${branch}\`, checked out in your working directory, has no commits of its own (it's still at commit ` +
      `${commit}), so the agent made its changes somewhere else, such as in another repository, or made none. Find them from what ` +
      "it says it did";
    if (task.pr_url) p += ` and from the task's pull request, ${task.pr_url}`;
    p += " (the gh MCP server's `pr_view` and `pr_diff` tools take a pull request's URL).\n";
    const m = work.last_message?.trim();
    if (m) p += `\nThe agent's last message:\n\n${quote(m)}\n`;
    else p += "\nThe agent didn't leave a message saying what it did.\n";
  } else if (work.own_start && work.base != null) {
    const b = work.base;
    p +=
      `\nThe work is on branch \`${branch}\` (commit ${commit}), checked out in your working directory. It started from commit ${b}, ` +
      "after where it left its base branch, so its pull request's diff (if it has one) also has commits that aren't its own: read " +
      `the branch's changes (\`git diff ${b}...HEAD\`, \`git log ${b}..HEAD\`) rather than \`pr_diff\`.\n`;
  } else {
    const fallback = work.base != null ? `the branch's changes (\`git diff ${work.base}...HEAD\`, \`git log ${work.base}..HEAD\`)` : "the branch's commits";
    p +=
      `\nThe work is on branch \`${branch}\` (commit ${commit}), checked out in your working directory. Find its pull request with the ` +
      `gh MCP server's \`pr_view\` tool (pr \`${branch}\`) and read its changes (\`pr_diff\`). If it has no pull request, read ${fallback} ` +
      "instead.\n";
  }
  if (replies && !input_only) p += review.user_said(replies.replies, replies.earlier > 0);
  for (const [name, said] of earlier) p += `\nThe step "${name}" before you said:\n\n${quote(said)}\n`;
  const ins = instructions.trim();
  if (ins) p += `\n${ins}\n`;
  if (skills.length) {
    const named = skills.map((s) => `\`${codex ? "$" : "/"}${s}\``);
    p +=
      `\nUse ${skills.length === 1 ? "this skill" : "these skills"} while you work: ${named.join(", ")}` +
      `${codex ? "" : " (invoke each with the `Skill` tool)"}. If a skill asks for something against the rest of this message (changing files, say), ` +
      "follow this message instead.\n";
  }
  if (output === "verdict") {
    p +=
      "\nDon't change anything. When you're done, call `submit_review` once. If anything must be fixed before merging (for " +
      "example, a bug you confirmed), the verdict is `needs_fixes` and each such problem goes in `serious_issues`, with where it " +
      "is, what goes wrong and how to fix it. Otherwise the verdict is `pass`. Put minor issues and suggestions in the summary, " +
      "and list each of them in `minor_issues` too. Then end your turn with a short summary.";
    if (recheck.length) {
      p += "\n\nThe last time this step ran it found these serious issues, and the agent was asked to fix them. Check that they're fixed:\n";
      for (const i of recheck) p += `\n- ${i}`;
    }
  } else {
    p += "\nDon't change anything. Your last message is this step's output, shown as it is on the task: end your turn with only " + "that, without a preamble.";
  }
  return p;
}
