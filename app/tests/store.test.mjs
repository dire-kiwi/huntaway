import assert from "node:assert/strict";
import { register } from "node:module";
import { mock, test } from "node:test";

// The app's modules import each other without extensions, as Vite allows.
const hook = `export async function resolve(spec, ctx, next) {
  if (spec.startsWith(".") && !/\\.[cm]?[jt]sx?$/.test(spec)) {
    try { return await next(spec + ".ts", ctx); } catch {}
  }
  return next(spec, ctx);
}`;
register("data:text/javascript," + encodeURIComponent(hook));
const { handleEvent, retainThread, useStore } = await import("../src/store.ts");
const { api } = await import("../src/api.ts");
// Some tests stub it out.
const { refreshHost } = useStore.getState();

const host = (id, connected = true) => ({ id, name: id, local: id === "local", connected, agents: true, api_version: 44, api_compat: 1 });
const approval = (request_id) => ({ request_id, kind: "project", status: "pending", created_at: request_id, task_id: "t" });

test("a refresh that finishes last keeps the approvals of a host that reconnected meanwhile", async () => {
  // Each host's list arrives when the test says.
  const pending = [];
  api.projectApprovals = (h) => new Promise((resolve) => pending.push({ h, resolve }));
  // The latest request for host h, or with `oldest` its first.
  const answer = (h, list, oldest = false) => {
    const i = oldest ? pending.findIndex((p) => p.h === h) : pending.findLastIndex((p) => p.h === h);
    pending.splice(i, 1)[0].resolve(list);
  };
  useStore.setState({ refreshHost: async () => {}, loadHostSettings: async () => {}, hosts: [host("local"), host("remote", false)] });

  const first = useStore.getState().refreshProfileData();
  // The remote host reconnects, and a second refresh loads its approval.
  useStore.setState({ hosts: [host("local"), host("remote")] });
  const second = useStore.getState().refreshProfileData();
  answer("remote", [approval("r1")]);
  answer("local", []);
  await second;
  // The first refresh, started without the remote host, finishes last.
  answer("local", [], true);
  await first;
  assert.deepEqual(
    useStore.getState().approvals.map((a) => `${a.host_id}:${a.request_id}`),
    ["remote:r1"],
  );
});

// IA-169 review: events kept while a thread's first page loaded were added to the page as they were, so a message
// the page had too was shown twice, and a change to one in the page went to the end.
test("a thread's first page and the events that came while it loaded make one list, in order", async () => {
  const msg = (id, text) => ({ id, task_id: "t1", kind: "claude", created_at: "", data: { type: "assistant", message: { content: [{ type: "text", text }] } } });
  let answer;
  api.messagePage = () => new Promise((resolve) => (answer = resolve));
  useStore.setState({ hosts: [{ ...host("local"), api_version: 56 }], tasks: { t1: { id: "t1", host_id: "local" } }, messages: {}, threads: {} });

  const release = retainThread("t1");
  const load = useStore.getState().loadMessages("t1");
  // Stored while the page was read: a change to one it has, and a new one it has too.
  handleEvent({ type: "message_updated", task_id: "t1", message: msg(101, "changed") });
  handleEvent({ type: "message", task_id: "t1", message: msg(102, "new") });
  answer({ messages: [msg(100, "a"), msg(101, "b"), msg(102, "new")], more: true, subagents: [] });
  await load;
  assert.deepEqual(
    useStore.getState().messages.t1.map((m) => `${m.id}:${m.data.message.content[0].text}`),
    ["100:a", "101:changed", "102:new"],
  );
  release();
});

// IA-169 review: a permission answered while the older page with it was loading stayed pending, as the page had it.
test("changes that come while an older page loads are kept over the page", async () => {
  const msg = (id, status) => ({ id, task_id: "t2", kind: "permission", created_at: "", data: { status, tool_name: "Bash", request_id: `r${id}` } });
  let answer;
  api.messagePage = () => new Promise((resolve) => (answer = resolve));
  useStore.setState({
    hosts: [{ ...host("local"), api_version: 56 }],
    tasks: { t2: { id: "t2", host_id: "local" } },
    messages: { t2: [msg(10, "allowed")] },
    threads: { t2: { more: true, subagents: [], loading: false } },
  });

  const release = retainThread("t2");
  const load = useStore.getState().loadOlderMessages("t2");
  // Answered after the host read the page.
  handleEvent({ type: "message_updated", task_id: "t2", message: msg(5, "allowed") });
  answer({ messages: [msg(4, "denied"), msg(5, "pending")], more: false, subagents: [] });
  await load;
  assert.deepEqual(
    useStore.getState().messages.t2.map((m) => `${m.id}:${m.data.status}`),
    ["4:denied", "5:allowed", "10:allowed"],
  );
  release();
});

