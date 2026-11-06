#!/usr/bin/env node
// Starts a packaged desktop app as a user would (HA-185), and checks that the server it carries works from inside it:
//
//   node scripts/desktop-app-check.mjs <app executable> [--version V] [--resources DIR]
//
// <app executable>  release/linux-unpacked/huntaway-desktop, or Huntaway.app/Contents/MacOS/Huntaway (a copy marked
//                   as downloaded, with com.apple.quarantine, shows what Gatekeeper does with it; see release.yml)
// --version V       the version the app and its server must report
// --resources DIR   the app's resources (default: beside the executable, as electron-builder lays them out)
//
// The app starts with its own data dir, config dir and a free port (no 7878), release checks pointed at nothing, and
// scripts/fake-claude for agents. Then: the window loads the board from the server the app started, which is the one
// in its resources, run by the Node there; an agent runs a turn under the bundled ia-shim; the agents' MCP helper
// (`huntaway mcp`, the same Node) answers tools/list; and quitting the app stops the server. Electron runs headless on
// Linux; on macOS it opens a window (CI's macOS runners have a desktop session).
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const exe = args[0] && !args[0].startsWith("--") ? path.resolve(args[0]) : null;
if (!exe || args.includes("-h") || args.includes("--help")) {
  console.log(
    fs
      .readFileSync(fileURLToPath(import.meta.url), "utf8")
      .split("\n")
      .slice(1, 15)
      .map((l) => l.replace(/^\/\/ ?/, ""))
      .join("\n"),
  );
  process.exit(exe ? 0 : 2);
}
const mac = process.platform === "darwin";
const resources = path.resolve(opt("--resources") ?? (mac ? path.join(path.dirname(exe), "..", "Resources") : path.join(path.dirname(exe), "resources")));
const version = opt("--version");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
function check(cond, what, detail) {
  if (!cond) throw new Error(`${what}${detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  log(`  ok: ${what}`);
}
async function until(what, fn, ms = 60_000) {
  const end = Date.now() + ms;
  let last;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
      last = undefined;
    } catch (e) {
      last = e;
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
    await sleep(500);
  }
}
async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => (port === 7878 ? freePort().then(resolve, reject) : resolve(port)));
    });
    s.on("error", reject);
  });
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "huntaway-app-check-"));
for (const d of ["data", "config", "claude", "tmp"]) fs.mkdirSync(path.join(dir, d));
const data = path.join(dir, "data");
const port = await freePort();
const cdp = await freePort();
const base = `http://127.0.0.1:${port}`;
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(IA_|HUNTAWAY_|ELECTRON_|APPIMAGE|APPDIR|ARGV0|OWD)/.test(k))),
  XDG_CONFIG_HOME: path.join(dir, "config"),
  IA_DATA_DIR: data,
  IA_PORT: String(port),
  // Release checks go nowhere, rather than downloading the latest real release's server.
  IA_RELEASE_API: "http://127.0.0.1:9",
  IA_CLAUDE_BIN: path.join(root, "scripts/fake-claude"),
  IA_CODEX_BIN: "/bin/false",
  IA_FAKE_CLAUDE_LOG: path.join(dir, "fake-claude.log"),
  IA_FAKE_CLAUDE_SLEEP: "2",
  TMPDIR: path.join(dir, "tmp"),
};
delete env.DISPLAY;
delete env.WAYLAND_DISPLAY;
const flags = [`--remote-debugging-port=${cdp}`, ...(mac ? [] : ["--ozone-platform=headless", "--disable-gpu", "--no-sandbox"])];
const appLog = path.join(dir, "app.log");
const out = fs.openSync(appLog, "a");
log(`starting ${exe} (port ${port}, data ${data})`);
const proc = spawn(exe, flags, { env, stdio: ["ignore", out, out], detached: true });
fs.closeSync(out);
const exited = new Promise((r) => proc.on("exit", (code, signal) => r({ code, signal })));
let token;

