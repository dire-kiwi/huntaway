#!/usr/bin/env node
// How long the TS server's one thread is held up by its heavy requests (HA-183): for each request, how long it took, how
// late a request for /api/health and a UI websocket's ping were answered meanwhile, and the time the server says the
// request held its thread for (GET /api/debug/event-loop, see server-ts/src/lag.ts).
//
//   scripts/test-server.sh --no-agents > $TMPDIR/ia<N>-env && scripts/copy-live-board.sh $TMPDIR/ia<N>-env
//   node scripts/event-loop-probe.mjs --env $TMPDIR/ia<N>-env [--threads N] [--only REGEX] [--json] [GET-path...]
//
//   --threads N   load the N longest threads (default 3), whole and as the UI's first page
//   --only REGEX  only the requests whose label matches
//   GET-path...   these requests (under /api) rather than the usual ones
//
// The usual ones are the board's heavy reads: the longest threads, every profile's and project's task lists, analytics,
// context and token stats, disk usage, permissions, and each project's merged-worktree check. Each runs alone, one after
// the other, while /api/health is fetched every 5 ms and a websocket on /api/ws is pinged every 5 ms.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const { WebSocket } = createRequire(join(root, "server-ts/package.json"))("ws");
const args = process.argv.slice(2);
const opt = (f, d) => {
  const i = args.indexOf(f);
  if (i < 0) return d;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const envFile = opt("--env", process.env.IA_TEST_ENV);
const nthreads = Number(opt("--threads", 3));
const only = opt("--only", null);
const asJson = args.includes("--json") ? (args.splice(args.indexOf("--json"), 1), true) : false;
if (!envFile) throw new Error("--env <test-server env file>");
const vars = Object.fromEntries([...readFileSync(envFile, "utf8").matchAll(/^export (IA_TEST_\w+)=(.*)$/gm)].map((m) => [m[1], m[2]]));
const url = vars.IA_TEST_URL, token = vars.IA_TEST_TOKEN;
if (!/^http:\/\/127\.0\.0\.1:/.test(url)) throw new Error(`${url} isn't a test server`);
const headers = { Authorization: `Bearer ${token}` };

async function get(path) {
  const res = await fetch(`${url}/api${path}`, { headers });
  const body = await res.text();
  if (!res.ok) throw new Error(`GET ${path}: ${res.status} ${body.slice(0, 200)}`);
  return { bytes: body.length, json: () => JSON.parse(body) };
}

/** Probes the server every 5 ms until stopped: the slowest answers to /api/health and to a websocket ping. */
async function probe() {
  const health = [], pings = [];
  let on = true;
  const ws = new WebSocket(`${url.replace("http", "ws")}/api/ws?token=${token}`);
  await new Promise((ok, fail) => (ws.once("open", ok), ws.once("error", fail)));
  ws.on("message", () => {});
  const loops = [
    (async () => {
      while (on) {
        const t = performance.now();
        await fetch(`${url}/api/health`).then((r) => r.text());
        health.push(performance.now() - t);
        await new Promise((r) => setTimeout(r, 5));
      }
    })(),
    (async () => {
      while (on) {
        const t = performance.now();
        await new Promise((r) => (ws.once("pong", r), ws.ping()));
        pings.push(performance.now() - t);
        await new Promise((r) => setTimeout(r, 5));
      }
    })(),
  ];
  return async () => {
    on = false;
    await Promise.all(loops);
    ws.close();
    const max = (l) => Math.round(Math.max(0, ...l));
    return { health_max: max(health), ping_max: max(pings), probes: health.length + pings.length };
  };
}

/** The server's own figures (server-ts/src/lag.ts), or null from a server without them (to compare with an older build). */
const lagged = (q = "") => get(`/debug/event-loop${q}`).then((r) => r.json(), () => null);

async function measure(label, path) {
  await lagged("?reset=1");
  await new Promise((r) => setTimeout(r, 50));
  const stop = await probe();
  await new Promise((r) => setTimeout(r, 30));
  const t = performance.now();
  let bytes = 0, error = null;
  try {
    bytes = (await get(path)).bytes;
  } catch (e) {
    error = e.message;
  }
  const took = Math.round(performance.now() - t);
  await new Promise((r) => setTimeout(r, 30));
  const p = await stop();
  const lag = await lagged();
  const route = lag?.routes.find((r) => r.max_path === path.split("?")[0]) ?? lag?.routes.find((r) => !/health|debug/.test(r.route));
  return { label, path, took_ms: took, mb: Math.round(bytes / 1e5) / 10, on_thread_ms: route?.max_ms ?? null, loop_max_ms: lag?.delay_ms.max ?? null, ...p, error };
}

async function usual() {
  const list = [];
  const profiles = (await get("/profiles")).json();
  for (const p of profiles) {
    list.push([`profile tasks (${p.name})`, `/profiles/${p.id}/tasks`]);
    // The analytics page's ranges: a week, and a year (all of it).
    for (const [span, days] of [["week", 7], ["year", 365]]) {
      const range = `from=${new Date(Date.now() - days * 864e5).toISOString()}&to=${new Date().toISOString()}`;
      list.push([`analytics, ${span} (${p.name})`, `/profiles/${p.id}/analytics?${range}`]);
      list.push([`context stats, ${span} (${p.name})`, `/profiles/${p.id}/context-stats?${range}`]);
      list.push([`token stats, ${span} (${p.name})`, `/profiles/${p.id}/token-stats?${range}`]);
    }
    list.push([`disk usage (${p.name})`, `/profiles/${p.id}/disk-usage`]);
    list.push([`group tasks (${p.name})`, `/profiles/${p.id}/group-tasks`]);
    const projects = (await get(`/profiles/${p.id}/projects`)).json();
    // The projects with the most tasks.
    const sized = await Promise.all(projects.map(async (pr) => ({ pr, n: (await get(`/projects/${pr.id}/tasks`)).json().length })));
    for (const { pr } of sized.sort((a, b) => b.n - a.n).slice(0, 2)) list.push([`project tasks (${pr.name})`, `/projects/${pr.id}/tasks`]);
  }
  list.push(["permissions", "/permissions"]);
  list.push(["project approvals", "/project-approvals"]);
  list.push(["usage", "/usage"]);
  // The longest threads, by the size of their messages (read from the test server's database).
  const db = join(vars.IA_TEST_DATA_DIR, "huntaway.db");
  const sql = `SELECT task_id FROM messages GROUP BY task_id ORDER BY sum(length(data)) DESC LIMIT ${nthreads}`;
  const longest = execFileSync("sqlite3", ["-readonly", db, sql], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map((id) => ({ id }));
  for (const t of longest) {
    list.push([`thread, whole (${t.id.slice(0, 8)})`, `/tasks/${t.id}/messages`]);
    list.push([`thread, first page (${t.id.slice(0, 8)})`, `/tasks/${t.id}/messages?limit=100`]);
    list.push([`task (${t.id.slice(0, 8)})`, `/tasks/${t.id}`]);
    list.push([`context (${t.id.slice(0, 8)})`, `/tasks/${t.id}/context`]);
    list.push([`turns (${t.id.slice(0, 8)})`, `/tasks/${t.id}/turns`]);
  }
  return list;
}

const list = args.length ? args.map((p) => [p, p]) : await usual();
const rows = [];
for (const [label, path] of list) {
  if (only && !new RegExp(only).test(label)) continue;
  const r = await measure(label, path);
  rows.push(r);
  if (!asJson) {
    const err = r.error ? `  ERROR ${r.error.slice(0, 80)}` : "";
    console.log(
      `${label.padEnd(44)} ${String(r.took_ms).padStart(6)} ms  ${String(r.mb).padStart(6)} MB  thread ${String(r.on_thread_ms).padStart(7)} ms  ` +
        `loop max ${String(r.loop_max_ms).padStart(7)} ms  health ${String(r.health_max).padStart(5)} ms  ping ${String(r.ping_max).padStart(5)} ms${err}`,
    );
  }
}
if (asJson) console.log(JSON.stringify(rows, null, 1));
