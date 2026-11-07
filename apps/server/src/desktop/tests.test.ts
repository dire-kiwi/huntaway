// Computer use (HA-273, see desktop.ts): installing the driver, and the `desktop` MCP server's tools against a fake
// driver (scripts/fake-cua-driver), which logs what it's called with.
import { afterEach, beforeEach, test } from "vite-plus/test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as db from "../db.ts";
import * as desktop_db from "../db/desktop.ts";
import * as desktop from "../desktop.ts";
import * as api from "../api/desktop.ts";
import * as desktop_mcp from "../mcp/desktop_mcp.ts";
import { run_ok } from "../proc.ts";
import type { Shared } from "../state.ts";
import * as testing from "../testing.ts";
import * as driver from "./driver.ts";
import * as install from "./install.ts";

const FAKE = join(import.meta.dirname, "../../../../scripts/fake-cua-driver");
const ENV = ["IA_CUA_DRIVER", "FAKE_CUA_LOG", "FAKE_CUA_FAIL", "IA_DESKTOP_LOCKED"];
let saved: Record<string, string | undefined> = {};
let log = "";
const states: Shared[] = [];

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  log = join(testing.temp_dir(), "calls.jsonl");
  process.env.IA_CUA_DRIVER = FAKE;
  process.env.FAKE_CUA_LOG = log;
  process.env.IA_DESKTOP_LOCKED = "0";
  delete process.env.FAKE_CUA_FAIL;
  desktop.release_claim();
});

afterEach(() => {
  for (const s of states.splice(0)) driver.of(s).stop();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** A state with computer use on, and a caller for a new task in it. */
function setup(): { s: Shared; r: desktop_mcp.DesktopRun; task: (title?: string) => desktop_mcp.DesktopRun } {
  const s = testing.state();
  states.push(s);
  db.set_setting(s.db(), desktop.SETTING, "true");
  const p = db.insert_profile(s.db(), "p", [], null);
  const task = (title = "t"): desktop_mcp.DesktopRun => {
    const t = db.insert_task(s.db(), {
      profile_id: p.id,
      project_id: null,
      kind: "scratch",
      title,
      description: "",
      status: "in_progress",
      use_worktree: false,
      model: null,
      effort: null,
      claude_config_id: null,
    });
    return desktop_mcp.run_caller(s, db.insert_run(s.db(), t.id, "prompt").id)!;
  };
  return { s, r: task(), task };
}

const calls = (): Array<{ tool: string; args: any }> =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter((l) => l)
        .map((l) => JSON.parse(l))
    : [];
const text = (res: any): string =>
  (res?.content ?? [])
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("\n");

test("read_only_tools_pass_on_cuas_arguments_with_the_tasks_session_where_a_tool_takes_one", async () => {
  const { s, r } = setup();
  const read = await desktop_mcp.call(s, r, "read", { pid: 4242, query: "Save", bogus: 1 });
  assert.ok(text(read).includes('button "Save"'), text(read));
  const apps = await desktop_mcp.call(s, r, "apps", {});
  assert.ok(text(apps).includes("Fake Notes"));
  const screen = await desktop_mcp.call(s, r, "screen", { pid: 4242, window_id: 7 });
  assert.equal(screen.content.find((c: any) => c.type === "image")?.mimeType, "image/png");
  const [state, list, look] = calls();
  // Not `bogus`; a tree without the image unless asked; the session, which list_apps doesn't take, isn't given it.
  assert.deepEqual(state, { tool: "get_window_state", args: { include_screenshot: false, pid: 4242, query: "Save", session: `huntaway-${r.key}` } });
  assert.deepEqual(list, { tool: "list_apps", args: {} });
  assert.deepEqual(look.args, { pid: 4242, window_id: 7, include_screenshot: true, include_accessibility_tree: false, session: `huntaway-${r.key}` });
  // The viewer shows the window it last looked at.
  assert.deepEqual([desktop.target(r.task_id)?.pid, desktop.target(r.task_id)?.window_id], [4242, 7]);
});

test("agents_get_a_results_text_with_its_structured_fields_as_json_not_as_structured_content", async () => {
  // Claude Code gives the model a result's structuredContent in place of its text when it has some, which hid the
  // tree's rows (found running a haiku agent against the fake driver).
  const tree = 'snapshot s1\n[0] window "untitled"\n  [2] button "Save" with a long enough label';
  const r = desktop_mcp.for_agent({ content: [{ type: "text", text: tree }], structuredContent: { snapshot_id: "s1", tree_markdown: tree } });
  assert.deepEqual(r, {
    content: [
      { type: "text", text: tree },
      { type: "text", text: '{"snapshot_id":"s1"}' },
    ],
  });
  const { s, r: caller } = setup();
  const read = await desktop_mcp.call(s, caller, "read", { pid: 4242 });
  assert.equal(read.structuredContent, undefined);
  assert.ok(text(read).includes('button "Save"') && text(read).includes('"snapshot_id":"s00000001"'), text(read));
});

test("an_action_is_journaled_and_one_with_an_op_id_runs_once", async () => {
  const { s, r } = setup();
  const steps = [
    { tool: "type_text", args: { element_token: "s00000001:1", text: "hi" } },
    { tool: "press_key", args: { key: "return" } },
  ];
  const first = await desktop_mcp.call(s, r, "act", { pid: 4242, steps, op_id: "a1" });
  assert.ok(text(first).includes("ran 2 steps"), text(first));
  const again = await desktop_mcp.call(s, r, "act", { pid: 4242, steps, op_id: "a1" });
  assert.ok(text(again).startsWith("op a1 already ran (ok)"), text(again));
  // Run once, and by default it reads what changed after.
  const runs = calls().filter((c) => c.tool === "run_steps");
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].args, { observe: {}, pid: 4242, steps, session: `huntaway-${r.key}` });
  const [op] = desktop_db.task_ops(s.db(), r.task_id);
  assert.deepEqual([op.tool, op.op_id, op.status, op.summary], ["act", "a1", "ok", 'type "hi", press return']);
  assert.ok(text(await desktop_mcp.call(s, r, "op_status", { op_id: "a1" })).includes(": ok"));
  assert.ok(text(await desktop_mcp.call(s, r, "op_status", { op_id: "nope" })).includes("didn't run"));
  // A failed one is journaled as failed, and comes back as the driver's error.
  process.env.FAKE_CUA_FAIL = "launch_app";
  driver.of(s).stop();
  const failed = await desktop_mcp.call(s, r, "launch", { name: "notes", op_id: "l1" });
  assert.equal(failed.isError, true);
  assert.equal(desktop_db.find_op(s.db(), r.task_id, "l1")?.status, "failed");
});

