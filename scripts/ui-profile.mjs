#!/usr/bin/env node
// How much main-thread time the board UI spends loading and handling live events, against a test server.
//
//   node scripts/ui-profile.mjs --env <file|data dir> --task <task id> [--changes] [--cpu] [--chromium <path>]
//
// It opens the task's project board, opens the task (give it a long thread), then feeds the page websocket
// events as agents would send them (through page.routeWebSocket, so nothing is written on the server):
// streamed tokens (and a long markdown reply), task changes and new messages, with the task open and closed, and opening
// other tasks in turn, and events about a task on another board. For each it prints the
// script, layout and total main-thread time (Chrome's Performance metrics) and the JS heap. With --cpu
// it also prints the functions that took the most time (build the UI with `npx vite build --minify false`
// first for readable names).
//
// With --changes it measures the task's Changes tab instead (give it a big diff: changes in its worktree, the
// first row of its files list a folder with them in, and its second row the biggest file): opening the tab on
// the folder's diffs, the next seconds (highlighting, which comes from a worker), going into the file, moving
// the cursor through its lines, scrolling it, and switching it to the split layout and back.
//
// Numbers vary from run to run and machine to machine: compare runs on the same machine, before and after.
import { open, readEnv } from "./ui-check.mjs";

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cpu") o.cpu = true;
    else if (a === "--changes") o.changes = true;
    else if (["--env", "--task", "--chromium"].includes(a)) o[a.slice(2)] = argv[++i];
    else throw new Error(`unknown argument ${a} (see the top of ${import.meta.url})`);
  }
  if (!o.env || !o.task) throw new Error("usage: node scripts/ui-profile.mjs --env <file|data dir> --task <task id> [--cpu]");
  return o;
}

const o = args(process.argv.slice(2));
const env = readEnv(o.env);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const res = await fetch(`${env.url}/api/tasks/${o.task}`, { headers: { Authorization: `Bearer ${env.token}` } });
if (!res.ok) throw new Error(`GET /api/tasks/${o.task}: ${res.status}`);
const task = (await res.json()).task;
if (!task.project_id) throw new Error("pick a task in a project");

const ui = await open({ url: env.url, token: env.token, timeout: 60000, log: () => {}, ...(o.chromium && { chromium: o.chromium }) });
const page = ui.page;
let socket = null;
await page.routeWebSocket(/\/api\/ws/, (ws) => {
  socket = ws;
  ws.connectToServer();
});
const send = (ev) => socket.send(JSON.stringify(ev));
const cdp = await page.context().newCDPSession(page);
await cdp.send("Performance.enable");
if (o.cpu) {
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
}
const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
const ms = (s) => Math.round(s * 1000);

/** The functions that took the most time in a CPU profile, counting each once per sample it's on the stack in. */
function hottest(profile, n = 25) {
  const byId = new Map(profile.nodes.map((x) => [x.id, x]));
  const parent = new Map();
  for (const x of profile.nodes) for (const c of x.children ?? []) parent.set(c, x.id);
  const total = new Map();
  profile.samples.forEach((id, i) => {
    const seen = new Set();
    for (let cur = id; cur != null; cur = parent.get(cur)) {
      const f = byId.get(cur).callFrame;
      if (["(idle)", "(root)"].includes(f.functionName)) continue;
      const key = `${f.functionName || "(anonymous)"} ${f.url.split("/").pop()}:${f.lineNumber + 1}`;
      if (seen.has(key)) continue;
      seen.add(key);
      total.set(key, (total.get(key) ?? 0) + (profile.timeDeltas[i] ?? 0));
    }
  });
  return [...total].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, us]) => `    ${String(Math.round(us / 1000)).padStart(6)} ms  ${k}`);
}

const rows = [];
async function measure(name, fn) {
  await sleep(1000);
  const before = await metrics();
  if (o.cpu) await cdp.send("Profiler.start");
  await fn();
  await sleep(1000);
  const after = await metrics();
  const d = (k) => ms(after[k] - before[k]);
  rows.push({ name, script: d("ScriptDuration"), layout: d("LayoutDuration"), style: d("RecalcStyleDuration"), total: d("TaskDuration"), heapMB: Math.round(after.JSHeapUsedSize / 2 ** 20), nodes: after.Nodes });
  console.log(`${name}: script ${d("ScriptDuration")} ms, total ${d("TaskDuration")} ms`);
  if (o.cpu) console.log((hottest((await cdp.send("Profiler.stop")).profile)).join("\n"));
}
const togglePanel = (id) =>
  page.evaluate((id) => {
    history.pushState(null, "", id ? `${location.pathname}?task=${id}` : location.pathname);
    dispatchEvent(new PopStateEvent("popstate"));
  }, id);
