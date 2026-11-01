#!/usr/bin/env node
// The checks of scripts/release-update-e2e.sh, which builds the packages this runs (see there):
//
//   node scripts/release-update-e2e.mjs --work DIR [--pacman] [--keep] [--only NAME[,NAME…]]
//
// A fake GitHub (GET /repos/x/y/releases, /releases/tags/<tag> and the assets, with digests and ETags) runs on
// 127.0.0.1, and the packaged app runs headless (--ozone-platform=headless) with its own data dir, config dir and a
// free port, IA_RELEASE_API pointed at the fake, and scripts/fake-claude for agents. Each check gets a fresh app.
// Everything is driven through the board's API (GET /api/admin/server, POST /api/admin/release/*), and the shell's
// package update through the page's window.huntawayDesktop, reached over the DevTools protocol.

import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const work = path.resolve(opt("--work") ?? "/tmp/huntaway-release-e2e");
const assets = path.join(work, "assets");
const only = opt("--only")?.split(",");
const keep = args.includes("--keep");
const runs = path.join(work, "runs");
const { chromium } = await import(path.join(root, "app/node_modules/playwright-core/index.mjs"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => (port === 7878 ? freePort().then(resolve, reject) : resolve(port)));
    });
  });
}

/** Poll `fn` until it returns something truthy, or fail with `what` after `ms`. */
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
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}${last ? ` (${last.message})` : ""}`);
    await sleep(250);
  }
}

function check(cond, what, detail) {
  if (!cond) throw new Error(`${what}${detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  log(`  ok: ${what}`);
}

// ---------- the fake GitHub ----------

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/**
 * Serves `releases` (set by the checks): [{tag, prerelease, draft, assets: [file names in $assets], digest: {name:
 * "wrong"}, cut: [names]}]. A "wrong" digest is another file's; a cut asset closes the connection halfway.
 */
class FakeGitHub {
  releases = [];
  requests = [];

  async start() {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise((r) => this.server.listen(0, "127.0.0.1", r));
    this.base = `http://127.0.0.1:${this.server.address().port}`;
    this.digests = new Map();
  }

  digest(name) {
    if (!this.digests.has(name)) this.digests.set(name, sha256(path.join(assets, name)));
    return this.digests.get(name);
  }

  json(r) {
    return {
      tag_name: r.tag,
      name: r.tag,
      draft: !!r.draft,
      prerelease: !!r.prerelease,
      published_at: "2026-10-01T00:00:00Z",
      body: `Notes for ${r.tag}`,
      html_url: `${this.base}/x/y/releases/tag/${r.tag}`,
      assets: (r.assets ?? []).map((name) => ({
        name,
        browser_download_url: `${this.base}/dl/${encodeURIComponent(r.tag)}/${name}`,
        size: fs.statSync(path.join(assets, name)).size,
        digest: `sha256:${r.digest?.[name] === "wrong" ? "0".repeat(64) : this.digest(name)}`,
      })),
    };
  }

  handle(req, res) {
    const url = new URL(req.url, this.base);
    this.requests.push(`${req.method} ${url.pathname}`);
    const send = (code, body, headers = {}) => {
      res.writeHead(code, { "content-type": "application/json", ...headers });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if (url.pathname === "/repos/x/y/releases") {
      const body = JSON.stringify(this.releases.map((r) => this.json(r)));
      const etag = `"${crypto.createHash("sha1").update(body).digest("hex")}"`;
      if (req.headers["if-none-match"] === etag) return send(304, undefined, { etag });
      res.writeHead(200, { "content-type": "application/json", etag });
      return res.end(body);
    }
    const tag = url.pathname.match(/^\/repos\/x\/y\/releases\/tags\/(.+)$/)?.[1];
    if (tag) {
      const r = this.releases.find((r) => r.tag === decodeURIComponent(tag) && !r.draft);
      return r ? send(200, this.json(r)) : send(404, { message: "Not Found" });
    }
    const dl = url.pathname.match(/^\/dl\/([^/]+)\/([^/]+)$/);
    const r = dl && this.releases.find((r) => r.tag === decodeURIComponent(dl[1]));
    if (r && r.assets.includes(dl[2])) {
      const file = path.join(assets, dl[2]);
      const size = fs.statSync(file).size;
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": size });
      if (r.cut?.includes(dl[2])) {
        // Half of it, then the connection drops.
        res.write(fs.readFileSync(file).subarray(0, Math.floor(size / 2)), () => res.destroy());
        return;
      }
      return fs.createReadStream(file).pipe(res);
    }
    send(404, { message: "Not Found" });
  }

  stop() {
    this.server.close();
    this.server.closeAllConnections();
  }
}

/** A release `v` with the assets that exist for it. */
function release(v, extra = {}) {
  const names = fs.readdirSync(assets).filter((f) => f.startsWith(`huntaway-${v}-`) || f.startsWith(`huntaway-server-${v}-`));
  return { tag: `v${v}`, assets: names, ...extra };
}

// ---------- the app ----------

/** The environment with nothing of this agent's or the live daemon's Huntaway settings. */
function cleanEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(IA_|HUNTAWAY_|ELECTRON_|APPIMAGE|APPDIR|ARGV0|OWD)/.test(k)));
}

