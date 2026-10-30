import assert from "node:assert/strict";
import { test } from "node:test";
import { EMPTY_QUERY, filterCount, isFiltering, showsStatus, sortTasks, taskKind, taskKinds, taskMatcher, toggled } from "../src/boardQuery.ts";

let n = 0;
const task = (fields) => ({
  host_id: "h",
  id: `t${++n}`,
  project_id: "p",
  kind: "task",
  number: n,
  title: "",
  description: "",
  status: "todo",
  branch: null,
  running: false,
  cost_usd: 0,
  created_at: "2026-01-01T00:00:00Z",
  last_activity_at: "2026-01-01T00:00:00Z",
  ...fields,
});
const key = (t) => `IA-${t.number}`;
const names = { "h:p": "Huntaway", "h:q": "Site" };
const projectName = (t) => names[`${t.host_id}:${t.project_id}`];
const keep = (q, tasks) => tasks.filter(taskMatcher({ ...EMPTY_QUERY, ...q }, key, projectName)).map((t) => t.title);

test("the search matches every word, in any case, in the key, title, description, branch or project", () => {
  const tasks = [
    task({ number: 217, title: "Add sorting to the board" }),
    task({ number: 3, title: "Fix login", description: "The SORT order of sessions is wrong" }),
    task({ number: 4, title: "Rename", branch: "ia/sorting-cleanup" }),
    task({ number: 5, title: "Landing page", project_id: "q" }),
  ];
  assert.deepEqual(keep({ search: "sort" }, tasks), ["Add sorting to the board", "Fix login", "Rename"]);
  assert.deepEqual(keep({ search: "  BOARD   sort " }, tasks), ["Add sorting to the board"]);
  assert.deepEqual(keep({ search: "ia-217" }, tasks), ["Add sorting to the board"]);
  assert.deepEqual(keep({ search: "site" }, tasks), ["Landing page"]);
  assert.deepEqual(keep({ search: "nothing like it" }, tasks), []);
  assert.equal(keep({ search: "   " }, tasks).length, 4);
});

test("filters of one kind match any value, and kinds together all match", () => {
  const tasks = [
    task({ title: "code", running: true, pr_url: "https://github.com/o/r/pull/1" }),
    task({ title: "plan", task_type: "plan", starred: true }),
    task({ title: "sub", subproject: true, running: true }),
    task({ title: "planned", labels: ["artifact", "plan"] }),
    task({ title: "group", project_id: null, group_name: "G", task_type: "plan" }),
    task({ title: "scratch", project_id: null, task_type: "scratch", remind_at: "2026-02-01T00:00:00Z" }),
    task({ title: "elsewhere", project_id: "q" }),
  ];
  assert.deepEqual(keep({ kinds: ["plan", "subproject"] }, tasks), ["plan", "sub", "planned", "group"]);
  assert.deepEqual(keep({ kinds: ["artifact"] }, tasks), ["planned"]);
  assert.deepEqual(keep({ kinds: ["group"] }, tasks), ["group"]);
  assert.deepEqual(keep({ projects: [""] }, tasks), ["group", "scratch"]);
  assert.deepEqual(keep({ projects: ["h:q", ""] }, tasks), ["group", "scratch", "elsewhere"]);
  assert.deepEqual(keep({ flags: ["running"] }, tasks), ["code", "sub"]);
  assert.deepEqual(keep({ flags: ["running", "pr"] }, tasks), ["code"]);
  assert.deepEqual(keep({ flags: ["starred"] }, tasks), ["plan"]);
  assert.deepEqual(keep({ flags: ["reminder"] }, tasks), ["scratch"]);
  assert.deepEqual(keep({ kinds: ["code"], flags: ["running"] }, tasks), ["code"]);
  assert.deepEqual(keep({ kinds: ["code"] }, tasks), ["code", "planned", "elsewhere"]);
  assert.deepEqual(keep({ kinds: ["code"], search: "else" }, tasks), ["elsewhere"]);
});

test("statuses pick the columns rather than the tasks", () => {
  assert.equal(showsStatus(EMPTY_QUERY, "done"), true);
  const q = { ...EMPTY_QUERY, statuses: ["todo", "in_progress"] };
  assert.equal(showsStatus(q, "todo"), true);
  assert.equal(showsStatus(q, "done"), false);
  assert.equal(keep(q, [task({ title: "a", status: "done" })]).length, 1);
});

test("tells whether anything is filtered, and counts the filters", () => {
  assert.equal(isFiltering(EMPTY_QUERY), false);
  assert.equal(isFiltering({ ...EMPTY_QUERY, search: " " }), false);
  assert.equal(isFiltering({ ...EMPTY_QUERY, search: "x" }), true);
  assert.equal(isFiltering({ ...EMPTY_QUERY, flags: ["pr"] }), true);
  assert.equal(filterCount({ ...EMPTY_QUERY, search: "x", statuses: ["todo"], kinds: ["plan", "code"] }), 3);
  assert.deepEqual(toggled(["a", "b"], "a"), ["b"]);
  assert.deepEqual(toggled(["b"], "a"), ["b", "a"]);
});

test("knows each kind of task", () => {
  assert.equal(taskKind(task({})), "code");
  assert.equal(taskKind(task({ task_type: "diagram" })), "diagram");
  assert.equal(taskKind(task({ subproject: true })), "subproject");
  assert.equal(taskKind(task({ project_id: null, group_name: "G", task_type: "plan" })), "group");
  assert.equal(taskKind(task({ project_id: null, task_type: "scratch" })), "scratch");
  // Plan, artifact and diagram are labels since API 69: a task made as one before keeps making only its document.
  assert.equal(taskKind(task({ labels: ["diagram"], work_dir: "documents/t" })), "diagram");
  assert.equal(taskKind(task({ labels: ["diagram"] })), "code");
  assert.deepEqual(taskKinds(task({ labels: ["diagram", "plan"] })), ["code", "plan", "diagram"]);
  assert.deepEqual(taskKinds(task({ subproject: true, labels: ["plan"] })), ["subproject", "plan"]);
});

test("sorts, keeping the board's order for ties and for the manual sort", () => {
  const a = task({ title: "beta 10", created_at: "2026-01-02T00:00:00Z", last_activity_at: "2026-01-05T00:00:00Z", cost_usd: 1 });
  const b = task({ title: "Alpha", created_at: "2026-01-03T00:00:00Z", last_activity_at: "2026-01-04T00:00:00Z", cost_usd: 3 });
  const c = task({ title: "beta 9", created_at: "2026-01-01T00:00:00Z", last_activity_at: "2026-01-05T00:00:00Z", cost_usd: 1 });
  const tasks = [a, b, c];
  const titles = (sort) => sortTasks(tasks, sort).map((t) => t.title);
  assert.equal(sortTasks(tasks, "manual"), tasks);
  assert.deepEqual(titles("activity"), ["beta 10", "beta 9", "Alpha"]);
  assert.deepEqual(titles("newest"), ["Alpha", "beta 10", "beta 9"]);
  assert.deepEqual(titles("oldest"), ["beta 9", "beta 10", "Alpha"]);
  assert.deepEqual(titles("title"), ["Alpha", "beta 9", "beta 10"]);
  assert.deepEqual(titles("cost"), ["Alpha", "beta 10", "beta 9"]);
  assert.deepEqual(tasks, [a, b, c]);
});
