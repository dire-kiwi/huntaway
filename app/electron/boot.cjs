// The desktop app's entry point (package.json's `main`), and the only part of the shell that a release can't replace.
//
// A release build's server updates itself in place: each release's tarball is unpacked into `<data dir>/app/<v>/`, and
// the app starts that version's server rather than the one in its package. This does the same for the shell: it loads
// `main.cjs` and the files beside it from that version's `electron/` (the release workflow puts a copy there, with a
// `shell.json`), so a release that changes only electron/*.cjs reaches an installed app without a new AppImage or
// pacman package. What a release can't change this way is this file and Electron itself: they're the "frame", whose
// stamp (frameStamp in stamp.cjs) is what the server compares to say the app needs a new package.
//
// Which shell: the one in the version the server will run (chooseShell, which follows versions.chooseServer), when it
// has an `electron/` that suits this Electron and boot protocol, and isn't marked bad. Otherwise the shell in this
// package, beside this file. Once an Update has restarted the server onto a version with a newer shell, main.cjs asks
// `globalThis.huntawayBoot.choose()` (this file's own logic, so that the answer is the one the next start will act on)
// and relaunches the app onto it.
//
// A shell that throws as it loads is marked bad at once, and the app relaunches without it. One that dies later leaves
// its marker in `app/shell-state.json` (`trying`, with the app's pid): the next start sees that no process is running
// under that pid, marks the shell bad and runs the package's. The marker is cleared after the shell has run for
// SURVIVED_MS, or when the app quits. `shell-state.json` is the shell's alone (the server leaves other files in app/
// as they are), so it doesn't take part in state.json's two-writer protocol.
//
// Everything here is plain Node, with Electron's `app` only for paths and the relaunch, so that tests can load it.

let electron;
try {
  electron = require("electron");
} catch {
  // Under plain Node (tests), where the electron package isn't installed, or has no binary.
}
const app = electron?.app;
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** What this file offers a shell. A shell.json's `boot` is the lowest it needs; a shell needing more isn't loaded. */
const BOOT_API = 1;
const SURVIVED_MS = 20_000;

const exeName = process.platform === "win32" ? "huntaway.exe" : "huntaway";

/** `dir`, or `legacy` from before the rename to Huntaway if only that one exists. Mirrors main.cjs. */
function renamed(dir, legacy) {
  return !fs.existsSync(dir) && fs.existsSync(legacy) ? legacy : dir;
}

