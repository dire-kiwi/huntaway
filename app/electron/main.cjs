// Electron shell for Huntaway.
//
// Local mode (default): reuse a server already listening on the configured port,
// or spawn the Rust `huntaway` binary and stop it on quit. The window loads
// the UI from the server itself, so the desktop app and remote browsers share
// one code path.
//
// Remote mode: set `serverUrl` (and `token`) in ~/.config/huntaway/desktop.json
// to use a server running on another machine.

const { app, BrowserWindow, ipcMain, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

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
const port = Number(process.env.IA_PORT || config.port || 7878);
let serverProc = null;

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

function findServerBinary() {
  const exe = process.platform === "win32" ? "huntaway.exe" : "huntaway";
  const candidates = [
    process.env.IA_SERVER_BIN,
    config.serverBin,
    app.isPackaged ? path.join(process.resourcesPath, exe) : null,
    path.join(__dirname, "..", "..", "server", "target", "release", exe),
    path.join(__dirname, "..", "..", "server", "target", "debug", exe),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p));
}

async function healthy(base) {
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Start the server and resolve with its token once it prints IA_READY. */
function startServer() {
  const bin = findServerBinary();
  if (!bin) throw new Error("Could not find the huntaway server binary. Build it with `cargo build --release` in server/.");
  const args = ["serve", "--port", String(port)];
  if (process.env.IA_DATA_DIR || config.dataDir) args.push("--data-dir", defaultDataDir());
  if (config.host) args.push("--host", config.host);
  serverProc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  serverProc.stderr.on("data", (d) => process.stderr.write(d));
  serverProc.on("exit", (code) => {
    console.error(`huntaway server exited (${code})`);
    serverProc = null;
  });
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("Server did not start within 15s")), 15000);
    serverProc.stdout.on("data", (d) => {
      process.stdout.write(d);
      buf += d.toString();
      const m = buf.match(/IA_READY (\{.*\})/);
      if (m) {
        clearTimeout(timer);
        resolve(JSON.parse(m[1]).token);
      }
    });
    serverProc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited with code ${code}`));
    });
  });
}

async function resolveTarget() {
  if (config.serverUrl) return { base: config.serverUrl.replace(/\/$/, ""), token: config.token || "" };
  const base = `http://127.0.0.1:${port}`;
  const token = (await healthy(base)) ? readToken() : await startServer();
  return { base, token };
}

function errorPage(message) {
  const html = `<body style="background:#0b0b0e;color:#e6e6ec;font:14px system-ui;padding:40px">
    <h2>Huntaway couldn't start</h2><pre style="white-space:pre-wrap;color:#f87171">${String(message).replace(/</g, "&lt;")}</pre>
    <p style="color:#9a9aab">Config: ${CONFIG_PATH}</p></body>`;
  return "data:text/html;charset=utf-8," + encodeURIComponent(html);
}

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
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  try {
    const { base, token } = await resolveTarget();
    const ui = process.env.IA_DEV_URL || base;
    await win.loadURL(`${ui}/${token ? `?token=${encodeURIComponent(token)}` : ""}`);
  } catch (e) {
    await win.loadURL(errorPage(e.message || e));
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

app.on("before-quit", () => {
  // Agents run under ia-shim and outlive the server; the next start picks them back up.
  if (serverProc) serverProc.kill("SIGTERM");
});