const deltas = async (n, word = (i) => `word${i} `, ms = 20) => {
  for (let i = 0; i < n; i++) {
    send({ type: "delta", task_id: task.id, text: word(i) });
    await sleep(ms);
  }
  send({ type: "delta_reset", task_id: task.id });
};
// A long reply with markdown in it: a paragraph break, a list item or a code span now and then.
const markdownWord = (i) => (i % 40 === 39 ? "\n\n" : i % 15 === 14 ? "\n- **item** " : i % 7 === 6 ? `\`code${i}\` ` : `word${i} `);
const taskEvents = async (n, of = task) => {
  for (let i = 0; i < n; i++) {
    send({ type: "task", task: { ...of, last_activity_at: new Date().toISOString() } });
    await sleep(50);
  }
};
// A task in a project that isn't on the board (the server doesn't have it: the event is made up here).
const elsewhere = { ...task, id: "ui-profile-elsewhere", number: 99999, project_id: "ui-profile-elsewhere", parent_id: null };

if (o.changes) {
  await measure("load the board", async () => {
    await page.goto(`${env.url}/p/${task.project_id}`);
    await page.locator(`[data-task="${task.id}"]`).first().waitFor();
  });
  await togglePanel(task.id);
  await page.getByRole("button", { name: /^thread$/i }).waitFor();
  const keys = async (key, n, ms = 30) => {
    for (let i = 0; i < n; i++) {
      await page.keyboard.press(key);
      await sleep(ms);
    }
  };
  await measure("open the Changes tab (a folder's diffs)", async () => {
    await page.getByRole("button", { name: /^changes$/i }).click();
    await page.getByText("Unstaged", { exact: true }).first().waitFor({ timeout: 30000 });
  });
  await measure("the next 3 s (highlighting)", () => sleep(3000));
  await measure("into the first file's diff", async () => {
    await keys("j", 1);
    await keys("Enter", 1);
    await page.getByText("Unstaged changes", { exact: true }).waitFor({ timeout: 30000 });
    await sleep(3000);
  });
  await measure("60 cursor moves", () => keys("j", 60));
  await measure("20 pages down", () => keys("PageDown", 20, 50));
  await measure("split, then unified", async () => {
    await keys("|", 1);
    await sleep(1500);
    await keys("|", 1);
  });
  await ui.close();
  console.log();
  console.table(Object.fromEntries(rows.map(({ name, ...r }) => [name, r])));
  process.exit(0);
}

await measure("load the board", async () => {
  await page.goto(`${env.url}/p/${task.project_id}`);
  await page.locator(`[data-task="${task.id}"]`).first().waitFor();
});
await measure("open the task", async () => {
  await togglePanel(task.id);
  await page.locator(".prose-chat, :text('No agent has worked on this yet')").first().waitFor();
});
await measure("300 streamed tokens, task open", () => deltas(300));
await measure("a 1000-token markdown reply, task open", () => deltas(1000, markdownWord, 10));
await measure("100 task events, task open", () => taskEvents(100));
await measure("50 new messages, task open", async () => {
  for (let i = 0; i < 50; i++) {
    const text = `Message ${i}: some **markdown** with \`code\`.`;
    send({ type: "message", task_id: task.id, message: { id: 2 ** 40 + i, task_id: task.id, kind: "claude", created_at: new Date().toISOString(),
      data: { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } } } });
    await sleep(50);
  }
});
await togglePanel(null);
await measure("300 streamed tokens, task closed", () => deltas(300));
await measure("100 task events, board only", () => taskEvents(100));
await measure("100 events about a task on another board", () => taskEvents(100, elsewhere));
await measure("open 20 other tasks in turn", async () => {
  const ids = (await page.$$eval("[data-task]", (els) => els.map((e) => e.dataset.task))).filter((id) => id !== task.id).slice(0, 20);
  for (const id of ids) {
    await togglePanel(id);
    await sleep(150);
  }
  await togglePanel(null);
});
await measure("10 s idle on the board", () => sleep(10000));
await ui.close();

console.log();
console.table(Object.fromEntries(rows.map(({ name, ...r }) => [name, r])));