function readJson(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** The desktop config (~/.config/huntaway/desktop.json). Mirrors main.cjs. */
function loadConfig(appData) {
  return readJson(renamed(path.join(appData, "huntaway", "desktop.json"), path.join(appData, "issue-agent", "desktop.json")));
}

/** Where the server keeps its data (`default_data_dir()` in the server, as main.cjs mirrors it). */
function dataDir(config, { env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (env.IA_DATA_DIR) return env.IA_DATA_DIR;
  if (config.dataDir) return config.dataDir.replace(/^~(?=\/|$)/, home);
  let base;
  switch (platform) {
    case "darwin":
      base = path.join(home, "Library", "Application Support");
      break;
    case "win32":
      base = env.APPDATA || home;
      break;
    default:
      base = env.XDG_DATA_HOME || path.join(home, ".local", "share");
  }
  return renamed(path.join(base, "huntaway"), path.join(base, "issue-agent"));
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Semver precedence of two versions (negative, 0 or positive), NaN when either isn't semver. Same as versions.cjs. */
function compareVersions(a, b) {
  const parse = (v) => {
    const m = typeof v === "string" ? v.trim().match(SEMVER) : null;
    return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? m[4].split(".") : []] : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return NaN;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  const [p, q] = [x[3], y[3]];
  if (!p.length || !q.length) return q.length - p.length;
  for (let i = 0; i < Math.min(p.length, q.length); i++) {
    if (p[i] === q[i]) continue;
    const [n, m] = [/^\d+$/.test(p[i]), /^\d+$/.test(q[i])];
    if (n && m) return Number(p[i]) - Number(q[i]);
    if (n !== m) return n ? -1 : 1;
    return p[i] < q[i] ? -1 : 1;
  }
  return p.length - q.length;
}

const shellStatePath = (appDir) => path.join(appDir, "shell-state.json");

/** `app/shell-state.json`: `{bad: [versions whose shell failed], trying: {version, pid}}`. */
function readShellState(appDir) {
  return readJson(shellStatePath(appDir));
}

function writeShellState(appDir, state) {
  const file = shellStatePath(appDir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

function markShellBad(appDir, version) {
  const state = readShellState(appDir);
  const bad = Array.isArray(state.bad) ? state.bad : [];
  if (!bad.includes(version)) bad.push(version);
  const next = { ...state, bad };
  if (next.trying?.version === version) delete next.trying;
  writeShellState(appDir, next);
}

/** Whether a process with this pid exists (one we can't signal still does). */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/**
 * The shell in version `v`'s `electron/` if this app can run it, as {dir, version}: it has main.cjs and a shell.json
 * whose Electron has this one's major version (the shell uses Electron's API) and whose `boot` this file offers.
 */
function usableShell(appDir, v, electronVersion) {
  const dir = path.join(appDir, v, "electron");
  if (!isFile(path.join(dir, "main.cjs"))) return null;
  const meta = readJson(path.join(dir, "shell.json"));
  const major = (s) => String(s).split(".")[0];
  if (typeof meta.electron !== "string" || major(meta.electron) !== major(electronVersion)) return null;
  if (!(Number(meta.boot) <= BOOT_API)) return null;
  return { dir, version: v };
}

/**
 * The shell to load, {dir, version}, or null for the package's own. It's the shell of the version the server will start
 * (the first of state.json's trying, current and previous that is at least the app's version, isn't bad, and has the
 * files of a server, as versions.chooseServer picks), not of an older one that has a shell when that one hasn't.
 */
function chooseShell({ appDir, appVersion, electronVersion, exe = exeName }) {
  const state = readJson(path.join(appDir, "state.json"));
  const bad = new Set(Array.isArray(state.bad) ? state.bad : []);
  const shellBad = readShellState(appDir).bad ?? [];
  for (const v of [state.trying, state.current, state.previous]) {
    if (typeof v !== "string" || bad.has(v) || !(compareVersions(v, appVersion) >= 0)) continue;
    const dir = path.join(appDir, v);
    if (![path.join(dir, exe), path.join(dir, exe.replace(/^huntaway/, "ia-shim")), path.join(dir, "ui", "index.html")].every(isFile)) continue;
    // This version is the server's. A shell that failed doesn't move the choice to an older version's.
    if (shellBad.includes(v)) return null;
    return usableShell(appDir, v, electronVersion);
  }
  return null;
}

/**
 * Deal with a shell that was running when its process died (a `trying` whose pid isn't running): mark it bad. Returns
 * whether another app process is running a shell right now, which leaves the marker alone.
 */
function settleCrash(appDir) {
  const trying = readShellState(appDir).trying;
  if (!trying) return false;
  if (trying.pid !== process.pid && alive(trying.pid)) return true;
  console.error(`the desktop shell ${trying.version} stopped without quitting; using the one in the package`);
  markShellBad(appDir, trying.version);
  return false;
}

function boot() {
  const resources = process.env.IA_PACKAGED_RESOURCES || (app.isPackaged ? process.resourcesPath : null);
  const config = loadConfig(app.getPath("appData"));
  // What main.cjs does for release updates: a checkout, a remote server and a blank IA_RELEASE_UPDATES have none.
  if (!resources || config.serverUrl || process.env.IA_RELEASE_UPDATES?.trim() === "") return require("./main.cjs");

  const appDir = path.join(dataDir(config), "app");
  const params = { appDir, appVersion: app.getVersion(), electronVersion: process.versions.electron };
  const otherRunning = settleCrash(appDir);
  const choice = chooseShell(params);
  globalThis.huntawayBoot = { api: BOOT_API, running: choice, choose: () => chooseShell(params) };
  if (!choice) return require("./main.cjs");

  const clearMarker = () => {
    try {
      if (readShellState(appDir).trying?.pid === process.pid) {
        const { trying: _, ...rest } = readShellState(appDir);
        writeShellState(appDir, rest);
      }
    } catch {
      // Nothing to do about it: at worst the next start trusts the shell a little less.
    }
  };
  if (!otherRunning) writeShellState(appDir, { ...readShellState(appDir), trying: { version: choice.version, pid: process.pid } });
  try {
    console.log(`loading the desktop shell from huntaway ${choice.version}: ${choice.dir}`);
    require(path.join(choice.dir, "main.cjs"));
  } catch (e) {
    console.error(`the desktop shell in huntaway ${choice.version} failed to load: ${e.stack || e}`);
    markShellBad(appDir, choice.version);
    app.relaunch(process.env.APPIMAGE ? { execPath: process.env.APPIMAGE, args: process.argv.slice(1) } : undefined);
    app.exit(0);
    return;
  }
  setTimeout(clearMarker, SURVIVED_MS).unref();
  app.on("before-quit", clearMarker);
}

if (app) boot();

module.exports = { BOOT_API, chooseShell, compareVersions, dataDir, markShellBad, readShellState, settleCrash, usableShell, writeShellState };
