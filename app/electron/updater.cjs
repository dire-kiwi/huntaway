// In-app updates for the packaged desktop app.
//
// The Arch package (`npm run dist`, a .pacman file) is published to GitHub Releases with a
// latest-linux.yml next to it. electron-updater checks that feed, downloads the new package in the
// background, and the board (through preload.cjs) or a native dialog offers to install it. Installing
// runs `pkexec pacman -U` (a polkit prompt for the password), then relaunches the app.
//
// We install the package ourselves rather than with electron-updater's quitAndInstall: on failure it
// retries after `pacman -Sy`, a partial upgrade that Arch warns against, and it goes through `bash -c`.
//
// Running from source (`npm run electron`) has no updates: pull and use Rebuild & restart instead.
// IA_UPDATE_URL points the updater at another feed (a directory with latest-linux.yml and the
// package, e.g. `python -m http.server` in app/release), also when running from source.

const { app, dialog, ipcMain, webContents } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const RELEASES_URL = "https://github.com/dire-kiwi/huntaway/releases";
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

/** What electron-builder wrote to resources/package-type ("pacman", "deb", …), if anything. */
function packageType() {
  try {
    return fs.readFileSync(path.join(process.resourcesPath, "package-type"), "utf8").trim();
  } catch {
    return null;
  }
}

/** Why this build can't update itself, or null if it can. */
function unsupportedReason() {
  if (process.env.IA_UPDATE_URL) return null;
  if (!app.isPackaged) return "Running from source: pull and use Rebuild & restart to update.";
  if (process.platform !== "linux" || packageType() !== "pacman") return "Only the Arch package (.pacman) updates itself.";
  return null;
}

let state = { supported: false, version: app.getVersion(), status: "idle" };
let updater = null;
let downloadedFile = null;
// Pages that show the update themselves (the board's sidebar). Without one, a native dialog does.
const subscribers = new Set();
const watched = new Set();
let dialogShownFor = null;

function set(patch) {
  state = { ...state, ...patch };
  for (const id of subscribers) {
    const wc = webContents.fromId(id);
    if (wc && !wc.isDestroyed()) wc.send("update:state", state);
    else subscribers.delete(id);
  }
  if (state.status === "ready" && subscribers.size === 0 && dialogShownFor !== state.available?.version) offerInDialog();
}

async function offerInDialog() {
  dialogShownFor = state.available?.version;
  const { response } = await dialog.showMessageBox({
    type: "info",
    title: "Update ready",
    message: `Huntaway ${state.available?.version} is ready to install.`,
    detail: "Installing asks for your password, then restarts Huntaway. Running agents keep going.",
    buttons: ["Install and restart", "Later"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) install();
}

async function check() {
  if (!updater) return state;
  try {
    await updater.checkForUpdates();
  } catch (e) {
    set({ status: "error", error: String(e?.message || e) });
  }
  return state;
}

/** Run a command, resolving with its exit code and the tail of its output. */
function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const keep = (d) => (out = (out + d).slice(-2000));
    p.stdout.on("data", keep);
    p.stderr.on("data", keep);
    p.on("error", (e) => resolve({ code: -1, out: String(e.message) }));
    p.on("exit", (code) => resolve({ code, out: out.trim() }));
  });
}

async function install() {
  if (state.status !== "ready" || !downloadedFile) return state;
  set({ status: "installing", error: null });
  // pkexec asks through the desktop's polkit agent. 126: the prompt was dismissed; 127: no agent (or not allowed).
  const { code, out } = await run("pkexec", ["--disable-internal-agent", "/usr/bin/pacman", "-U", "--noconfirm", downloadedFile]);
  if (code !== 0) {
    const why = code === 126 ? "The password prompt was dismissed." : out || `pkexec exited with ${code}.`;
    set({ status: "ready", error: `${why} You can also install it from a terminal: sudo pacman -U ${downloadedFile}` });
    return state;
  }
  app.relaunch();
  app.quit();
  return state;
}

function setup() {
  ipcMain.handle("update:get", () => state);
  ipcMain.handle("update:check", () => check());
  ipcMain.handle("update:install", () => install());
  ipcMain.on("update:subscribe", (e) => {
    const wc = e.sender;
    if (!watched.has(wc.id)) {
      watched.add(wc.id);
      wc.once("destroyed", () => (subscribers.delete(wc.id), watched.delete(wc.id)));
      // The next page (a reload, or a remote board's UI without the update button) subscribes again if it shows updates.
      wc.on("did-start-navigation", (details) => details.isMainFrame && !details.isSameDocument && subscribers.delete(wc.id));
    }
    subscribers.add(wc.id);
    wc.send("update:state", state);
  });

  const reason = unsupportedReason();
  if (reason) {
    set({ supported: false, reason });
    return;
  }
  const { autoUpdater } = require("electron-updater");
  updater = autoUpdater;
  updater.autoDownload = true;
  // Installing needs the password prompt, so it's never done behind the user's back on quit.
  updater.autoInstallOnAppQuit = false;
  updater.logger = { info: (m) => console.log(`updater: ${m}`), warn: console.warn, error: console.error, debug: () => {} };
  if (process.env.IA_UPDATE_URL) {
    updater.forceDevUpdateConfig = !app.isPackaged;
    updater.setFeedURL({ provider: "generic", url: process.env.IA_UPDATE_URL });
  }
  const releaseUrl = (version) => (process.env.IA_UPDATE_URL ? null : `${RELEASES_URL}/tag/v${version}`);
  updater.on("checking-for-update", () => set({ status: state.status === "ready" ? "ready" : "checking", error: null }));
  updater.on("update-not-available", () => set({ status: "none", checkedAt: new Date().toISOString() }));
  updater.on("update-available", (info) =>
    set({ status: "downloading", percent: 0, available: { version: info.version, date: info.releaseDate, url: releaseUrl(info.version) } }),
  );
  updater.on("download-progress", (p) => set({ percent: Math.round(p.percent) }));
  updater.on("update-downloaded", (info) => {
    downloadedFile = info.downloadedFile;
    set({ status: "ready", checkedAt: new Date().toISOString(), available: { version: info.version, date: info.releaseDate, url: releaseUrl(info.version) } });
  });
  updater.on("error", (e) => set({ status: state.status === "ready" ? "ready" : "error", error: String(e?.message || e) }));
  set({ supported: true });

  setTimeout(check, 10_000);
  setInterval(() => state.status !== "installing" && check(), CHECK_EVERY_MS);
}

module.exports = { setup };