// IA-169 review: a reload after a reconnect that came while the thread was closed (but still kept) was dropped, and
// reopening it then only asked for newer messages: a permission answered meanwhile stayed pending.
test("a reload of a closed thread that's still kept updates it", async () => {
  const msg = (id, status) => ({ id, task_id: "t3", kind: "permission", created_at: "", data: { status, tool_name: "Bash", request_id: `r${id}` } });
  const asked = [];
  let answer = { messages: [msg(1, "pending"), msg(2, "pending")], more: false, subagents: [] };
  api.messagePage = (_h, _id, q) => (asked.push(q), Promise.resolve(answer));
  useStore.setState({ hosts: [{ ...host("local"), api_version: 56 }], tasks: { t3: { id: "t3", host_id: "local" } }, messages: {}, threads: {} });
  const status = () => useStore.getState().messages.t3?.map((m) => `${m.id}:${m.data.status}`);

  let release = retainThread("t3");
  await useStore.getState().loadMessages("t3");
  release();
  // Closed, and kept for a while. A permission is answered while the host is disconnected, and the reload after it comes now.
  answer = { messages: [msg(1, "pending"), msg(2, "allowed")], more: false, subagents: [] };
  await useStore.getState().loadMessages("t3", true);
  assert.deepEqual(status(), ["1:pending", "2:allowed"]);
  // Opened again, it asks only for newer ones, and has the answer.
  release = retainThread("t3");
  answer = { messages: [], more: false, subagents: [] };
  await useStore.getState().loadMessages("t3");
  assert.deepEqual(asked.at(-1), { after: 2 });
  assert.deepEqual(status(), ["1:pending", "2:allowed"]);
  release();
});

// IA-161: a host's refresh replaced all its tasks with what it loaded, so a task event that came while it loaded was undone
// (a card stayed "working"), and a task deleted meanwhile came back.
test("a host's refresh keeps the task and project changes that came while it loaded", async () => {
  const task = (id, extra = {}) => ({ id, profile_id: "p", project_id: "proj", kind: "task", title: id, running: false, updated_at: "2026-10-28T01:00:00Z", ...extra });
  const project = (id) => ({ id, profile_id: "p", name: id });
  let answer;
  api.projects = (_h, _p, archived) => Promise.resolve(archived ? [] : [project("proj"), project("gone")]);
  api.groupTasks = () => Promise.resolve([]);
  api.projectTasks = (_h, id, kind) => (kind === "task" && id === "proj" ? new Promise((resolve) => (answer = resolve)) : Promise.resolve([]));
  useStore.setState({
    refreshHost,
    hosts: [{ ...host("local"), api_version: 56 }],
    localHostId: "local",
    profiles: [{ id: "p", name: "p", host_id: "local" }],
    projects: [],
    archived: [],
    tasks: {},
  });
  const refresh = useStore.getState().refreshHost("local");
  await new Promise((r) => setTimeout(r));
  // While the lists load: a run ends, a task is deleted, one is added, and a project is deleted.
  handleEvent({ type: "task", task: task("ran", { running: false }) });
  handleEvent({ type: "task_deleted", id: "deleted" });
  handleEvent({ type: "task", task: task("added") });
  handleEvent({ type: "project_deleted", id: "gone" });
  // Lists read before them, but one changed since its event (a newer updated_at).
  answer([task("ran", { running: true }), task("deleted"), task("kept"), task("newer", { title: "new title", updated_at: "2026-10-28T02:00:00Z" })]);
  handleEvent({ type: "task", task: task("newer", { title: "old title" }) });
  await refresh;
  const s = useStore.getState();
  assert.deepEqual(Object.keys(s.tasks).sort(), ["added", "kept", "newer", "ran"]);
  assert.equal(s.tasks.ran.running, false);
  assert.equal(s.tasks.newer.title, "new title");
  assert.deepEqual(s.projects.map((p) => p.id), ["proj"]);

  // The next refresh, with nothing changing meanwhile, takes the lists as they are.
  api.projectTasks = (_h, id, kind) => Promise.resolve(kind === "task" && id === "proj" ? [task("kept")] : []);
  await useStore.getState().refreshHost("local");
  assert.deepEqual(Object.keys(useStore.getState().tasks), ["kept"]);
});

