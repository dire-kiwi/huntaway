// HA-186: a done task's test servers, their shims and agents are stopped, and nothing else is.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as db from "../db.ts";
import * as testing from "../testing.ts";
import { sleep } from "../util.ts";
import { find, folders_in, list, list_ps, stop, stop_task, type Proc } from "./leftovers.ts";
import { folder, remove, root, sweep } from "./task_tmp.ts";

/** A fake server: starts a child (as a TS server's `sh` wrapper starts `node`), then waits to be stopped. */
const SERVER = `const { spawn } = require("node:child_process");
const tag = process.argv[process.argv.indexOf("--name") + 1];
spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9) /* fake:" + tag + "-child */"], { stdio: "ignore" });
setInterval(() => {}, 1e9);
`;

/** A fake ia-shim: starts its agent in a process group of its own, which starts a helper in it, as Claude Code starts MCP servers. */
const SHIM = `const { spawn } = require("node:child_process");
const tag = process.argv[process.argv.length - 1];
const helper = "require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9) /* fake:" + tag + "-helper */'], { stdio: 'ignore' }); setInterval(() => {}, 1e9)";
spawn(process.execPath, ["-e", helper + " /* fake:" + tag + "-agent */"], { stdio: "ignore", detached: true });
setInterval(() => {}, 1e9);
`;

/** A fake server that, on TERM, starts another (`--late-exe`, with data dir `--late-data` and tag `--late-name`) and exits half a second later. */
const STARTS_ONE = `const { spawn } = require("node:child_process");
const arg = (n) => process.argv[process.argv.indexOf(n) + 1];
process.on("SIGTERM", () => {
  const args = [arg("--late-exe"), "serve", "--data-dir", arg("--late-data"), "--name", arg("--late-name")];
  spawn(process.execPath, args, { stdio: "ignore", detached: true }).unref();
  setTimeout(() => process.exit(0), 500);
});
setInterval(() => {}, 1e9);
`;

function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/**
 * Tags are given to fakes with this prefix (`mark`), so another copy of these tests running at the same time (another
 * task's `npm test`) neither sees this one's fakes nor has its own seen, or stopped, here (HA-235).
 */
const RUN = `${process.pid}.`;
const mark = (tag: string) => RUN + tag;

