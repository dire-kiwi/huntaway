// Electron shell for Huntaway.
//
// Local mode (default): reuse a server already listening on the configured port,
// or spawn the Rust `huntaway` binary and stop it on quit. The window loads
// the UI from the server itself, so the desktop app and remote browsers share
// one code path.
//
// Remote mode: set `serverUrl` (and `token`) in ~/.config/huntaway/desktop.json
// to use a server running on another machine.
//
// Installed with scripts/install.sh, it runs from a source checkout and updates like any host: the
// server's Rebuild & restart, or Update when it follows a deployment (IA_UPDATE_FROM). The window
// reloads onto the new UI, and the app relaunches itself if the update changed this directory.
//
// A release build (`npm run dist`, attached to each GitHub release by .github/workflows/release.yml: the AppImage, the
// pacman package and the mac app) carries the server, ia-shim and the UI in its resources. The server it starts checks
// GitHub's releases (IA_RELEASE_UPDATES, see releaseEnv in versions.cjs) and downloads each new one's server into
// `<data dir>/app/<version>/`, per user, so pacman's files in /opt stay as they are. The sidebar's Update restarts the
// server onto it, and from then on this app starts that version (chooseServer in versions.cjs) rather than its bundled
// one, unless the package is newer. A version that won't start is marked bad, and the one before it, or the bundled
// one, runs instead. A release that also changed this shell (Electron and electron/) needs a newer package.

const { app, BrowserWindow, ipcMain, shell } = require("electron");
const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { shellStamp } = require("./stamp.cjs");
const versions = require("./versions.cjs");

/** `dir`, or `legacy` from before the rename to Huntaway if only that one exists. */
function renamed(dir, legacy) {
  return !fs.existsSync(dir) && fs.existsSync(legacy) ? legacy : dir;
}

// Keep the window's storage (sidebar order, sign-in) from when the app was called Issue Agent.
// Electron names that dir after package.json's top-level name when run from source
// (`npm run electron`), and after build.productName in a packaged app.
const legacyUserData = app.isPackaged ? "Issue Agent" : "issue-agent-app";
app.setPath("userData", renamed(app.getPath("userData"), path.join(app.getPath("appData"), legacyUserData)));

const CONFIG_PATH = renamed(
  path.join(app.getPath("appData"), "huntaway", "desktop.json"),
  path.join(app.getPath("appData"), "issue-agent", "desktop.json"),
);

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

const config = loadConfig();

/**
 * An app started from the Dock or a desktop launcher gets a minimal PATH, without the folders of claude, codex, git
 * and gh (Homebrew's, ~/.local/bin, nvm's). Take the login shell's, as a terminal would have it. install.sh's launcher
 * sets PATH itself, so this is for release builds.
 */