// IA-161: events were applied by id alone, so one host's events could change or delete another host's task with the same id.
test("events change only their own host's tasks and projects", () => {
  const t = { id: "same", profile_id: "p", project_id: "proj", kind: "task", title: "local's", host_id: "local" };
  useStore.setState({
    hosts: [host("local"), host("remote")],
    localHostId: "local",
    profiles: [{ id: "p", name: "p", host_id: "local" }, { id: "p", name: "p", host_id: "remote" }],
    projects: [{ id: "proj", profile_id: "p", host_id: "local" }],
    archived: [],
    tasks: { same: t },
    messages: { same: [] },
    deltas: {},
  });
  // Each collision is logged, once.
  const warned = [];
  const warn = console.warn;
  console.warn = (...a) => warned.push(a.join(" "));
  handleEvent({ type: "task", host_id: "remote", task: { ...t, title: "remote's" } });
  handleEvent({ type: "task_deleted", host_id: "remote", id: "same" });
  handleEvent({ type: "project_deleted", host_id: "remote", id: "proj" });
  handleEvent({ type: "delta", host_id: "remote", task_id: "same", text: "remote text" });
  handleEvent({ type: "message", host_id: "remote", task_id: "same", message: { id: 1, task_id: "same", kind: "user", data: { text: "hi" } } });
  const s = useStore.getState();
  assert.equal(s.tasks.same.title, "local's");
  assert.deepEqual(s.projects.map((p) => p.id), ["proj"]);
  assert.deepEqual(s.deltas, {});
  assert.deepEqual(s.messages.same, []);
  console.warn = warn;
  assert.deepEqual(warned, ["Task same is on hosts local and remote: only local's is shown, and remote's is left out."]);
  // Its own host's do.
  handleEvent({ type: "task_deleted", id: "same" });
  assert.equal(useStore.getState().tasks.same, undefined);
});

// IA-161 review: two refreshes of a host whose answers came out of order: the older one put back what the newer one had
// changed or found deleted.
test("a refresh that ends after a newer one doesn't undo it", async () => {
  const task = (id, extra = {}) => ({ id, profile_id: "p", project_id: "proj", kind: "task", title: id, updated_at: "2026-10-28T01:00:00Z", ...extra });
  const answers = [];
  api.projects = (_h, _p, archived) => Promise.resolve(archived ? [] : [{ id: "proj", profile_id: "p", name: "proj" }]);
  api.groupTasks = () => Promise.resolve([]);
  api.projectTasks = (_h, _id, kind) => (kind === "task" ? new Promise((resolve) => answers.push(resolve)) : Promise.resolve([]));
  useStore.setState({
    refreshHost,
    hosts: [{ ...host("local"), api_version: 56 }],
    localHostId: "local",
    profiles: [{ id: "p", name: "p", host_id: "local" }],
    projects: [],
    archived: [],
    tasks: {},
  });
  const older = useStore.getState().refreshHost("local");
  const newer = useStore.getState().refreshHost("local");
  await new Promise((r) => setTimeout(r));
  assert.equal(answers.length, 2);
  answers[1]([task("renamed", { title: "new title", updated_at: "2026-10-28T02:00:00Z" })]);
  await newer;
  answers[0]([task("renamed", { title: "old title" }), task("deleted")]);
  await older;
  const s = useStore.getState();
  assert.deepEqual(Object.keys(s.tasks), ["renamed"]);
  assert.equal(s.tasks.renamed.title, "new title");
});

// IA-161 review: an older refresh that ended first marked what it loaded as changed in the newer one too, which then kept
// the tasks it found deleted and the projects' old names.
test("a refresh that ends before a newer one doesn't hold that one back", async () => {
  const task = (id) => ({ id, profile_id: "p", project_id: "proj", kind: "task", title: id, updated_at: "2026-10-28T01:00:00Z" });
  const projects = [];
  const answers = [];
  api.projects = (_h, _p, archived) => (archived ? Promise.resolve([]) : new Promise((resolve) => projects.push(resolve)));
  api.groupTasks = () => Promise.resolve([]);
  api.projectTasks = (_h, _id, kind) => (kind === "task" ? new Promise((resolve) => answers.push(resolve)) : Promise.resolve([]));
  useStore.setState({
    refreshHost,
    hosts: [{ ...host("local"), api_version: 56 }],
    localHostId: "local",
    profiles: [{ id: "p", name: "p", host_id: "local" }],
    projects: [],
    archived: [],
    tasks: {},
  });
  const older = useStore.getState().refreshHost("local");
  const newer = useStore.getState().refreshHost("local");
  await new Promise((r) => setTimeout(r));
  projects[0]([{ id: "proj", profile_id: "p", name: "old name" }]);
  projects[1]([{ id: "proj", profile_id: "p", name: "new name" }]);
  await new Promise((r) => setTimeout(r));
  assert.equal(answers.length, 2);
  answers[0]([task("a"), task("x")]);
  await older;
  assert.deepEqual(Object.keys(useStore.getState().tasks).sort(), ["a", "x"]);
  answers[1]([task("a")]);
  await newer;
  const s = useStore.getState();
  assert.deepEqual(Object.keys(s.tasks), ["a"]);
  assert.deepEqual(s.projects.map((p) => p.name), ["new name"]);
});

