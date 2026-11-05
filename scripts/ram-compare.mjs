#!/usr/bin/env node
// Compares the memory use of the Rust server (server/) and its TypeScript port (server-ts/, HA-174) on the same data:
// starts a test server of each (scripts/test-server.sh --no-agents), gives them the same board, then reads each
// process's memory (RSS, its peak, and PSS from /proc/<pid>/smaps_rollup) idle after start, after loading every task's
// thread through the API with UI websockets open, after more rounds of that, and once things settle.
//
//   node scripts/ram-compare.mjs [--live] [--rounds N] [--sockets N] [--keep]
//
//   --live      a scrubbed copy of the live board's database (scripts/copy-live-board.sh) rather than the --demo data
//   --rounds N  how many times to load every thread (default 5)
//   --sockets N UI websockets to hold open while loading (default 3)
//   --keep      leave the two servers running (prints their env files)
//
// The Rust server is the newer of server/target/{release,debug}/huntaway (RUST_BIN overrides); build release for a fair
// comparison. The TS server runs on the node on PATH (NODE_OPTIONS such as --max-old-space-size pass through), under
// server-ts/bin/huntaway, a shell that keeps the server's process id across restarts: the node under it is measured.
// That runs the .ts from this checkout; TS_BIN=<dir>/huntaway measures a release's package instead (what
// scripts/package-server.sh <dir> puts together: the server precompiled to .js, with its own node).
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f, d) => (args.includes(f) ? Number(args[args.indexOf(f) + 1]) : d);
const live = flag("--live");
const rounds = opt("--rounds", 5);
const nsockets = opt("--sockets", 3);
const keep = flag("--keep");
const tmp = process.env.TMPDIR || tmpdir();

const newer = (paths) => paths.filter((p) => { try { return statSync(p).isFile(); } catch { return false; } }).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
const rustBin = process.env.RUST_BIN || newer([join(root, "server/target/release/huntaway"), join(root, "server/target/debug/huntaway")]);
if (!rustBin) throw new Error("no Rust build: cargo build --release in server/");
const tsBin = process.env.TS_BIN || join(root, "server-ts/bin/huntaway");

function start(name, bin) {
  const env = { ...process.env, IA_TEST_BIN: bin, IA_TEST_OPEN_TOKEN: "0" };
  const out = execFileSync(join(root, "scripts/test-server.sh"), ["start", "--no-agents", ...(live ? [] : ["--demo"])], { encoding: "utf8", env });
  const file = join(tmp, `ram-compare-${name}-env`);
  writeFileSync(file, out);
  if (live) execFileSync(join(root, "scripts/copy-live-board.sh"), [file], { stdio: ["ignore", "ignore", "inherit"] });
  const vars = Object.fromEntries([...readFileSync(file, "utf8").matchAll(/^export (IA_TEST_\w+)=(.*)$/gm)].map((m) => [m[1], m[2]]));
  // copy-live-board restarts the server: its pid is in the data dir.
  const pid = Number(readFileSync(join(vars.IA_TEST_DATA_DIR, "server.pid"), "utf8").trim() || vars.IA_TEST_PID);
  return { name, bin, file, url: vars.IA_TEST_URL, token: vars.IA_TEST_TOKEN, dataDir: vars.IA_TEST_DATA_DIR, pid };
}

/** The process that serves for `pid`: itself, or the node that the TS server's bin/huntaway (a shell) runs as its child. */
function serving(pid) {
  for (;;) {
    let exe;
    try {
      exe = basename(readlinkSync(`/proc/${pid}/exe`));
    } catch {
      return pid;
    }
    const kids = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number);
    if (!/^(ba|da|k|z)?sh$/.test(exe) || kids.length !== 1) return pid;
    pid = kids[0];
  }
}

function mem(pid) {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const kb = (re, text) => Number(text.match(re)?.[1] ?? NaN);
  let pss = NaN;
  try {
    pss = kb(/^Pss:\s+(\d+) kB/m, readFileSync(`/proc/${pid}/smaps_rollup`, "utf8"));
  } catch {}
  return { rss: kb(/^VmRSS:\s+(\d+) kB/m, status), hwm: kb(/^VmHWM:\s+(\d+) kB/m, status), pss, threads: kb(/^Threads:\s+(\d+)/m, status) };
}