function useLoginShellPath() {
  if (process.platform === "win32") return;
  try {
    const out = execFileSync(process.env.SHELL || "/bin/sh", ["-ilc", 'printf "\\n__HUNTAWAY_PATH__%s\\n" "$PATH"'], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    const found = out.match(/^__HUNTAWAY_PATH__(.+)$/m)?.[1].split(":") ?? [];
    const dirs = [...found, ...(process.env.PATH || "").split(":")].filter(Boolean);
    process.env.PATH = [...new Set(dirs)].join(":");
  } catch (e) {
    console.error(`couldn't read the login shell's PATH: ${e.message}`);
  }
}
if (app.isPackaged) useLoginShellPath();

const port = Number(process.env.IA_PORT || config.port || 7878);
let serverProc = null;
let stopping = false;

// Pages on plain HTTP get no notifications (browsers keep them to HTTPS and localhost), so a remote server
// reached over HTTP counts as secure here: it's the one this app was set up to use.
if (config.serverUrl?.startsWith("http:")) {
  try {
    app.commandLine.appendSwitch("unsafely-treat-insecure-origin-as-secure", new URL(config.serverUrl).origin);
  } catch {
    // Not a URL: resolveTarget's load fails and says so.
  }
}

/** Mirrors `default_data_dir()` in the server: `dirs::data_dir()/huntaway`, or `/issue-agent` from before the rename. */
function defaultDataDir() {
  if (process.env.IA_DATA_DIR) return process.env.IA_DATA_DIR;
  if (config.dataDir) return config.dataDir.replace(/^~(?=\/|$)/, os.homedir());
  let base;
  switch (process.platform) {
    case "darwin":
      base = path.join(os.homedir(), "Library", "Application Support");
      break;
    case "win32":
      base = process.env.APPDATA || os.homedir();
      break;
    default:
      base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  }
  return renamed(path.join(base, "huntaway"), path.join(base, "issue-agent"));
}

function readToken() {
  try {
    return fs.readFileSync(path.join(defaultDataDir(), "auth_token"), "utf8").trim();
  } catch {
    return "";
  }
}

// A release build's resources: the bundled server, ia-shim and UI. IA_PACKAGED_RESOURCES runs a checkout as a release
// build with its resources in that dir, to try the release layout (chooseServer, the fallback) without packaging.
const resourcesDir = process.env.IA_PACKAGED_RESOURCES || (app.isPackaged ? process.resourcesPath : null);
const EXE = process.platform === "win32" ? "huntaway.exe" : "huntaway";

/** Where the server downloads release versions, and their state.json (see versions.cjs). */
const releaseDir = () => path.join(defaultDataDir(), "app");

/**
 * The server to start, as {bin, version, release}: IA_SERVER_BIN or config.serverBin; for a release build, the
 * installed version chooseServer picks (`version`; versions in `skip` failed just now) or the bundled one (`version`
 * null); from a checkout, its own build. `release` is whether it's a release build's server, which gets releaseEnv.
 */
function findServerBinary(skip = []) {
  const override = [process.env.IA_SERVER_BIN, config.serverBin].filter(Boolean).find((p) => fs.existsSync(p));
  if (override) return { bin: override, version: null, release: false };
  if (resourcesDir) {
    const bundled = path.join(resourcesDir, EXE);
    const choice = versions.chooseServer({ appDir: releaseDir(), bundled, minVersion: app.getVersion(), exe: EXE, skip });
    if (choice.version || fs.existsSync(bundled)) return { ...choice, release: true };
  }
  const bin = [
    path.join(__dirname, "..", "..", "server", "target", "release", EXE),
    path.join(__dirname, "..", "..", "server", "target", "debug", EXE),
  ].find((p) => fs.existsSync(p));
  return bin ? { bin, version: null, release: false } : null;
}

let installKind;
/** The environment for a server started here: a release build's turns on release updates (releaseEnv). */
function serverEnv(choice) {
  if (!choice.release) return process.env;
  installKind ??= versions.installKind({ resourcesPath: resourcesDir });
  const desktop = { version: app.getVersion(), shell: startStamp, install: installKind, bundled: path.join(resourcesDir, EXE) };
  return { ...process.env, ...versions.releaseEnv(desktop) };
}

/** Whether `url` is one for a browser (http, https or mailto), rather than a file or another app's scheme. */
function isWebUrl(url) {
  try {
    return ["http:", "https:", "mailto:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Whether a fetch failed because nothing listens there, rather than a server that's slow (still starting, or busy). */
const refused = (e) => e?.cause?.code === "ECONNREFUSED";

/**
 * Whether a server answers at `base`. Only a refused connection counts as none: one that's still starting (a previous
 * launch's, or one restarting itself) is waited for, for up to `tries` seconds, rather than started a second time.
 */
async function healthy(base, tries = 10) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return true;
    } catch (e) {
      if (refused(e)) return false;
    }
    if (i + 1 >= tries) throw new Error(`Something on ${base} doesn't answer as a Huntaway server. Is another program using port ${port}?`);
    await sleep(1000);
  }
}

// The server's last lines of output, for the error page.
const LOG_LINES = 40;
const serverLog = [];
let partial = "";
function keepLog(chunk) {
  const lines = (partial + chunk.toString()).split(/\r?\n/);
  partial = lines.pop();
  for (const line of lines) if (line.trim()) serverLog.push(line);
  serverLog.splice(0, serverLog.length - LOG_LINES);
}

/** A line about the server's start, in the app's log and the error page's server output. */
function note(line) {
  console.error(line);
  serverLog.push(line);
  serverLog.splice(0, serverLog.length - LOG_LINES);
}

/** Mark an installed release version bad in state.json, so that it isn't started again. */
function badVersion(version, why) {
  note(`huntaway ${version} ${why}: marking it bad`);
  try {
    versions.markBad(releaseDir(), version);
  } catch (e) {
    note(`couldn't save that in ${path.join(releaseDir(), "state.json")}: ${e.message}`);
  }
}

/**
 * Start the server and resolve with its token once it prints IA_READY. `onLost` runs if it exits after that.
 *
 * Its callers have found nothing on the port, so for a release build, a version an Update was exec'ing into (`trying`)
 * didn't come up, and is marked bad. An installed version that exits before IA_READY is marked bad too, and the next
 * one chooseServer picks is started at once: these don't count as the server stopping (serverLost).
 */
async function startServer(onLost) {
  serverLog.length = 0;
  partial = "";
  const failed = [];
  const { trying } = resourcesDir ? versions.readState(releaseDir()) : {};
  if (typeof trying === "string") {
    failed.push(trying);
    badVersion(trying, "didn't come up after an update");
  }
  for (;;) {
    const choice = findServerBinary(failed);
    if (!choice) throw new Error("Could not find the huntaway server binary. Build it with `cargo build --release` in server/.");
    try {
      return await spawnServer(choice, onLost);
    } catch (e) {
      // One stopped by quitting isn't a bad version.
      if (!choice.version || !e.early || stopping) throw e;
      failed.push(choice.version);
      badVersion(choice.version, `didn't start (${e.message})`);
    }
  }
}

/** Start `choice` (findServerBinary's), resolving with its token once it's ready. A rejection's `early` is whether it
 * exited (or couldn't be run) before then, rather than taking too long. */
function spawnServer(choice, onLost) {
  const { bin, version } = choice;
  const args = ["serve", "--port", String(port)];
  if (process.env.IA_DATA_DIR || config.dataDir) args.push("--data-dir", defaultDataDir());
  if (config.host) args.push("--host", config.host);
  console.log(`starting the huntaway server${version ? ` ${version}` : choice.release ? " bundled with the app" : ""}: ${bin}`);
  const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env: serverEnv(choice) });
  serverProc = proc;
  let ready = false;
  proc.stderr.on("data", (d) => {
    process.stderr.write(d);
    keepLog(d);
  });
  // Once it's exited and the last of its output is in: on close, unless agents it started still hold its pipes.
  const ended = new Promise((resolve) =>
    proc.on("exit", (code, signal) => {
      if (serverProc === proc) serverProc = null;
      proc.once("close", () => resolve({ code, signal }));
      setTimeout(() => resolve({ code, signal }), 500);
    }),
  );
  ended.then(({ code, signal }) => {
    console.error(`huntaway server exited (${signal ?? code})`);
    if (ready && !stopping) onLost?.();
  });
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("Server did not start within 15s")), 15000);
    proc.stdout.on("data", (d) => {
      process.stdout.write(d);
      buf += d.toString();
      const m = buf.match(/IA_READY (\{.*\})/);
      if (m) {
        clearTimeout(timer);
        ready = true;
        resolve(JSON.parse(m[1]).token);
      }
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(Object.assign(e, { early: true }));
    });
    ended.then(({ code, signal }) => {
      clearTimeout(timer);
      reject(Object.assign(new Error(`Server exited with ${signal ? `signal ${signal}` : `code ${code}`}`), { early: true }));
    });
  });
}