/** This run's fake processes running now, by their tags (without the prefix). */
async function fakes(): Promise<Map<string, Proc>> {
  const out = new Map<string, Proc>();
  for (const p of (await list()) ?? []) {
    // An agent's command line has its helper's tag in it too, before its own.
    const tag = [...p.cmd.matchAll(/\/\* fake:(\S+) \*\//g)].pop()?.[1] ?? /--name (\S+)|-- agent (\S+)$/.exec(p.cmd)?.slice(1).find((t) => t);
    if (tag?.startsWith(RUN) && p.cmd.includes(process.execPath)) out.set(tag.slice(RUN.length), p);
  }
  return out;
}

/** Waits (up to 10s) until the fake processes tagged `tags` are all running. */
async function running(tags: string[]): Promise<Map<string, Proc>> {
  let f = new Map<string, Proc>();
  for (let i = 0; i < 200; i++) {
    f = await fakes();
    if (tags.every((t) => f.has(t))) return f;
    await sleep(50);
  }
  assert.fail(`these didn't start: ${tags.filter((t) => !f.has(t)).join(", ")}`);
}

/** Starts fakes, runs `body` with them, then stops every fake that's left, whatever happened. */
async function with_fakes(started: string[], body: () => Promise<void>) {
  try {
    await body();
  } finally {
    // Again while any are left: stopping one may start another (see STARTS_ONE).
    for (let i = 0; i < 5; i++) {
      const left = [...(await fakes()).entries()].filter(([t]) => started.some((s) => t === s || t.startsWith(`${s}-`))).map(([, p]) => p);
      if (!left.length) break;
      await stop(left, 2000);
    }
  }
}

function start(args: string[], cwd?: string) {
  const c = spawn(process.execPath, args, { cwd, stdio: "ignore", detached: true });
  c.unref();
}

test("a_tasks_servers_shims_and_agents_are_stopped_and_nothing_else", async () => {
  const base = testing.temp_dir();
  const troot = join(base, "tmp-root");
  const mine = join(troot, "aaaaaaaaaaaa");
  const theirs = join(troot, "bbbbbbbbbbbb");
  mkdirSync(mine, { recursive: true });
  mkdirSync(theirs, { recursive: true });
  // The board names the temp folder through a link (as macOS's /var is /private/var); some processes name it either way.
  const link = join(base, "link");
  symlinkSync(troot, link);
  const wt = join(base, "worktrees", "1-task");
  const other_wt = join(base, "worktrees", "2-other");
  const board = join(base, "board");
  const elsewhere = join(base, "release");
  for (const d of [wt, other_wt, elsewhere]) write(join(d, "server-ts", "src", "main.js"), SERVER);
  write(join(wt, "server", "target", "debug", "ia-shim"), SHIM);
  write(join(elsewhere, "ia-shim"), SHIM);
  const main = (d: string) => join(d, "server-ts", "src", "main.js");
  const serve = (exe: string, data: string, tag: string) => [exe, "serve", "--host", "127.0.0.1", "--port", "0", "--data-dir", data, "--name", mark(tag)];
  const shim = (exe: string, run: string, tag: string) => [exe, run, "--", "agent", mark(tag)];

  const stopped = ["by-tmp", "by-link", "by-wt", "relative", "shim-of-dead", "shim-by-wt"];
  const kept = ["their-tmp", "their-wt", "board", "board-shim", "their-shim"];
  await with_fakes([...stopped, ...kept], async () => {
    // Its data in the temp folder, by its real path and through the link; a release build, not the worktree's.
    start(serve(main(elsewhere), join(mine, "ia-test-1"), "by-tmp"));
    start(serve(main(elsewhere), join(link, "aaaaaaaaaaaa", "ia-test-2"), "by-link"));
    // The worktree's build, with its data in a custom folder.
    start(serve(main(wt), join(base, "custom", "ia-test-3"), "by-wt"));
    // Started in the worktree, by relative paths.
    start(serve(join("server-ts", "src", "main.js"), "rel-data", "relative"), wt);
    // A run of a server already gone, in the temp folder, and one by the worktree's ia-shim elsewhere.
    start(shim(join(elsewhere, "ia-shim"), join(link, "aaaaaaaaaaaa", "ia-test-9", "runs", "r1"), "shim-of-dead"));
    start(shim(join(wt, "server", "target", "debug", "ia-shim"), join(base, "custom", "ia-test-3", "runs", "r2"), "shim-by-wt"));
    // Left alone: another task's temp folder (even on this worktree's build), another worktree's server, the board
    // itself (on this worktree's build), the board's own runs, and another task's run.
    start(serve(main(wt), join(theirs, "ia-test-4"), "their-tmp"));
    start(serve(main(other_wt), join(base, "custom", "ia-test-5"), "their-wt"));
    start(serve(main(wt), board, "board"));
    start(shim(join(wt, "server", "target", "debug", "ia-shim"), join(board, "runs", "r3"), "board-shim"));
    start(shim(join(elsewhere, "ia-shim"), join(theirs, "ia-test-4", "runs", "r4"), "their-shim"));

    const shims = ["shim-of-dead", "shim-by-wt", "board-shim", "their-shim"];
    const servers = [...stopped, ...kept].filter((t) => !shims.includes(t));
    const all = [...servers, ...servers.map((t) => `${t}-child`), ...shims, ...shims.flatMap((t) => [`${t}-agent`, `${t}-helper`])];
    await running(all);
    const ours = (tag: string) => stopped.some((s) => tag === s || tag.startsWith(`${s}-`));

    const scope = { tmp: [join(link, "aaaaaaaaaaaa")], worktrees: [wt], data_dir: board, tmp_root: link };
    // What `ps` lists (as on macOS) picks the same processes as /proc.
    const by_tag = new Map([...(await fakes())].map(([t, p]) => [p.pid, t]));
    const tags = async (procs: Proc[]) => (await find(procs, scope)).map((p) => by_tag.get(p.pid)).filter((t) => t !== undefined).sort();
    const want = all.filter(ours).sort();
    assert.deepEqual(await tags((await list())!), want);
    assert.deepEqual(await tags(await list_ps()), want);

    const gone = await stop_task(scope, "test");
    assert.ok(gone.length >= want.length);
    const left = await fakes();
    assert.deepEqual([...left.keys()].filter(ours), [], "the task's processes are stopped");
    assert.deepEqual(all.filter((t) => !ours(t) && !left.has(t)), [], "the others are left alone");
  });
});

/** A state with a function that adds tasks (in progress, with no worktree) to it. */
function board() {
  const s = testing.state();
  const c = s.db();
  const p = db.insert_profile(c, "p", [], null);
  const mk = () =>
    db.insert_task(c, {
      profile_id: p.id,
      project_id: null,
      kind: "task",
      title: "t",
      description: "",
      status: "in_progress",
      use_worktree: false,
      model: null,
      effort: null,
      claude_config_id: null,
    });
  return { s, c, mk };
}

test("a_done_tasks_test_server_is_stopped_with_its_folder_or_once_its_folder_has_gone", async () => {
  const { s, c, mk } = board();
  const [a, b, open] = [mk(), mk(), mk()];
  const exe = join(testing.temp_dir(), "rel", "server-ts", "src", "main.js");
  write(exe, SERVER);
  const data = (t: typeof a) => join(root(s), folder(t.id), "ia-test-x");
  for (const t of [a, b, open]) mkdirSync(data(t), { recursive: true });
  const tags = ["done-a", "gone-b", "open"];
  await with_fakes(tags, async () => {
    start([exe, "serve", "--data-dir", data(a), "--name", mark("done-a")]);
    start([exe, "serve", "--data-dir", data(b), "--name", mark("gone-b")]);
    start([exe, "serve", "--data-dir", data(open), "--name", mark("open")]);
    await running(tags);
    assert.deepEqual([...folders_in((await list())!, [root(s)])].sort(), [a, b, open].map((t) => folder(t.id)).sort());

    // A done task's folder goes, and its server with it.
    db.update_task(c, a.id, [["status", "done"]]);
    assert.ok(await remove(s, folder(a.id)));
    assert.ok(!(await fakes()).has("done-a"));
    assert.ok((await fakes()).has("gone-b"));

    // One whose folder went before (by hand, or by an older server) is stopped by the sweep, once its task is done.
    rmSync(join(root(s), folder(b.id)), { recursive: true });
    rmSync(join(root(s), folder(open.id)), { recursive: true });
    assert.equal(await sweep(s), 0);
    assert.ok((await fakes()).has("gone-b"), "not while its task is open");
    db.update_task(c, b.id, [["status", "done"]]);
    await sweep(s);
    const left = await fakes();
    assert.ok(!left.has("gone-b") && !left.has("gone-b-child"));
    assert.ok(left.has("open") && left.has("open-child"), "an open task's server is left alone");
    assert.ok(!existsSync(join(root(s), folder(a.id))));
  });
});

// HA-227: the folder is renamed away before its processes are looked for, so a server started in it with a relative
// `--data-dir` has its data dir (through its working directory) in the renamed folder.
test("a_server_started_in_the_folder_with_a_relative_data_dir_is_stopped_with_it", async () => {
  const { s, c, mk } = board();
  const a = mk();
  const exe = join(testing.temp_dir(), "rel", "server-ts", "src", "main.js");
  write(exe, SERVER);
  const dir = join(root(s), folder(a.id));
  mkdirSync(join(dir, "ia-test-rel"), { recursive: true });
  await with_fakes(["rel-a"], async () => {
    start([exe, "serve", "--data-dir", "ia-test-rel", "--name", mark("rel-a")], dir);
    await running(["rel-a", "rel-a-child"]);
    db.update_task(c, a.id, [["status", "done"]]);
    assert.ok(await remove(s, folder(a.id)));
    const left = await fakes();
    assert.ok(!left.has("rel-a") && !left.has("rel-a-child"));
  });
});

// HA-227: with the whole root gone, the sweep still stops what ran in its folders.
test("a_done_tasks_test_server_is_stopped_once_the_whole_root_has_gone", async () => {
  const { s, c, mk } = board();
  const a = mk();
  const exe = join(testing.temp_dir(), "root", "server-ts", "src", "main.js");
  write(exe, SERVER);
  const data = join(root(s), folder(a.id), "ia-test-x");
  mkdirSync(data, { recursive: true });
  await with_fakes(["rootless"], async () => {
    start([exe, "serve", "--data-dir", data, "--name", mark("rootless")]);
    await running(["rootless", "rootless-child"]);
    db.update_task(c, a.id, [["status", "done"]]);
    rmSync(root(s), { recursive: true });
    assert.equal(await sweep(s), 0);
    const left = await fakes();
    assert.ok(!left.has("rootless") && !left.has("rootless-child"));
  });
});

// HA-227: each gone folder's processes are listed as it's come to, not once for all of them, as stopping one folder's
// may take seconds. Here stopping A's server starts one in B's folder, which a listing from before then wouldn't have.
test("each_gone_folders_processes_are_listed_afresh", async () => {
  const { s, c, mk } = board();
  const [a, b] = [mk(), mk()];
  const base = testing.temp_dir();
  const exe = join(base, "late", "server-ts", "src", "main.js");
  const exe_a = join(base, "a", "server-ts", "src", "main.js");
  write(exe, SERVER);
  write(exe_a, STARTS_ONE);
  const data = (t: typeof a) => join(root(s), folder(t.id), "ia-test-x");
  for (const t of [a, b]) mkdirSync(data(t), { recursive: true });
  const tags = ["first-a", "first-b", "late-b"];
  await with_fakes(tags, async () => {
    // A's first, so its folder is come to first (processes are listed by pid).
    start([exe_a, "serve", "--data-dir", data(a), "--name", mark("first-a"), "--late-exe", exe, "--late-data", data(b), "--late-name", mark("late-b")]);
    await running(["first-a"]);
    start([exe, "serve", "--data-dir", data(b), "--name", mark("first-b")]);
    await running(["first-b", "first-b-child"]);
    for (const t of [a, b]) {
      db.update_task(c, t.id, [["status", "done"]]);
      rmSync(join(root(s), folder(t.id)), { recursive: true });
    }
    await sweep(s);
    const left = await fakes();
    assert.deepEqual([...left].filter(([t]) => tags.some((g) => t === g || t.startsWith(`${g}-`))).map(([t, p]) => `${t} ${p.pid} ${p.start}`), []);
  });
});