test("turned_off_its_tools_refuse_and_nothing_starts_the_driver_again", async () => {
  // HA-273's review: turning computer use off stops the driver, and a run that was going kept acting by starting it.
  const { s, r } = setup();
  const step = { pid: 1, steps: [{ tool: "click", args: { x: 1, y: 1 } }] };
  assert.equal((await desktop_mcp.call(s, r, "act", step)).isError, undefined);
  db.set_setting(s.db(), desktop.SETTING, null);
  driver.of(s).stop();
  const before = calls().length;
  for (const [tool, args] of [
    ["act", step],
    ["launch", { name: "x" }],
    ["clipboard", {}],
    ["windows", {}],
  ] as const) {
    const res = await desktop_mcp.call(s, r, tool, args);
    assert.equal(res.isError, true);
    assert.ok(text(res).includes("turned off"), text(res));
  }
  const health = JSON.parse(text(await desktop_mcp.call(s, r, "health", {})));
  assert.ok(health.driver.error.includes("turned off"));
  assert.equal(calls().length, before);
  assert.equal(driver.of(s).status.state, "stopped");
});

test("the_clipboard_reads_its_text", async () => {
  // HA-273's review: Cua's clipboard_read gives the text only when asked for it (include_text).
  const { s, r } = setup();
  await desktop_mcp.call(s, r, "clipboard", { text: "copied words" });
  const read = await desktop_mcp.call(s, r, "clipboard", {});
  assert.ok(text(read).includes("copied words"), text(read));
  assert.deepEqual(calls().find((c) => c.tool === "clipboard_read")?.args, { include_text: true, session: `huntaway-${r.key}` });
});

test("an_op_left_running_by_an_earlier_server_is_interrupted_and_not_run_again", async () => {
  const { s, r } = setup();
  const op = desktop_db.start_op(s.db(), { task_id: r.task_id, run_id: r.run_id, op_id: "c1", tool: "clipboard", summary: "copy", args: {} });
  db.run(s.db(), "UPDATE desktop_ops SET boot='ts-old' WHERE id=?1", op.id);
  const res = await desktop_mcp.call(s, r, "clipboard", { text: "x", op_id: "c1" });
  assert.ok(text(res).includes("already ran (interrupted: whether it took effect isn't known"), text(res));
  assert.equal(calls().length, 0);
});

test("a_locked_screen_stops_everything_but_health", async () => {
  const { s, r } = setup();
  process.env.IA_DESKTOP_LOCKED = "1";
  for (const [tool, args] of [
    ["windows", {}],
    ["act", { pid: 1, steps: [{ tool: "click", args: { x: 1, y: 1 } }] }],
  ] as const) {
    const res = await desktop_mcp.call(s, r, tool, args);
    assert.equal(res.isError, true);
    assert.ok(text(res).includes("is locked"), text(res));
  }
  const health = JSON.parse(text(await desktop_mcp.call(s, r, "health", {})));
  assert.equal(health.locked, true);
  assert.equal(health.driver.version, "0.0.0-fake");
  assert.equal(calls().filter((c) => c.tool !== "check_permissions").length, 0);
});