/**
 * A desktop app with its own data dir, config dir and port. `launch()` starts the packaged app in `cmd` headless;
 * `quit()` stops it (and the server it started) as the window's close would.
 */
class App {
  constructor(name, gh) {
    this.dir = path.join(runs, name);
    fs.rmSync(this.dir, { recursive: true, force: true });
    for (const d of ["data", "config", "claude"]) fs.mkdirSync(path.join(this.dir, d), { recursive: true });
    this.data = path.join(this.dir, "data");
    this.gh = gh;
    this.env = {};
  }

  get base() {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Start `cmd` ([file, ...args]) as the app, and wait until its board answers. */
  async launch(cmd, { attach = false } = {}) {
    this.port ??= await freePort();
    this.cdp = await freePort();
    this.cmd = cmd;
    const env = {
      ...cleanEnv(),
      XDG_CONFIG_HOME: path.join(this.dir, "config"),
      IA_DATA_DIR: this.data,
      IA_PORT: String(this.port),
      IA_RELEASE_UPDATES: "x/y",
      IA_RELEASE_API: this.gh.base,
      IA_CLAUDE_BIN: path.join(root, "scripts/fake-claude"),
      IA_CODEX_BIN: "/bin/false",
      IA_FAKE_CLAUDE_LOG: path.join(this.dir, "fake-claude.log"),
      APPIMAGE_EXTRACT_AND_RUN: "1",
      ...this.env,
    };
    delete env.DISPLAY;
    delete env.WAYLAND_DISPLAY;
    const flags = ["--ozone-platform=headless", "--disable-gpu", "--no-sandbox", `--remote-debugging-port=${this.cdp}`];
    const out = fs.openSync(path.join(this.dir, "app.log"), "a");
    fs.writeSync(out, `\n===== ${new Date().toISOString()} ${cmd.join(" ")}\n`);
    this.proc = spawn(cmd[0], [...cmd.slice(1), ...flags], { env, stdio: ["ignore", out, out], detached: true });
    fs.closeSync(out);
    this.proc.unref();
    this.pgid = this.proc.pid;
    await until(`the app's board on ${this.base}`, () => this.boardLoaded(), 90_000);
    if (!attach) this.token = fs.readFileSync(path.join(this.data, "auth_token"), "utf8").trim();
  }

  /** Whether the window shows the board (the page has the token in its URL, or the attached server's). */
  async boardLoaded() {
    const res = await fetch(`http://127.0.0.1:${this.cdp}/json/list`).catch(() => null);
    if (!res?.ok) return false;
    const pages = await res.json();
    return pages.some((p) => p.type === "page" && p.url.startsWith(this.base));
  }

  async api(method, p, body) {
    const res = await fetch(`${this.base}/api${p}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    if (!res.ok) throw Object.assign(new Error(`${method} ${p}: ${res.status} ${text}`), { status: res.status, body: json });
    return json;
  }

  info = () => this.api("GET", "/info");
  status = () => this.api("GET", "/admin/server");
  installed = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.data, "app", "state.json"), "utf8"));
    } catch {
      return {};
    }
  };
  appDir = () => (fs.existsSync(path.join(this.data, "app")) ? fs.readdirSync(path.join(this.data, "app")).sort() : []);

  /** The page the window shows, over the DevTools protocol. */
  async page() {
    this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${this.cdp}`);
    const pages = this.browser.contexts().flatMap((c) => c.pages());
    return pages.find((p) => p.url().startsWith(this.base)) ?? pages[0];
  }

  /** The server process the app started (a child of its Electron), by the port it listens on. */
  serverPid() {
    try {
      const out = execFileSync("ss", ["-Hltnp", `sport = :${this.port}`], { encoding: "utf8" });
      return Number(out.match(/pid=(\d+)/)?.[1]) || null;
    } catch {
      return null;
    }
  }

  /**
   * Quit as closing the window does (SIGTERM to Electron, which stops the server it started), and wait until the app is
   * gone and, unless it only attached to a server (`attached`), the port is free.
   */
  async quit({ attached = false } = {}) {
    await this.browser?.close().catch(() => {});
    this.browser = null;
    const alive = () => {
      try {
        process.kill(-this.pgid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      process.kill(-this.pgid, "SIGTERM");
    } catch {
      // gone already
    }
    await until("the app to quit", async () => !alive() && (attached || !(await this.listening())), 30_000).catch(async (e) => {
      try {
        process.kill(-this.pgid, "SIGKILL");
      } catch {
        // gone
      }
      const pid = this.serverPid();
      if (pid) process.kill(pid, "SIGKILL");
      throw e;
    });
  }

  async listening() {
    return fetch(`${this.base}/api/health`, { signal: AbortSignal.timeout(1000) }).then(
      () => true,
      () => false,
    );
  }

  /** Stop whatever is left: the app, its server and its agents. */
  async cleanup() {
    await this.browser?.close().catch(() => {});
    for (const sig of ["SIGTERM", "SIGKILL"]) {
      try {
        process.kill(-this.pgid, sig);
      } catch {
        // gone
      }
      const pid = this.serverPid();
      if (pid) {
        try {
          process.kill(pid, sig);
        } catch {
          // gone
        }
      }
      if (sig === "SIGTERM") await sleep(2000);
    }
    if (!keep) fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

/** A copy of release `v`'s AppImage, run as the app. */
function appImage(app, v) {
  const file = path.join(app.dir, "Huntaway.AppImage");
  fs.copyFileSync(path.join(assets, `huntaway-${v}-linux-x86_64.AppImage`), file);
  fs.chmodSync(file, 0o755);
  return [file];
}

/** Check for releases, then wait until the background download has finished (staged or failed). */
async function checkAndWait(app, wanted) {
  const s = await app.api("POST", "/admin/release/check");
  if (s.release.error) throw new Error(`the check failed: ${s.release.error}`);
  return until(`the download of ${wanted}`, async () => {
    const r = (await app.status()).release;
    const d = r.download;
    if (r.staged === wanted && !d?.phase) return r;
    return d?.version === wanted && d.phase === "failed" ? r : null;
  });
}

/** Start a restart job (`POST path`) and wait for a server with another boot id, or the job's failure. */
async function restartJob(app, p, body) {
  const before = (await app.status()).boot_id;
  await app.api("POST", p, body);
  return until(`a restart from ${p}`, async () => {
    const s = await app.status().catch(() => null);
    if (!s) return null;
    if (s.boot_id !== before) return { status: s };
    if (s.restart?.phase === "failed") return { failed: s.restart, status: s };
    return null;
  }, 120_000);
}

const noLeftovers = (app) => app.appDir().filter((f) => f.endsWith(".partial") || f.endsWith(".tmp"));

// ---------- the checks ----------

const checks = {};

/**
 * A check stages 0.9.1 in the background without restarting; a relaunch still runs 0.9.0; Update restarts onto 0.9.1
 * with an agent run carrying on; the next launch runs 0.9.1. Then a wrong digest and a cut-off download fail and leave
 * the server running and nothing behind; 0.9.2, which won't start, is marked bad after Update and 0.9.1 runs; 0.9.3
 * goes on top, and Roll back goes to 0.9.1 and then to the app's own server.
 */
checks.updates = async (gh) => {
  const app = new App("updates", gh);
  try {
    gh.releases = [
      { tag: "release/v1", assets: [] },
      release("0.9.9", { draft: true }),
      release("0.9.1"),
      release("0.9.0"),
    ];
    app.env.IA_FAKE_CLAUDE_SLEEP = "20";
    const cmd = appImage(app, "0.9.0");
    await app.launch(cmd);
    let info = await app.info();
    check(info.version === "0.9.0", "the app starts its own 0.9.0 server", info.version);
    let st = await app.status();
    check(st.release?.repo === "x/y", "the server it started checks releases", st.release);
    check(st.release.shell?.install === "appimage" && st.release.shell.version === "0.9.0", "it knows the app is a 0.9.0 AppImage", st.release.shell);
    const boot = st.boot_id;

    log("check: 0.9.1 is staged in the background");
    let r = await checkAndWait(app, "0.9.1");
    check(r.latest?.version === "0.9.1", "the latest is 0.9.1 (not the draft, nor release/v1)", r.latest);
    check(r.staged === "0.9.1", "0.9.1 is staged", r);
    st = await app.status();
    check(st.boot_id === boot && (await app.info()).version === "0.9.0", "the server didn't restart");
    check(app.installed().staged === "0.9.1" && !app.installed().current, "state.json has 0.9.1 staged, nothing current", app.installed());
    check(fs.existsSync(path.join(app.data, "app/0.9.1/huntaway")) && !fs.existsSync(path.join(app.data, "app/0.9.1/download.tar.gz")), "app/0.9.1 is unpacked, without its tarball");
    check(!noLeftovers(app).length, "nothing half-done in app/", app.appDir());

    log("relaunch: still 0.9.0");
    await app.quit();
    await app.launch(cmd);
    info = await app.info();
    check(info.version === "0.9.0", "a relaunch runs 0.9.0, not the staged 0.9.1", info.version);
    check((await app.status()).release.staged === "0.9.1", "0.9.1 is still offered");

    log("Update with an agent running");
    const profile = await app.api("POST", "/profiles", { name: "test", claude_config_dir: path.join(app.dir, "claude"), default_model: "haiku" });
    const repo = path.join(app.dir, "repo");
    execFileSync("sh", ["-c", `git init -q -b main "${repo}" && cd "${repo}" && echo hi > README.md && git add . && git -c user.name=t -c user.email=t@e.invalid commit -qm init`]);
    const project = await app.api("POST", `/profiles/${profile.id}/projects`, { name: "Test", repo_path: repo });
    const task = await app.api("POST", `/projects/${project.id}/tasks`, { title: "Runs over an update" });
    await app.api("PATCH", `/tasks/${task.id}`, { status: "in_progress" });
    await app.api("POST", `/tasks/${task.id}/messages`, { text: "keep going" });
    await until("the agent to run", async () => (await app.api("GET", `/tasks/${task.id}`)).task.running);
    const pid = app.serverPid();
    const up = await restartJob(app, "/admin/release/update", { version: "0.9.1" });
    check(!up.failed, "Update restarted the server", up.failed);
    info = await app.info();
    check(info.version === "0.9.1", "it runs 0.9.1 now", info.version);
    check(app.serverPid() === pid, "in the same process (exec), which the app keeps", { pid, now: app.serverPid() });
    check(up.status.release.exe === path.join(app.data, "app/0.9.1/huntaway"), "from app/0.9.1", up.status.release.exe);
    check((await app.api("GET", `/tasks/${task.id}`)).task.running, "the agent is still running");
    const done = await until("the agent to finish", async () => {
      const r = await app.api("GET", `/tasks/${task.id}`);
      return !r.task.running && r;
    }, 90_000);
    check(done.task.status !== "needs_attention" && /Fake reply/.test(JSON.stringify(done.last_message)), "its run finished normally", { status: done.task.status, last: done.last_message });
    let s = app.installed();
    check(s.current === "0.9.1" && !s.trying && !s.staged, "state.json: current 0.9.1", s);

    log("relaunch: 0.9.1");
    await app.quit();
    await app.launch(cmd);
    check((await app.info()).version === "0.9.1", "the next launch runs 0.9.1");

    log("a wrong digest");
    gh.releases.unshift(release("0.9.2", { digest: { "huntaway-server-0.9.2-linux-x64.tar.gz": "wrong" } }));
    const boot2 = (await app.status()).boot_id;
    r = await checkAndWait(app, "0.9.2");
    check(r.download?.error && /sha256|digest/i.test(r.download.error), "the download fails on its digest", r.download);
    check(!r.staged, "nothing is staged", r.staged);
    check(!app.appDir().some((f) => f.startsWith("0.9.2")), "nothing of 0.9.2 is left in app/", app.appDir());
    let job = await restartJob(app, "/admin/release/update", { version: "0.9.2" });
    check(job.failed && /sha256|digest/i.test(job.failed.error ?? ""), "Update fails the same way", job.failed);
    check(job.status.boot_id === boot2 && (await app.info()).version === "0.9.1", "and 0.9.1 keeps running");
    check(!app.appDir().some((f) => f.startsWith("0.9.2")) && !app.installed().trying, "nothing is left behind", { dir: app.appDir(), state: app.installed() });

    log("a cut-off download");
    gh.releases[0] = release("0.9.2", { cut: ["huntaway-server-0.9.2-linux-x64.tar.gz"] });
    r = await checkAndWait(app, "0.9.2");
    check(r.download?.error, "the download fails", r.download);
    check(!app.appDir().some((f) => f.startsWith("0.9.2")), "nothing of 0.9.2 is left in app/", app.appDir());
    check((await app.status()).boot_id === boot2, "the server kept running");

    log("0.9.2 won't start");
    gh.releases[0] = release("0.9.2");
    r = await checkAndWait(app, "0.9.2");
    check(r.staged === "0.9.2", "0.9.2 (which passes --version) is staged", r);
    const before = (await app.status()).boot_id;
    await app.api("POST", "/admin/release/update", { version: "0.9.2" });
    st = await until("the app to fall back to a server that runs", async () => {
      const st = await app.status().catch(() => null);
      return st && st.boot_id !== before && st;
    }, 120_000);
    info = await app.info();
    check(info.version === "0.9.1", "the app falls back to 0.9.1", info.version);
    s = app.installed();
    check(s.bad?.includes("0.9.2") && !s.trying && s.current === "0.9.1", "state.json: 0.9.2 is bad, current 0.9.1", s);
    r = (await app.api("POST", "/admin/release/check")).release;
    check(r.latest?.version !== "0.9.2" && !r.staged, "0.9.2 isn't offered again", r.latest);

    log("0.9.3, then Roll back twice");
    gh.releases.unshift(release("0.9.3"));
    r = await checkAndWait(app, "0.9.3");
    check(r.staged === "0.9.3", "0.9.3 is staged", r);
    check(r.shell?.outdated === true && r.shell.package?.name === "huntaway-0.9.3-linux-x86_64.AppImage", "its shell differs, with the AppImage to install", r.shell);
    job = await restartJob(app, "/admin/release/update", { version: "0.9.3" });
    check(!job.failed && (await app.info()).version === "0.9.3", "Update runs 0.9.3", job.failed);
    s = app.installed();
    check(s.current === "0.9.3" && s.previous === "0.9.1", "state.json: current 0.9.3, previous 0.9.1", s);
    check(job.status.release.rollback_to === "0.9.1", "Roll back would go to 0.9.1", job.status.release.rollback_to);
    job = await restartJob(app, "/admin/release/rollback");
    check(!job.failed && (await app.info()).version === "0.9.1", "Roll back runs 0.9.1", job.failed);
    s = app.installed();
    check(s.current === "0.9.1" && s.bad.includes("0.9.3") && !s.previous, "state.json: current 0.9.1, 0.9.3 bad", s);
    check(job.status.release.rollback_to === "bundled", "Roll back would now go to the app's own server", job.status.release.rollback_to);
    job = await restartJob(app, "/admin/release/rollback");
    info = await app.info();
    check(!job.failed && info.version === "0.9.0", "Roll back runs the app's own 0.9.0", job.failed ?? info.version);
    check(!job.status.release.exe.startsWith(app.data), "from the app's resources", job.status.release.exe);
    s = app.installed();
    check(!s.current && s.bad.includes("0.9.1"), "state.json: nothing current, 0.9.1 bad", s);
    await app.quit();
    await app.launch(cmd);
    check((await app.info()).version === "0.9.0", "a relaunch runs the app's own server");
    r = (await app.api("POST", "/admin/release/check")).release;
    check(!r.latest?.newer && !r.staged, "and nothing that was rolled back from is offered", r);
    await app.quit();
  } finally {
    await app.cleanup();
  }
};

/** Include prereleases: off, 0.9.4-rc.1 isn't offered; on, it is; off again, it's no longer offered. */
checks.prereleases = async (gh) => {
  const app = new App("prereleases", gh);
  try {
    gh.releases = [release("0.9.4-rc.1", { prerelease: true }), release("0.9.1"), release("0.9.0")];
    await app.launch(appImage(app, "0.9.0"));
    let r = await checkAndWait(app, "0.9.1");
    check(r.latest?.version === "0.9.1" && r.prereleases === false, "with prereleases off, the latest is 0.9.1", r.latest);
    await app.api("PATCH", "/settings", { release_prereleases: true });
    r = await checkAndWait(app, "0.9.4-rc.1");
    check(r.latest?.version === "0.9.4-rc.1" && r.latest.prerelease, "with them on, it's 0.9.4-rc.1", r.latest);
    check(r.staged === "0.9.4-rc.1", "and it's staged", r.staged);
    await app.api("PATCH", "/settings", { release_prereleases: false });
    r = await until("a check without prereleases", async () => {
      const r = (await app.status()).release;
      return r.latest?.version === "0.9.1" && r;
    });
    check(r.staged !== "0.9.4-rc.1", "turned off again, the prerelease isn't offered", { staged: r.staged, latest: r.latest?.version });
    await app.quit();
  } finally {
    await app.cleanup();
  }
};

/** An app that finds a server already on its port (one it didn't start) never offers release updates. */
checks.attached = async (gh) => {
  const app = new App("attached", gh);
  let server;
  try {
    gh.releases = [release("0.9.1"), release("0.9.0")];
    app.port = await freePort();
    // The 0.9.0 server from its tarball, started by hand, as a host's would be.
    const dir = path.join(app.dir, "server");
    fs.mkdirSync(dir);
    execFileSync("tar", ["-xzf", path.join(assets, "huntaway-server-0.9.0-linux-x64.tar.gz"), "-C", dir, "--strip-components", "1"]);
    const env = { ...cleanEnv(), IA_CLAUDE_BIN: "/bin/false", IA_CODEX_BIN: "/bin/false" };
    server = spawn(path.join(dir, "huntaway"), ["serve", "--host", "127.0.0.1", "--port", String(app.port), "--data-dir", app.data], {
      env,
      stdio: ["ignore", fs.openSync(path.join(app.dir, "server.log"), "w"), fs.openSync(path.join(app.dir, "server.log"), "a")],
    });
    await until("the server", () => app.listening());
    app.token = fs.readFileSync(path.join(app.data, "auth_token"), "utf8").trim();
    await app.launch(appImage(app, "0.9.0"), { attach: true });
    const st = await app.status();
    check(st.release === undefined, "the server it attached to has no release updates", st.release);
    const err = await app.api("POST", "/admin/release/check").catch((e) => e);
    check(err.status === 400, "and Check now is refused", err.message);
    const page = await app.page();
    const shell = await page.evaluate(() => window.huntawayDesktop.updateShell().then(
      () => "installed",
      (e) => e.message,
    ));
    check(/hasn't found a release/.test(shell), "the app's own package update has nothing to install", shell);
    check(!gh.requests.some((r) => r.startsWith("GET /dl/")), "nothing was downloaded", gh.requests);
    await app.quit({ attached: true });
    check(server.exitCode === null && (await app.listening()), "quitting the app leaves the server it didn't start running");
  } finally {
    server?.kill();
    await app.cleanup();
  }
};

/** The AppImage replaces its own file with 0.9.3's, which has a new shell, and relaunches as 0.9.3. */
checks.appimage = async (gh) => {
  const app = new App("appimage", gh);
  try {
    gh.releases = [release("0.9.3"), release("0.9.0")];
    const cmd = appImage(app, "0.9.0");
    await app.launch(cmd);
    const r = await checkAndWait(app, "0.9.3");
    check(r.shell?.outdated, "0.9.3's shell differs from this app's", r.shell);
    const page = await app.page();
    check((await page.evaluate(() => window.huntawayDesktop.shellUpdateKind())) === "appimage", "the app can update itself as an AppImage");
    const oldPid = app.pgid;
    const result = await page.evaluate(() => window.huntawayDesktop.updateShell().then(
      (r) => r,
      (e) => ({ error: e.message }),
    ));
    check(result.version === "0.9.3", "it installed 0.9.3", result);
    await app.browser.close().catch(() => {});
    app.browser = null;
    check(sha256(cmd[0]) === sha256(path.join(assets, "huntaway-0.9.3-linux-x86_64.AppImage")), "the AppImage file is 0.9.3's now");
    check((fs.statSync(cmd[0]).mode & 0o111) !== 0, "and executable");
    check(fs.readdirSync(app.dir).filter((f) => f.startsWith(".Huntaway.AppImage.update-")).length === 0, "with no download left beside it");
    // The relaunched app is a new process outside the old one's group: find it by its server.
    await until("the relaunched app's server", async () => (await app.info().catch(() => null))?.version === "0.9.3", 90_000);
    const st = await app.status();
    check(st.release.shell.version === "0.9.3" && st.release.shell.outdated === false, "the relaunched app is 0.9.3, with its shell up to date", st.release.shell);
    // Stop the relaunched app: its Electron is the server's parent.
    const server = app.serverPid();
    const ppid = Number(fs.readFileSync(`/proc/${server}/stat`, "utf8").split(") ")[1].split(" ")[1]);
    app.pgid = Number(fs.readFileSync(`/proc/${ppid}/stat`, "utf8").split(") ")[1].split(" ")[2]);
    check(app.pgid !== oldPid, "in a new process");
    await app.quit();
  } finally {
    await app.cleanup();
  }
};

/** The shell's own fallback when the version state.json names is broken on disk: it starts the one before it. */
checks.launch = async (gh) => {
  const app = new App("launch", gh);
  try {
    gh.releases = [release("0.9.1"), release("0.9.0")];
    const cmd = appImage(app, "0.9.0");
    await app.launch(cmd);
    await checkAndWait(app, "0.9.1");
    await restartJob(app, "/admin/release/update", { version: "0.9.1" });
    await app.quit();
    // 0.9.2 by hand as current, with 0.9.1 before it: the app starts 0.9.2, which exits, and falls back to 0.9.1.
    const appDir = path.join(app.data, "app");
    execFileSync("tar", ["-xzf", path.join(assets, "huntaway-server-0.9.2-linux-x64.tar.gz"), "-C", appDir]);
    fs.renameSync(path.join(appDir, "huntaway-server-0.9.2-linux-x64"), path.join(appDir, "0.9.2"));
    fs.writeFileSync(path.join(appDir, "state.json"), JSON.stringify({ ...app.installed(), current: "0.9.2", previous: "0.9.1" }));
    await app.launch(cmd);
    check((await app.info()).version === "0.9.1", "a current version that exits at once falls back to the previous one");
    const s = app.installed();
    check(s.bad?.includes("0.9.2"), "and is marked bad", s);
    await app.quit();
  } finally {
    await app.cleanup();
  }
};

// ---------- pacman, in a container ----------

/**
 * The 0.9.0 .pacman installed in a throwaway Arch container (sharing the host's network, so its app is on a free port
 * on 127.0.0.1 like the others): the server stages and updates to 0.9.1, and the app's Install runs `pkexec pacman -U`
 * (a stand-in pkexec, as root has no polkit agent there) for 0.9.3's package and relaunches as 0.9.3.
 */
checks.pacman = async (gh) => {
  const app = new App("pacman", gh);
  const name = `huntaway-e2e-${process.pid}`;
  const docker = (...a) => execFileSync("docker", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 });
  try {
    gh.releases = [release("0.9.1"), release("0.9.0")];
    log("starting the container and installing huntaway-0.9.0 (with its dependencies)");
    docker("run", "-d", "--rm", "--name", name, "--network", "host", "-v", `${assets}:/assets:ro`, "archlinux:latest", "sleep", "infinity");
    app.docker = name;
    const sh = (script) => docker("exec", name, "sh", "-c", script);
    sh("pacman -Sy --noconfirm --needed archlinux-keyring >/dev/null 2>&1; pacman -U --noconfirm /assets/huntaway-0.9.0-linux-x64.pacman > /tmp/install.log 2>&1 || (cat /tmp/install.log; exit 1)");
    check(/^huntaway 0\.9\.0/.test(sh("pacman -Q huntaway")), "huntaway 0.9.0 is installed", sh("pacman -Q huntaway"));
    // pkexec as root, without polkit: run the command.
    sh(`printf '#!/bin/sh\\necho "pkexec $*" >> /tmp/pkexec.log\\nexec "$@"\\n' > /usr/local/bin/pkexec && chmod +x /usr/local/bin/pkexec`);
    app.port = await freePort();
    app.cdp = await freePort();
    const launch = async () => {
      app.cdp = await freePort();
      const env = [
        `IA_DATA_DIR=/data`,
        `IA_PORT=${app.port}`,
        `IA_RELEASE_UPDATES=x/y`,
        `IA_RELEASE_API=${gh.base}`,
        `IA_CLAUDE_BIN=/bin/false`,
        `IA_CODEX_BIN=/bin/false`,
      ].flatMap((e) => ["-e", e]);
      docker("exec", "-d", ...env, name, "sh", "-c",
        `exec /opt/Huntaway/huntaway-desktop --ozone-platform=headless --disable-gpu --no-sandbox --remote-debugging-port=${app.cdp} >> /tmp/app.log 2>&1`);
      await until("the app's board in the container", () => app.boardLoaded(), 120_000);
      app.token = sh("cat /data/auth_token").trim();
    };
    await launch();
    let st = await app.status();
    check(st.release?.shell?.install === "pacman" && (await app.info()).version === "0.9.0", "the pacman app runs its 0.9.0 server, and knows it's from pacman", st.release?.shell);
    let r = await checkAndWait(app, "0.9.1");
    check(r.staged === "0.9.1", "0.9.1 is staged in the user's data dir, not /opt", r);
    const job = await restartJob(app, "/admin/release/update", { version: "0.9.1" });
    check(!job.failed && (await app.info()).version === "0.9.1" && job.status.release.exe === "/data/app/0.9.1/huntaway", "Update runs /data/app/0.9.1", job.failed ?? job.status.release.exe);
    check(sh("pacman -Qkk huntaway 2>&1 | tail -1").includes("0 altered"), "and pacman's files are unchanged", sh("pacman -Qkk huntaway 2>&1 | tail -1"));

    log("Install 0.9.3's package");
    gh.releases.unshift(release("0.9.3"));
    r = await checkAndWait(app, "0.9.3");
    check(r.shell?.outdated && r.shell.package?.name === "huntaway-0.9.3-linux-x64.pacman", "0.9.3's shell differs, with its .pacman", r.shell);
    const page = await app.page();
    check((await page.evaluate(() => window.huntawayDesktop.shellUpdateKind())) === "pacman", "the app can install its package");
    const result = await page.evaluate(() => window.huntawayDesktop.updateShell().then(
      (r) => r,
      (e) => ({ error: e.message }),
    ));
    check(result.version === "0.9.3", "it installed 0.9.3", result);
    await app.browser.close().catch(() => {});
    app.browser = null;
    check(/^huntaway 0\.9\.3/.test(sh("pacman -Q huntaway")), "pacman has huntaway 0.9.3", sh("pacman -Q huntaway"));
    check(sh("cat /tmp/pkexec.log").includes("pkexec pacman -U --noconfirm /tmp/huntaway-update-"), "through pkexec pacman -U", sh("cat /tmp/pkexec.log"));
    await until("the relaunched app", async () => (await app.status().catch(() => null))?.release?.shell?.version === "0.9.3", 120_000);
    st = await app.status();
    // The package (0.9.3) is newer than app/0.9.1, so it starts its own server.
    check((await app.info()).version === "0.9.3" && st.release.exe === "/opt/Huntaway/resources/huntaway", "the relaunched 0.9.3 app runs its own 0.9.3 server", st.release.exe);
    check(st.release.shell.outdated === false, "and its shell is up to date");
    check(!sh("ls /tmp").includes("huntaway-update-"), "the downloaded package is gone");
  } finally {
    if (keep) {
      try {
        fs.writeFileSync(path.join(app.dir, "app.log"), docker("exec", name, "cat", "/tmp/app.log"));
      } catch {
        // no log
      }
    }
    try {
      docker("rm", "-f", name);
    } catch {
      // not started
    }
    if (!keep) fs.rmSync(app.dir, { recursive: true, force: true });
  }
};

// ---------- main ----------

const order = ["updates", "prereleases", "attached", "appimage", "launch", ...(args.includes("--pacman") ? ["pacman"] : [])];
const selected = only ?? order;
const gh = new FakeGitHub();
await gh.start();
log(`fake GitHub on ${gh.base}`);
const failed = [];
for (const name of selected) {
  log(`== ${name}`);
  gh.requests = [];
  try {
    await checks[name](gh);
  } catch (e) {
    console.error(`FAILED ${name}: ${e.stack ?? e}`);
    console.error(`  (logs: ${path.join(runs, name)}${keep ? "" : ", rerun with --keep to keep them"})`);
    failed.push(name);
  }
}
gh.stop();
if (failed.length) {
  console.error(`failed: ${failed.join(", ")}`);
  process.exit(1);
}
log(`all passed: ${selected.join(", ")}`);
