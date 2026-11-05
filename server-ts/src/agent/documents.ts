// Port of server/src/agent/documents.rs.
/**
 * A task's labels (see db Task.labels) each ask its agent for a document besides its other work: an HTML page (a plan
 * to iterate on, or an artifact) or a Mermaid diagram. The agent writes each to a file in the task's own folder, and the
 * board keeps each version in the database and shows it in a tab of the task (`GET /tasks/{id}/document?label=…`).
 *
 * A version follows the file while the agent's turn goes on, so the task shows the document as it's written, and is
 * closed when the turn ends: the next change starts a new version, so there's one per turn that changed it.
 *
 * Plan, artifact and diagram were types of task before API 71, whose agents worked in the task's own folder and made
 * only the document. Those tasks have their type as their label now, and keep working in their folder (see
 * documents_only).
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import * as db from "../db.ts";
import type { Project, Task } from "../db.ts";
import { ApiError, type Req } from "../http.ts";
import type { AppState, Shared } from "../state.ts";
import { err_str, expand_tilde, now, path_str } from "../util.ts";

/** A bigger file isn't kept, so a runaway agent can't fill the database. */
const MAX_SIZE = 5 << 20;

/** The file a task with this label writes its document to, in its folder. */
export function file_name(label: string): string | null {
  switch (label) {
    case "plan":
      return "plan.html";
    case "artifact":
      return "artifact.html";
    case "diagram":
      return "diagram.mmd";
    default:
      return null;
  }
}

/**
 * Labels as a new or changed task is given them: known ones (see db.LABELS), each once, in the order the task shows
 * them. Throws an Error with the message for labels that aren't (Rust's `Err(String)`).
 */
export function check_labels(v: any): string[] {
  let given: string[];
  if (v === null || v === undefined) given = [];
  else if (Array.isArray(v)) {
    given = v.map((l) => {
      if (typeof l !== "string") throw new Error("labels must be a list of strings");
      return l.trim();
    });
  } else throw new Error("labels must be a list of strings");
  const labels: string[] = db.LABELS;
  const bad = given.find((l) => !labels.includes(l));
  if (bad !== undefined) throw new Error(`unknown label ${JSON.stringify(bad)}: labels are some of ${JSON.stringify(labels).replaceAll(",", ", ")}`);
  return labels.filter((l) => given.includes(l));
}

/** The task's labels that ask for a document, in the order the task shows them. */
export function labels(task: Task): string[] {
  return (db.LABELS as string[]).filter((l) => task.kind === "task" && task.labels.includes(l));
}

/**
 * A task's own folder, which holds its documents: the working directory of a scratch task's agent (which writes
 * whatever it likes there) and of one that makes only documents.
 */
export function dir(state: Shared, task_id: string): string {
  return join(state.data_dir, "documents", task_id);
}

/**
 * Whether a task makes only its documents, rather than changing code: one made as a plan, artifact or diagram task
 * before they were labels, which works in its own folder.
 */
export function documents_only(task: Task): boolean {
  return task.kind === "task" && !db.is_scratch(task) && !db.is_assistant(task) && task.work_dir != null;
}

/**
 * Where a scratch task's agent works (and its shell and wait commands run): the task's own folder, or for a scratch task
 * that was a scratch chat, the chat's; and where one that makes only documents does (see documents_only). Null for any
 * other thread, which works where its kind and project say (see runner.work_dir).
 */
export function work_dir(state: Shared, task: Task): string | null {
  if (task.kind !== "task") return null;
  const d = task.work_dir ?? null;
  // A folder in the data dir, which can move.
  if (d !== null && !d.startsWith("~") && !isAbsolute(d)) return join(state.data_dir, d);
  if (d !== null) return expand_tilde(d);
  return db.is_scratch(task) ? dir(state, task.id) : null;
}

/** Where a task's agent writes the document for one of its labels. */
export function path(state: Shared, task: Task, label: string): string | null {
  const f = file_name(label);
  return f === null ? null : join(dir(state, task.id), f);
}