test("one_task_drives_the_desktop_at_a_time", async () => {
  const { s, r, task } = setup();
  const other = task("the other one");
  const step = { pid: 1, steps: [{ tool: "click", args: { x: 1, y: 1 } }] };
  assert.equal((await desktop_mcp.call(s, r, "act", step)).isError, undefined);
  const refused = await desktop_mcp.call(s, other, "act", step);
  assert.equal(refused.isError, true);
  assert.ok(text(refused).includes(`${r.key} ("t") is using this desktop`), text(refused));
  // Reads don't wait for it, and once its lease is up the other task may act.
  assert.equal((await desktop_mcp.call(s, other, "windows", {})).isError, undefined);
  assert.equal(desktop.claim(other.task_id, Date.now() + desktop.LEASE_MS), null);
  assert.equal(desktop.claim(r.task_id), desktop.current_holder());
});

test("the_viewer_gets_frames_of_the_window_the_agent_last_used_only_while_the_driver_runs", async () => {
  const { s, r } = setup();
  const req = (query: Record<string, string>) => ({ query, params: {}, device: null }) as any;
  assert.ok((await api.frame(s as any, req({ task_id: r.task_id }))).reason?.includes("isn't running"));
  await desktop_mcp.call(s, r, "read", { pid: 4242, window_id: 7 });
  const { frame } = await api.frame(s as any, req({ task_id: r.task_id }));
  assert.deepEqual([frame.mime, frame.pid, frame.window_id, frame.width], ["image/png", 4242, 7, 160]);
  assert.ok(frame.data.length > 100);
  const look = calls().at(-1)!;
  assert.deepEqual(look, {
    tool: "get_window_state",
    args: { pid: 4242, include_screenshot: true, window_id: 7, include_accessibility_tree: false, display_only: true, max_image_dimension: 1280 },
  });
  // A task that hasn't used it sees the desktop.
  const other = await api.frame(s as any, req({ task_id: "none" }));
  assert.equal(other.frame.pid, null);
  assert.equal(calls().at(-1)!.tool, "get_desktop_state");
  // Off, it shows nothing.
  db.set_setting(s.db(), desktop.SETTING, null);
  assert.equal((await api.frame(s as any, req({ task_id: r.task_id }))).frame, null);
});

/** A release archive with `files` in it, served on localhost: its release, and a stop for the server. */
async function serve_release(version: string, files: Record<string, string>, sha?: string): Promise<{ release: desktop.Release; close: () => void }> {
  const dir = testing.temp_dir();
  const src = join(dir, "src");
  mkdirSync(src);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(src, name), body, { mode: 0o755 });
  const archive = join(dir, "a.tar.gz");
  await run_ok("tar", ["-czf", archive, "-C", src, "."]);
  const bytes = readFileSync(archive);
  const server = createServer((_q, res) => res.writeHead(200, { "content-length": bytes.length }).end(bytes));
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
  const port = (server.address() as any).port;
  return {
    release: { version, url: `http://127.0.0.1:${port}/a.tar.gz`, bytes: bytes.length, sha256: sha ?? createHash("sha256").update(bytes).digest("hex") },
    close: () => server.close(),
  };
}

test("installs_a_release_once_its_size_and_checksum_match_and_replaces_older_ones", async () => {
  const s = testing.state();
  delete process.env.IA_CUA_DRIVER;
  const job = (r: desktop.Release): install.InstallJob => ({
    version: r.version,
    phase: "downloading",
    received: 0,
    total: r.bytes,
    error: null,
    started_at: "",
    finished_at: null,
  });

  const bad = await serve_release("1.0.0", { "cua-driver": "#!/bin/sh\n" }, "0".repeat(64));
  await assert.rejects(install.install(s, bad.release, job(bad.release)), /SHA-256/);
  bad.close();
  assert.equal(desktop.find(s)?.source === "installed", false);

  const none = await serve_release("1.0.0", { other: "x" });
  await assert.rejects(install.install(s, none.release, job(none.release)), /no cua-driver/);
  none.close();

  const old = await serve_release("1.0.0", { "cua-driver": "#!/bin/sh\necho old\n" });
  await install.install(s, old.release, job(old.release));
  old.close();
  assert.deepEqual(desktop.find(s), { path: join(desktop.install_root(s), "1.0.0", "cua-driver"), source: "installed", version: "1.0.0" });

  const good = await serve_release("1.1.0", { "cua-driver": "#!/bin/sh\necho new\n" });
  const j = job(good.release);
  await install.install(s, good.release, j);
  good.close();
  assert.equal(j.received, good.release.bytes);
  assert.deepEqual(desktop.installed_versions(s), ["1.1.0"]);
  assert.equal(desktop.find(s)?.version, "1.1.0");
  await install.uninstall(s);
  assert.equal(desktop.installed_versions(s).length, 0);
});

test("a_database_from_before_computer_use_gets_the_journal", () => {
  const path = join(testing.temp_dir(), "db.sqlite");
  let c = db.open(path);
  c.exec("DROP TABLE desktop_ops; PRAGMA user_version=106;");
  c.close();
  c = db.open(path);
  assert.equal(Number(db.value(c, "PRAGMA user_version")), db.VERSION);
  assert.equal(db.value(c, "SELECT count(*) FROM desktop_ops"), 0);
  c.close();
});
