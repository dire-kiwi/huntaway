import assert from "node:assert/strict";
import { register } from "node:module";
import { test, vi } from "vite-plus/test";

// The app's modules import each other without extensions (and folders by their index.ts), as Vite allows.
const hook = `export async function resolve(spec, ctx, next) {
  if (spec.startsWith(".") && !/\\.[cm]?[jt]sx?$/.test(spec)) {
    try { return await next(spec + ".ts", ctx); } catch {}
    try { return await next(spec + "/index.ts", ctx); } catch {}
  }
  return next(spec, ctx);
}`;
register("data:text/javascript," + encodeURIComponent(hook));
const { connectEvents, handleEvent, SILENCE_MS, useStore } = await import("../src/store.ts");
const { flushDeltas, useDeltas, watchDelta } = await import("../src/deltas.ts");
const { api } = await import("../src/api/index.ts");
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

// IA-161: a host's refresh replaced all its tasks with what it loaded, so a task event that came while it loaded was undone
// (a card stayed "working"), and a task deleted meanwhile came back.
test("a host's refresh keeps the task and project changes that came while it loaded", async () => {
  const task = (id, extra = {}) => ({
    id,
    profile_id: "p",
    project_id: "proj",
    kind: "task",
    title: id,
    running: false,
    updated_at: "2026-10-28T01:00:00Z",
    ...extra,
  });
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
  assert.deepEqual(
    s.projects.map((p) => p.id),
    ["proj"],
  );

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
    profiles: [
      { id: "p", name: "p", host_id: "local" },
      { id: "p", name: "p", host_id: "remote" },
    ],
    projects: [{ id: "proj", profile_id: "p", host_id: "local" }],
    archived: [],
    tasks: { same: t },
  });
  const unwatch = watchDelta("same");
  // Each collision is logged, once.
  const warned = [];
  const warn = console.warn;
  console.warn = (...a) => warned.push(a.join(" "));
  handleEvent({ type: "task", host_id: "remote", task: { ...t, title: "remote's" } });
  handleEvent({ type: "task_deleted", host_id: "remote", id: "same" });
  handleEvent({ type: "project_deleted", host_id: "remote", id: "proj" });
  handleEvent({
    type: "thread_event",
    host_id: "remote",
    task_id: "same",
    event: { type: "delta", thread_id: "same", seq: 1, item_id: "i", kind: "text", offset: 0, text: "remote text" },
  });
  const s = useStore.getState();
  assert.equal(s.tasks.same.title, "local's");
  assert.deepEqual(
    s.projects.map((p) => p.id),
    ["proj"],
  );
  flushDeltas();
  assert.deepEqual(useDeltas.getState().deltas, {});
  unwatch();
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
  assert.deepEqual(
    s.projects.map((p) => p.name),
    ["new name"],
  );
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
  });
  const older = useStore.getState().loadProfiles();
  const newer = useStore.getState().loadProfiles();
  await new Promise((r) => setTimeout(r));
  assert.equal(lists.length, 2);
  lists[1]([
    { id: "a", name: "a" },
    { id: "b", name: "b" },
  ]);
  await newer;
  lists[0]([{ id: "a", name: "a" }]);
  await older;
  const s = useStore.getState();
  assert.deepEqual(
    s.profiles.map((p) => p.id),
    ["a", "b"],
  );
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
  assert.deepEqual(
    useStore.getState().hosts.map((h) => h.id),
    ["local", "remote"],
  );
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
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  try {
    const slow = useStore.getState().loadAll();
    const queued = useStore.getState().loadAll();
    const flush = () => new Promise((r) => setImmediate(r));
    await flush();
    assert.equal(answers.length, 1);
    vi.advanceTimersByTime(2000);
    await flush();
    assert.equal(answers.length, 2);
    answers[1]([host("local"), host("remote")]);
    await queued;
    answers[0]([host("local")]);
    await slow;
    assert.deepEqual(
      useStore.getState().hosts.map((h) => h.id),
      ["local", "remote"],
    );
  } finally {
    vi.useRealTimers();
  }
});

// HA-262: a connection that died without a close (a laptop's sleep, a network change) looked connected for ever.
test("the events socket is opened again after a minute with nothing once it has had ticks, but not one with no ticks", () => {
  const sockets = [];
  class FakeSocket {
    closed = false;
    constructor(url) {
      this.url = url;
      sockets.push(this);
    }
    close() {
      this.closed = true;
    }
  }
  const saved = { WebSocket: globalThis.WebSocket, window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, {
    WebSocket: FakeSocket,
    window: { addEventListener() {}, location: { protocol: "http:", host: "board" } },
    document: { addEventListener() {}, visibilityState: "visible" },
  });
  const { loadAll } = useStore.getState();
  let loads = 0;
  useStore.setState({ authed: true, loadAll: async () => void loads++ });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const send = (ws, ev) => ws.onmessage({ data: JSON.stringify(ev) });
  try {
    connectEvents();
    sockets[0].onopen();
    assert.equal(useStore.getState().connected, true);
    // A server from before ticks: however quiet, it stays.
    vi.advanceTimersByTime(10 * SILENCE_MS);
    assert.equal(sockets.length, 1);
    // Ticks, and events between them, keep it.
    send(sockets[0], { type: "tick" });
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(SILENCE_MS / 2);
      send(sockets[0], { type: "anything" });
    }
    vi.advanceTimersByTime(SILENCE_MS - 1);
    assert.equal(sockets.length, 1);
    assert.equal(sockets[0].closed, false);
    // Nothing for a minute: it's closed, shown as offline, and another is opened after the backoff, which loads again.
    vi.advanceTimersByTime(1);
    assert.equal(sockets[0].closed, true);
    assert.equal(useStore.getState().connected, false);
    vi.advanceTimersByTime(1000);
    assert.equal(sockets.length, 2);
    sockets[1].onopen();
    assert.equal(loads, 2);
    // The new one, with no ticks, isn't watched.
    vi.advanceTimersByTime(10 * SILENCE_MS);
    assert.equal(sockets.length, 2);
  } finally {
    vi.useRealTimers();
    Object.assign(globalThis, saved);
    useStore.setState({ loadAll });
  }
});