async function api(method, p, body) {
  const res = await fetch(`${base}/api${p}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
const listening = () =>
  fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) }).then(
    () => true,
    () => false,
  );
const alive = () => {
  try {
    process.kill(-proc.pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The MCP helper an agent's run starts (`huntaway mcp`): initialize, then tools/list, over stdio. */
async function mcpTools() {
  const helper = spawn(path.join(resources, "huntaway"), ["mcp"], {
    env: { ...env, IA_URL: base, IA_TOKEN: token, IA_RUN_ID: "desktop-app-check" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  let err = "";
  helper.stderr.on("data", (d) => (err += d));
  const replies = new Map();
  helper.stdout.on("data", (d) => {
    buf += d;
    for (let i; (i = buf.indexOf("\n")) >= 0;) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        const m = JSON.parse(line);
        if (m.id != null) replies.set(m.id, m);
      } catch {
        // not JSON-RPC
      }
    }
  });
  const send = (m) => helper.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  try {
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "desktop-app-check", version: "1" } } });
    await until("the MCP helper's initialize reply", () => replies.get(1), 30_000);
    send({ method: "notifications/initialized" });
    send({ id: 2, method: "tools/list" });
    const list = await until("the MCP helper's tools/list reply", () => replies.get(2), 30_000);
    return list.result?.tools?.map((t) => t.name) ?? [];
  } catch (e) {
    throw new Error(`${e.message} (helper's stderr: ${err.trim() || "none"})`);
  } finally {
    helper.kill();
  }
}

let ok = false;
try {
  await until(
    "the app's window to load the board",
    async () => {
      if (proc.exitCode !== null || proc.signalCode) throw new Error(`the app exited (${proc.exitCode ?? proc.signalCode})`);
      const res = await fetch(`http://127.0.0.1:${cdp}/json/list`).catch(() => null);
      return res?.ok && (await res.json()).some((p) => p.type === "page" && p.url.startsWith(base));
    },
    120_000,
  );
  check(true, "the app's window loaded the board from the server it started");
  token = fs.readFileSync(path.join(data, "auth_token"), "utf8").trim();

  const info = await api("GET", "/info");
  if (version) check(info.version === version, `the server is ${version}`, info.version);
  const server = await api("GET", "/admin/server");
  log("  server:", JSON.stringify({ version: info.version, exe: server.release?.exe, bundled: server.release?.bundled }));
  const exeOf = server.release?.exe ?? "";
  check(fs.realpathSync(path.dirname(exeOf)) === fs.realpathSync(resources), "it's the server in the app's resources", exeOf);
  const pid = Number(
    execFileSync("lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" })
      .trim()
      .split("\n")[0],
  );
  const cmd = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
  check(
    cmd.startsWith(path.join(resources, "node", "bin", "node")) || cmd.includes(`${path.sep}node${path.sep}bin${path.sep}node `),
    "run by the Node in the app's resources",
    cmd,
  );

  log("an agent's run");
  const profile = await api("POST", "/profiles", { name: "test", claude_config_dir: path.join(dir, "claude"), default_model: "haiku" });
  const repo = path.join(dir, "repo");
  execFileSync("sh", [
    "-c",
    `git init -q -b main "${repo}" && cd "${repo}" && echo hi > README.md && git add . && git -c user.name=t -c user.email=t@e.invalid commit -qm init`,
  ]);
  const project = await api("POST", `/profiles/${profile.id}/projects`, { name: "Test", repo_path: repo });
  const task = await api("POST", `/projects/${project.id}/tasks`, { title: "A run in the desktop app" });
  await api("PATCH", `/tasks/${task.id}`, { status: "in_progress" });
  await api("POST", `/tasks/${task.id}/messages`, { text: "hello from the check" });
  // The fake claude sleeps 2 s, so the run is seen running before it ends.
  await until("the agent to run", async () => (await api("GET", `/tasks/${task.id}`)).task.running, 60_000);
  const done = await until(
    "the agent's run to finish",
    async () => {
      const r = await api("GET", `/tasks/${task.id}`);
      return !r.task.running && r;
    },
    90_000,
  );
  check(/Fake reply/.test(JSON.stringify(done.last_message)) && done.task.status !== "needs_attention", "it ran and replied", {
    status: done.task.status,
    last: done.last_message,
  });
  const runs = fs.readdirSync(path.join(data, "runs"));
  const run = runs.map((r) => path.join(data, "runs", r)).find((r) => fs.existsSync(path.join(r, "shim.pid")));
  check(run, "under ia-shim (the run has its shim.pid)", runs);
  const exit = JSON.parse(fs.readFileSync(path.join(run, "exit"), "utf8"));
  check(exit.code === 0, "which recorded the agent's exit", exit);

  const tools = await mcpTools();
  check(
    tools.some((t) => /create_task/.test(t)),
    "the agents' MCP helper (huntaway mcp) lists the board's tools",
    tools,
  );

  log("quitting");
  process.kill(-proc.pid, "SIGTERM");
  await until("the app and its server to stop", async () => !alive() && !(await listening()), 30_000);
  check(true, "quitting the app stopped its server");
  ok = true;
} catch (e) {
  console.error(`\nFAILED: ${e.message}`);
  for (const [name, file] of [
    ["app", appLog],
    ["server", path.join(data, "serve.log")],
  ]) {
    if (fs.existsSync(file)) console.error(`\n--- ${name} log (${file}), last lines:\n${fs.readFileSync(file, "utf8").split("\n").slice(-60).join("\n")}`);
  }
} finally {
  if (alive()) {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      // gone
    }
  }
  await Promise.race([exited, sleep(5000)]);
  if (ok && !args.includes("--keep")) fs.rmSync(dir, { recursive: true, force: true });
  else log(`kept ${dir}`);
}
process.exit(ok ? 0 : 1);