/** The server to use: the one configured, one already running on the port, or one started here. */
async function resolveTarget(onLost) {
  if (config.serverUrl) return { base: config.serverUrl.replace(/\/$/, ""), token: config.token || "" };
  const base = `http://127.0.0.1:${port}`;
  if (await healthy(base)) return { base, token: readToken() };
  try {
    return { base, token: await startServer(onLost) };
  } catch (e) {
    // Another launch's server may have taken the port meanwhile: use it.
    if (await healthy(base, 3).catch(() => false)) return { base, token: readToken() };
    throw e;
  }
}

// The error page's Retry goes here, and is stopped on its way (a web address, so that it's navigated to like one).
const RETRY_URL = "https://retry.huntaway.invalid/";

function errorPage(message, title = "Huntaway couldn't start") {
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const log = serverLog.length
    ? `<p style="color:#9a9aab;margin-top:24px">The server's last output:</p>
    <pre style="white-space:pre-wrap;font:12px ui-monospace,monospace;color:#c8c8d0;background:#16161d;border:1px solid #24242e;border-radius:8px;padding:12px;max-height:50vh;overflow:auto">${esc(serverLog.join("\n"))}</pre>`
    : "";
  const html = `<body style="background:#0b0b0e;color:#e6e6ec;font:14px system-ui;padding:40px">
    <h2>${esc(title)}</h2><pre style="white-space:pre-wrap;color:#f87171">${esc(message)}</pre>${log}
    <p><a href="${RETRY_URL}" style="display:inline-block;margin-top:8px;padding:6px 14px;border-radius:6px;background:#6366f1;color:#fff;text-decoration:none">Retry</a></p>
    <p style="color:#9a9aab">Config: ${esc(CONFIG_PATH)}</p></body>`;
  return "data:text/html;charset=utf-8," + encodeURIComponent(html);
}