async function api(s, path) {
  const res = await fetch(`${s.url}/api${path}`, { headers: { Authorization: `Bearer ${s.token}` } });
  if (!res.ok) throw new Error(`${s.name} GET ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Load what the board loads: hosts, profiles, every project's tasks, and every task's thread (through the hub's proxy). */
async function loadAll(s) {
  const [host] = (await api(s, "/hosts")).filter((h) => h.local);
  const on = (p) => api(s, `/h/${encodeURIComponent(host.id)}${p}`);
  let messages = 0;
  for (const profile of await on("/profiles")) {
    await on(`/profiles/${profile.id}/tasks`);
    for (const project of await on(`/profiles/${profile.id}/projects`)) {
      const tasks = await on(`/projects/${project.id}/tasks`);
      for (let i = 0; i < tasks.length; i += 8) {
        const page = await Promise.all(tasks.slice(i, i + 8).map((t) => on(`/tasks/${t.id}/messages`).catch(() => [])));
        messages += page.reduce((n, m) => n + (Array.isArray(m) ? m.length : (m.messages?.length ?? 0)), 0);
        await Promise.all(tasks.slice(i, i + 8).map((t) => on(`/tasks/${t.id}`).catch(() => null)));
      }
    }
  }
  return messages;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const servers = [start("rust", rustBin), start("ts", tsBin)];
const rows = [];
const note = (phase) => {
  for (const s of servers) rows.push({ phase, server: s.name, ...mem(serving(s.pid)) });
};
try {
  await sleep(3000);
  note("idle after start");
  const sockets = servers.flatMap((s) =>
    Array.from({ length: nsockets }, () => new WebSocket(`${s.url.replace(/^http/, "ws")}/api/ws?token=${encodeURIComponent(s.token)}`)),
  );
  await sleep(500);
  const counts = {};
  for (const s of servers) counts[s.name] = await loadAll(s);
  note("after loading every thread once");
  for (let i = 1; i < rounds; i++) for (const s of servers) await loadAll(s);
  note(`after ${rounds} rounds`);
  for (const ws of sockets) ws.close();
  await sleep(10000);
  note("10 s later, sockets closed");
  // V8's memory reducer shrinks an idle heap some 30 s after the load stops.
  await sleep(50000);
  note("a minute later");
  console.log(`data: ${live ? "a copy of the live board" : "--demo"}; messages loaded per round: ${JSON.stringify(counts)}`);
  console.log(`rust: ${rustBin}\nts:   node ${process.version} ${tsBin}\n`);
  const mb = (k) => (Number.isNaN(k) ? "?" : `${(k / 1024).toFixed(1)} MB`);
  const w = [34, 8, 12, 12, 12, 8];
  const line = (cells) => cells.map((c, i) => String(c).padEnd(w[i])).join("");
  console.log(line(["phase", "server", "RSS", "peak RSS", "PSS", "threads"]));
  for (const r of rows) console.log(line([r.phase, r.server, mb(r.rss), mb(r.hwm), mb(r.pss), r.threads]));
  const ts = servers.find((s) => s.name === "ts");
  if (serving(ts.pid) !== ts.pid) console.log(line(["(bin/huntaway's shell, besides)", "ts", mb(mem(ts.pid).rss), "", mb(mem(ts.pid).pss), ""]));
  // Every agent run starts its own `huntaway mcp` (the board's tools) and `huntaway gh-mcp` (GitHub) helpers.
  console.log("\nper-agent helpers, idle (each agent run starts one of each):");
  for (const sub of ["mcp", "gh-mcp"]) {
    for (const s of servers) {
      const child = spawn(s.bin, [sub], { stdio: ["pipe", "ignore", "ignore"], env: { ...process.env, IA_URL: s.url, IA_TOKEN: s.token, IA_RUN_ID: "ram-compare" } });
      await sleep(1500);
      let m = { rss: NaN, pss: NaN };
      try {
        m = mem(child.pid);
      } catch {}
      child.kill();
      console.log(line([`huntaway ${sub}`, s.name, mb(m.rss), "", mb(m.pss), ""]));
    }
  }
} finally {
  if (keep) console.log(`\nkept: ${servers.map((s) => s.file).join(" ")}`);
  else for (const s of servers) execFileSync(join(root, "scripts/test-server.sh"), ["stop", s.dataDir], { stdio: "ignore" });
}