// HA-38: two profile loads whose answers came out of order (after a reconnect, profiles_changed and hosts_changed): the
// older list landed last without a profile created meanwhile, and its refresh (newer than the other's) dropped that
// profile's tasks.
test("a profile load that ends after a newer one doesn't undo it", async () => {
  const lists = [];
  api.profiles = () => new Promise((resolve) => lists.push(resolve));
  api.claudeConfigs = () => Promise.resolve([]);
  api.projects = (_h, p, archived) => Promise.resolve(archived ? [] : [{ id: `proj-${p}`, profile_id: p, name: p }]);
  api.groupTasks = () => Promise.resolve([]);
  api.projectTasks = (_h, id, kind) =>
    Promise.resolve(kind === "task" ? [{ id: `task-${id}`, profile_id: id.slice(5), project_id: id, kind: "task", title: id }] : []);
  useStore.setState({
    refreshHost,
    loadHostSettings: async () => {},
    loadApprovals: async () => {},
    loadUsage: async () => {},
    hosts: [{ ...host("local"), api_version: 56 }],
    localHostId: "local",
    profiles: [],
    projects: [],
    archived: [],
    tasks: {},
    messages: {},
  });
  const older = useStore.getState().loadProfiles();
  const newer = useStore.getState().loadProfiles();
  await new Promise((r) => setTimeout(r));
  assert.equal(lists.length, 2);
  lists[1]([{ id: "a", name: "a" }, { id: "b", name: "b" }]);
  await newer;
  lists[0]([{ id: "a", name: "a" }]);
  await older;
  const s = useStore.getState();
  assert.deepEqual(s.profiles.map((p) => p.id), ["a", "b"]);
  assert.deepEqual(Object.keys(s.tasks).sort(), ["task-proj-a", "task-proj-b"]);
});

// HA-38: a burst of loads (a reconnect, then hosts_changed) makes one more after the one under way, not one each.
test("loads of everything that come while one runs share one that starts after it", async () => {
  const answers = [];
  api.hosts = () => new Promise((resolve) => answers.push(resolve));
  useStore.setState({ loadProfiles: async () => {}, loadHostSettings: async () => {} });
  const first = useStore.getState().loadAll();
  const second = useStore.getState().loadAll();
  const third = useStore.getState().loadAll();
  assert.equal(second, third);
  await new Promise((r) => setTimeout(r));
  assert.equal(answers.length, 1);
  answers[0]([host("local")]);
  await first;
  await new Promise((r) => setTimeout(r));
  // The second read the hosts after the calls that came while the first ran.
  assert.equal(answers.length, 2);
  answers[1]([host("local"), host("remote")]);
  await second;
  assert.deepEqual(useStore.getState().hosts.map((h) => h.id), ["local", "remote"]);
  // With none under way, the next call loads at once.
  const next = useStore.getState().loadAll();
  await new Promise((r) => setTimeout(r));
  assert.equal(answers.length, 3);
  answers[2]([host("local")]);
  await next;
});

// HA-38: a resync from the hub itself (its events to this page lagged) reloaded tasks but not hosts or profiles.
test("a hub resync reloads everything", () => {
  let loads = 0;
  const { loadAll } = useStore.getState();
  useStore.setState({ loadAll: async () => void loads++ });
  handleEvent({ type: "resync" });
  useStore.setState({ loadAll });
  assert.equal(loads, 1);
});

// HA-38: the queued load doesn't wait long for one held up by a slow host, and the slow one's older hosts list, landing
// last, doesn't replace the newer one's.
test("a load of everything queued behind a slow one starts anyway, and the slow one's list is dropped", async () => {
  const answers = [];
  api.hosts = () => new Promise((resolve) => answers.push(resolve));
  useStore.setState({ loadProfiles: async () => {}, loadHostSettings: async () => {} });
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const slow = useStore.getState().loadAll();
    const queued = useStore.getState().loadAll();
    const flush = () => new Promise((r) => setImmediate(r));
    await flush();
    assert.equal(answers.length, 1);
    mock.timers.tick(2000);
    await flush();
    assert.equal(answers.length, 2);
    answers[1]([host("local"), host("remote")]);
    await queued;
    answers[0]([host("local")]);
    await slow;
    assert.deepEqual(useStore.getState().hosts.map((h) => h.id), ["local", "remote"]);
  } finally {
    mock.timers.reset();
  }
});