/** This process's own code (this directory) and its Electron (the one npm installed, from source), to see when an update
 * changed them. A release's manifest has the same stamp for its packaged app (stamp.cjs). */
function mainStamp() {
  let electron = process.versions.electron;
  if (!app.isPackaged) {
    try {
      electron = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "node_modules", "electron", "package.json"), "utf8")).version;
    } catch {
      electron = undefined; // not installed
    }
  }
  return shellStamp(__dirname, electron);
}
const startStamp = mainStamp();

async function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0b0b0e",
    autoHideMenuBar: true,
    title: "Huntaway",
    webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, "preload.cjs") },
  });
  // The board reloads once a rebuild has restarted the server. If that changed the app itself, start the new one.
  win.webContents.on("did-finish-load", () => {
    if (mainStamp() !== startStamp) {
      console.log("the desktop app changed on disk; relaunching");
      // Through install.sh's launcher where there is one, which downloads the Electron an update may have installed.
      const launcher = process.env.HUNTAWAY_LAUNCHER;
      app.relaunch(launcher ? { execPath: launcher, args: process.argv.slice(2) } : undefined);
      app.quit();
    }
  });
  // Links open in the browser, web links only: a plan or artifact is a page an agent wrote, and its
  // scripts can open popups, so file:, custom schemes and the like stay out of the OS handlers.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  // The error page's Retry; otherwise the window stays on the board: a file dropped outside a drop zone, or
  // a link dragged in, would replace it (a web link opens in the browser instead).
  win.webContents.on("will-navigate", (e, url) => {
    if (url === RETRY_URL) {
      e.preventDefault();
      void load(win);
      return;
    }
    let origin = null;
    try {
      origin = new URL(url).origin;
    } catch {
      /* not a URL the window should go to either */
    }
    if (boardOrigin && origin !== boardOrigin) {
      e.preventDefault();
      if (isWebUrl(url)) shell.openExternal(url);
    }
  });
  await load(win);
}

/** The board's origin once it has loaded, the one navigation the window takes. */
let boardOrigin = null;

async function load(win) {
  try {
    const { base, token } = await resolveTarget(() => void serverLost(win));
    const ui = process.env.IA_DEV_URL || base;
    boardOrigin = new URL(ui).origin;
    await win.loadURL(`${ui}/${token ? `?token=${encodeURIComponent(token)}` : ""}`);
  } catch (e) {
    if (!win.isDestroyed()) await win.loadURL(errorPage(e.message || e));
  }
}

/**
 * The server started here stopped. The board stays open and reconnects once there's a server again: one that started
 * meanwhile (a restart that runs the new binary from a new process), or one started here again, waiting longer after
 * each that stops at once. After a few of those, the error page says why.
 *
 * A release version an Update exec'd into that died before it came up is still `trying`, so startServer marks it bad
 * and starts the one before it, rather than the same one again.
 */
let restarts = [];
async function serverLost(win) {
  const now = Date.now();
  restarts = restarts.filter((t) => now - t < 5 * 60_000);
  const delay = Math.min(30_000, 1000 * 2 ** restarts.length);
  if (restarts.length >= 5) {
    if (!win.isDestroyed()) await win.loadURL(errorPage(`It stopped ${restarts.length + 1} times in five minutes.`, "Huntaway's server stopped"));
    restarts = [];
    return;
  }
  restarts.push(now);
  await sleep(delay);
  if (stopping || win.isDestroyed()) return;
  const base = `http://127.0.0.1:${port}`;
  try {
    if (await healthy(base)) return;
    await startServer(() => void serverLost(win));
  } catch (e) {
    if (await healthy(base, 3).catch(() => false)) return;
    if (!win.isDestroyed()) await win.loadURL(errorPage(`It didn't start again: ${e.message || e}`, "Huntaway's server stopped"));
  }
}

ipcMain.on("huntaway:badge", (_e, n) => {
  app.setBadgeCount(Math.max(0, Math.floor(Number(n)) || 0));
});

ipcMain.on("huntaway:focus", (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("before-quit", (e) => {
  // Agents run under ia-shim and outlive the server; the next start picks them back up.
  if (!serverProc) return;
  // Wait for it to exit, so that a relaunch (after an update) starts a new server rather than finding this one going down.
  e.preventDefault();
  if (stopping) return;
  stopping = true;
  const proc = serverProc;
  const kill = setTimeout(() => proc.kill("SIGKILL"), 10_000);
  proc.once("exit", () => {
    clearTimeout(kill);
    app.quit();
  });
  proc.kill("SIGTERM");
});