/** The documents a task's agent writes, by label. */
export function paths(state: Shared, task: Task): Array<[string, string]> {
  return labels(task).flatMap((l) => {
    const p = path(state, task, l);
    return p === null ? [] : [[l, p] as [string, string]];
  });
}

/** Remove a deleted task's folder (its versions go with the task's row). */
export function remove(state: Shared, task_id: string): void {
  for (const k of [...SEEN.keys()]) if (k.startsWith(`${task_id}\u0000`)) SEEN.delete(k);
  const d = dir(state, task_id);
  if (existsSync(d)) {
    try {
      rmSync(d, { recursive: true });
    } catch (e) {
      console.warn(`task ${task_id}: removing the task's document folder failed: ${err_str(e)}`);
    }
  }
}

/**
 * Whether a tool call only writes to files in the task's own folder, which its agent may do without asking: that's
 * where it writes its documents (and a scratch task its notes).
 */
export function writes_own_folder(state: Shared, task: Task, tool_name: string, input: any): boolean {
  const own = task.kind === "task" && (labels(task).length > 0 || db.is_scratch(task) || db.is_assistant(task) || documents_only(task));
  if (!own || !["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool_name)) return false;
  const file = typeof input?.file_path === "string" ? input.file_path : typeof input?.notebook_path === "string" ? input.notebook_path : null;
  if (file === null) return false;
  // A `..`, or a symlink in the folder, could lead back out of it.
  if (!isAbsolute(file) || file.split("/").includes("..")) return false;
  const f = resolved(file);
  if (f === null) return false;
  // The assistant's workspace is its own too (see agent/assistant.ts).
  const workspace = db.is_assistant(task) ? work_dir(state, task) : null;
  return [dir(state, task.id), workspace].some((x) => {
    const d = x === null ? null : resolved(x);
    return d !== null && (f === d || f.startsWith(d.endsWith("/") ? d : `${d}/`));
  });
}

/**
 * A path with its symlinks resolved, as far as it exists (a file about to be written doesn't). Null if it can't be: a
 * symlink that leads nowhere (writing through it would create its target, wherever that is), or anything but a missing
 * part on the way.
 */
function resolved(p: string): string | null {
  const rest: string[] = [];
  let existing = p.length > 1 ? p.replace(/\/+$/, "") : p;
  for (;;) {
    try {
      // Unlike `stat`, this finds a dangling symlink rather than taking it for missing.
      lstatSync(existing);
    } catch (e: any) {
      if (e?.code !== "ENOENT") return null;
      const name = basename(existing);
      const parent = dirname(existing);
      if (name === "" || parent === existing) return null;
      rest.push(name);
      existing = parent;
      continue;
    }
    let real: string;
    try {
      real = realpathSync(existing);
    } catch {
      return null;
    }
    return rest.reverse().reduce((acc, part) => join(acc, part), real);
  }
}

/**
 * The size and modification time each task's document file had when last looked at, by task and label
 * (`<task>\0<label>`), so following it during a turn doesn't read an unchanged file again.
 */
const SEEN = new Map<string, string>();

/** During a turn, after a tool call: keep the task's documents that the agent changed. */
export function follow(state: Shared, task_id: string): void {
  keep(state, task_id, false);
}

/** At the end of a turn (or of the run): keep the documents that changed, and close their versions. */
export function turn_ended(state: Shared, task_id: string): void {
  keep(state, task_id, true);
}

function keep(state: Shared, task_id: string, end_of_turn: boolean): void {
  try {
    try_keep(state, task_id, end_of_turn);
  } catch (e) {
    console.warn(`task ${task_id}: keeping the task's documents failed: ${err_str(e)}`);
  }
}

function try_keep(state: Shared, task_id: string, end_of_turn: boolean): void {
  const task = db.get_task(state.db(), task_id);
  if (!task) return;
  let changed = false;
  for (const [label, file] of paths(state, task)) changed = keep_one(state, task_id, label, file, end_of_turn) || changed;
  // A label taken off during the turn leaves its version as it was.
  if (end_of_turn) db.run(state.db(), "UPDATE documents SET open=0 WHERE task_id=?1 AND open=1", task_id);
  if (changed) state.update_task(task_id, [["document_at", now()]]);
}

/** Keep the document for one label if it changed: whether it did. */
function keep_one(state: Shared, task_id: string, label: string, file: string, end_of_turn: boolean): boolean {
  let size: number | null = null;
  let stamp: string | null = null;
  try {
    const m = statSync(file, { bigint: true });
    size = Number(m.size);
    stamp = `${m.size}:${m.mtimeNs}`;
  } catch {}
  const key = `${task_id}\u0000${label}`;
  const unchanged = stamp !== null && SEEN.get(key) === stamp;
  if (stamp !== null) SEEN.set(key, stamp);
  else SEEN.delete(key);
  if (unchanged && !end_of_turn) return false;
  let content: string | null = null;
  if (size !== null && size > MAX_SIZE) {
    if (end_of_turn) state.add_event(task_id, "warn", `${basename(file)} is over ${MAX_SIZE >> 20} MB, so this version isn't kept`, null);
  } else if (size !== null) {
    try {
      content = readFileSync(file).toString("utf8");
    } catch {}
  }
  if (content === null) return false;
  const ts = now();
  const c = state.db();
  const latest = db.one(c, "SELECT version, content, open FROM documents WHERE task_id=?1 AND label=?2 ORDER BY version DESC LIMIT 1", task_id, label);
  // (The end of the turn closes an open version that doesn't change, in try_keep.)
  if (latest && latest.content === content) return false;
  if (latest && latest.open) {
    // The turn's version follows the file.
    db.run(
      c,
      "UPDATE documents SET content=?4, open=?5, updated_at=?6 WHERE task_id=?1 AND label=?2 AND version=?3",
      task_id,
      label,
      latest.version,
      content,
      !end_of_turn,
      ts,
    );
    return true;
  }
  const v = latest ? latest.version + 1 : 1;
  db.run(
    c,
    "INSERT INTO documents (task_id, label, version, content, open, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?6)",
    task_id,
    label,
    v,
    content,
    !end_of_turn,
    ts,
  );
  return true;
}

/**
 * `GET /tasks/{id}/document[?label=L][&version=N]`: a version of the task's document for a label (its first label's
 * unless asked for another; the latest version unless asked for another), and the list of its versions. A version
 * that's `open` is still being written in the agent's current turn.
 */
export async function get(s: AppState, r: Req): Promise<any> {
  const id = r.params.id;
  let qversion: number | null = null;
  if (r.query.version !== undefined) {
    if (!/^[+-]?\d+$/.test(r.query.version)) throw new ApiError(400, "Failed to deserialize query string: version: invalid digit found in string");
    qversion = Number(r.query.version);
  }
  const task = db.get_task(s.db(), id);
  if (!task) throw ApiError.not_found("task");
  const all: string[] = db.LABELS;
  const asked = r.query.label?.trim() ?? "";
  let label: string;
  if (asked !== "") {
    const l = all.find((x) => x === asked);
    if (l === undefined) throw ApiError.bad(`unknown label ${JSON.stringify(asked)}`);
    label = l;
  } else {
    label = labels(task)[0] ?? all[0];
  }
  const c = s.db();
  const versions = db
    .all(c, "SELECT version, open, created_at, updated_at, length(content) AS size FROM documents WHERE task_id=?1 AND label=?2 ORDER BY version", id, label)
    .map((v) => ({ version: v.version, open: !!v.open, created_at: v.created_at, updated_at: v.updated_at, size: v.size }));
  const version: number | null = qversion ?? (versions.length ? versions[versions.length - 1].version : null);
  const content: string | null =
    version !== null ? (db.value<string>(c, "SELECT content FROM documents WHERE task_id=?1 AND label=?2 AND version=?3", id, label, version) ?? null) : null;
  if (qversion !== null && content === null) throw ApiError.not_found("version");
  const file = path(s, task, label);
  return { label, file: file !== null ? path_str(file) : null, versions, version: content !== null ? version : null, content };
}

/**
 * What a task's agent is told to write and where, for a task that makes only documents (see documents_only), after who
 * it is and where (`project`, or for a group task its group's `group_projects`). `files`: the documents it writes, by
 * label (see paths).
 */
export function system_prompt(task: Task, files: Array<[string, string]>, project: Project | null, group_projects: Project[]): string {
  let s: string;
  const g = task.group_name ?? null;
  if (project) s = ` Project: ${project.name} (repository ${project.repo_path}, which you can read).`;
  else if (g !== null && group_projects.length === 0) s = ` The task isn't in a project but is for the group "${g}", which has no projects at the moment.`;
  else if (g !== null) {
    const list = group_projects.map((p) => `${p.name} (key ${p.key}, repository ${p.repo_path})`);
    s = ` The task isn't in a project but is for the group "${g}", whose projects are: ${list.join("; ")}. You can read their repositories.`;
  } else s = "";
  s +=
    `\n\nRather than changing code, this task makes documents: you write ${files.length === 0 ? "none at the moment, as it has no labels: ask the user what to make" : what(files)}. ` +
    "Your working directory is the task's own folder, where you can write freely. " +
    `The board shows ${files.length === 1 ? "that file" : "each file"} in the task as it changes, and keeps a version from each turn. ` +
    "Don't change the repositories, commit, push or open pull requests.";
  for (const [label] of files) s += guide(label, true);
  return s;
}

/**
 * What a task's agent is told about the documents its labels ask for, besides its other work (nothing without labels):
 * `files` by label (see paths).
 */
export function labels_prompt(files: Array<[string, string]>): string {
  if (files.length === 0) return "";
  const names = files.map(([l]) => l);
  let s =
    `\n\nThis task has the label${names.length === 1 ? "" : "s"} ${names.join(", ")} on the board, so besides its other work you write ${what(files)}. ` +
    "They're in the task's own folder, outside any repository (don't commit them), where you can write freely. " +
    `The board shows ${files.length === 1 ? "the file" : "each file"} in a tab of the task as it changes, and keeps a version from each turn.`;
  if (names.includes("plan")) {
    s +=
      " The plan comes first: write it before you change anything else, and iterate on it with the user. Don't start on the work until the user " +
      "approves the plan and asks you to; then work from it, and keep it up to date as you go (tick off its steps, and note where you strayed from it and why).";
  }
  for (const [label] of files) s += guide(label, false);
  return s;
}

/**
 * `/plan [what to plan]`, a command the board handles itself rather than a skill: it gives the task the plan label (see
 * add_plan) and tells the agent how to write the plan (see plan_prompt). The rest of the message, if it's one.
 */
export function plan_command(text: string): string | null {
  const t = text.trimStart();
  if (!t.startsWith("/plan")) return null;
  const rest = t.slice(5);
  return rest === "" || /^\s/u.test(rest) ? rest.trim() : null;
}

/** Give a task the plan label, for `/plan`, and make its folder for the plan, which a run only makes as it starts. */
export function add_plan(state: Shared, task: Task): Task {
  let t = task;
  if (!labels(t).includes("plan")) {
    const ls = check_labels([...t.labels, "plan"]);
    const updated = state.update_task(t.id, [["labels", ls]]);
    if (!updated) throw new Error("task not found");
    t = updated;
  }
  mkdirSync(dir(state, t.id), { recursive: true });
  return t;
}

/**
 * What a `/plan` message says to the agent, in place of the command: how to write the plan to `file`, unless its system
 * prompt says so already (`told`), and what to plan (`rest`).
 */
export function plan_prompt(file: string, rest: string, told: boolean): string {
  let s = told
    ? `Write a plan to ${file}, as your instructions for this task's plan say, and iterate on it with me before you start on the work.`
    : labels_prompt([["plan", file]]).trimStart();
  s += rest === "" ? "\n\nWrite the plan now, for the work this task is about." : `\n\nWhat to plan: ${rest}`;
  return s;
}

/** The documents, for the agent: "a plan (HTML) to /…/plan.html and …". */
function what(files: Array<[string, string]>): string {
  const each = files.map(([label, file]) => {
    const w = label === "plan" ? "a plan (HTML)" : label === "artifact" ? "an artifact (an HTML page)" : "a Mermaid diagram";
    return `${w} to ${file}`;
  });
  if (each.length === 0) return "";
  if (each.length === 1) return each[0];
  return `${each.slice(0, -1).join("; ")} and ${each[each.length - 1]}`;
}

/**
 * How to make the document for a label. `only`: in a task that makes only documents (whose plan is broken into tasks
 * rather than carried out in the task).
 */
function guide(label: string, only: boolean): string {
  if (label === "plan") {
    const then = only
      ? "When the user approves the plan and asks you to, break it into tasks with `create_task`: they're recorded as this task's, and the board shows how many are done."
      : "When the user approves the plan, do what they ask with it: carry it out in this task, or break it into tasks with `create_task` (they're recorded as this task's, and the board shows how many are done).";
    return `\n\nThe plan is HTML that the user reads and iterates on with you. ${PLAN_FEEDBACK} ${then}\n\n${PLAN_FORMAT}`;
  }
  if (label === "artifact") return `\n\n${ARTIFACT}`;
  return `\n\n${DIAGRAM}`;
}

/** How to go about a plan. */
const PLAN_FEEDBACK = "Investigate before you write, so it's grounded in specifics: read the code and name the files, modules, interfaces and data involved. Structure it so it's easy to review: the goal and what's out of scope, how things work today, the approach (with the alternatives you weighed and why not), the steps in order, each small enough to be one task for an agent, then risks and open questions. Keep it easy to scan: clear headings, tables and lists where they help, and a diagram where a picture says it better.\n\nUntil the user approves it, each message from them is feedback on the plan: update the file in place (edit it rather than rewriting it whole) and say briefly what changed. Put the questions you need answered in the plan as <ia-question>s (below), with choices to pick from where you can suggest them, and mention them at the end of your turn. The user answers them in the plan and sends the answers when they're ready, as a message listing each question's answer by its name; then fold the answers into the plan, and take the questions they settle out (or keep one with its answer as its default, if it's still worth showing).";

/** How a plan is written, for the board to show it. */
const PLAN_FORMAT = "The board shows the plan in its own theme (dark) with a readable column, and gives you components for it. So write only the content, starting with an <h1> title: no doctype, <html>, <head>, <body> or <style>, and no colours or fonts of your own (a whole page is shown as it is, without the theme or the components). Plain HTML (h2/h3 sections, p, ul/ol, table, dl, pre/code, blockquote, details) is already styled. The components:\n- <p class=\"sub\">One line under the title: what this is and what it follows on from</p>\n- <div class=\"callout\"><strong>In short:</strong> …</div>: a highlighted note, e.g. the summary at the top. Add ok, warn, bad or info to the class for that tone (class=\"callout warn\" for a caveat)\n- <span class=\"pill ok|warn|bad|info|accent|grey\">label</span>: a small inline label, e.g. in table cells or after a card's title (\"today\", \"new\", \"for now\", \"later\")\n- <div class=\"grid2\"><div class=\"card\"><h4>Title <span class=\"pill info\">new</span></h4>…</div>…</div>: cards two to a row (grid3 for three), e.g. the alternatives or the parts of the design\n- <ol class=\"steps\"><li><strong>Step title</strong> what it does. <span class=\"meta\">Result: what works after it</span></li>…</ol>: numbered steps, the title on a line of its own; .meta is muted secondary text anywhere\n- In a table whose rows are named things (decisions, options, risks), put the name in <td class=\"n\">\n(Older plans may use retired <ia-lede>, <ia-callout>, <ia-steps>, <ia-cards>, <ia-columns> and <ia-badge> elements, which still show. Don't add more; when you edit such a plan, move the parts you touch to these.)\n- <ia-diagram><pre>flowchart LR\nA[\"Start\"] --&gt; B[\"Finish\"]</pre></ia-diagram>: a Mermaid diagram, rendered by the board in its dark theme. Always use Mermaid for plan diagrams, never hand-written SVG. Put only Mermaid source inside the <pre>, without Markdown fences, scripts or a CDN. HTML-escape & and < in the source (&amp; and &lt;); keep labels short and quote those with punctuation. Mermaid drops anything in a label that looks like an HTML tag, so write a placeholder such as <env> as #lt;env#gt;. Use the diagram type that fits (flowchart, sequenceDiagram, stateDiagram-v2, etc.).\n- <ia-question name=\"id\" type=\"radio|checkbox|select|text|textarea\" title=\"The question?\">…</ia-question>: a question the user answers in the plan. Give each a unique name. Radio (one choice), checkbox (any number, also for a checklist to tick) and select (a dropdown) take the choices as children, <option value=\"id\">Label</option> (selected on the ones to start with: your recommendation); add other (or other=\"Label\") for a free-text \"Other\" choice. Text and textarea take placeholder and value. A <p> inside explains the question. Plain <input>, <select> and <textarea> fields with a name are answered too (not those in an <ia-html>), with data-question=\"…\" on them or a wrapper for their question.\n- <ia-html><template>…</template></ia-html>: anything the components can't do. The template's contents are a page of their own, in a frame as tall as they are: any HTML, CSS and scripts work there as in a page (`document` is that page, and libraries can come from a CDN), without affecting the rest of the plan. Don't size it to the window (no vh units). The theme's CSS variables are set there, to match it: --bg, --panel, --panel-2, --raised, --line, --line-strong, --fg, --heading, --muted, --faint, --accent, --ok, --warn, --danger, --info (with --accent-bg, --ok-bg, --warn-bg, --danger-bg and --info-bg, their tinted backgrounds), --font-sans, --font-mono.";

/** How to make an artifact. */
const ARTIFACT = "The artifact is a single self-contained HTML page, the kind you'd make as an artifact on claude.ai: a document, a visual explainer, a dashboard, an interactive tool or a prototype. Before you write it, load the `artifact-design` skill if you have it and follow its design guidance (and the `dataviz` skill for charts), but don't publish with the Artifact tool or upload it anywhere: this board stores and shows the page. Without that skill, design with the same care: a clear visual hierarchy, a restrained palette, generous spacing, legible type, and a layout that works from narrow to wide. Keep CSS and JavaScript inline; if you need a library, load it from a well-known CDN (cdnjs, jsDelivr or unpkg). The page is shown in a sandboxed frame: scripts run, but it has no cookies or local storage and can't reach the board. When the user gives feedback on it, update the page in place (edit it rather than rewriting it whole) and say briefly what changed.";

/** How to make a diagram. */
const DIAGRAM = "The file holds just the diagram's Mermaid source, without Markdown fences, and the board renders it. Pick the diagram type that fits what it shows (flowchart, sequenceDiagram, classDiagram, stateDiagram-v2, erDiagram, gantt, mindmap, timeline, …), and ground it in the real thing: read the code and use the actual names of components, calls and data. Keep it legible: a title (in `---\\ntitle: …\\n---` front matter), short labels, subgraphs to group related parts, and no more than about 30 nodes; if there's more to show, say which further diagrams would help rather than cramming them in. Make sure it parses: quote labels that contain punctuation such as parentheses, brackets, colons or quotes, and write < and > in labels as #lt; and #gt; (Mermaid drops anything that looks like an HTML tag, such as <env>). When the user gives feedback on it, update the diagram in place and say briefly what changed.";
