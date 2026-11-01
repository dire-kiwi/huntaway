// Updating the desktop app's own package (HA-68), for a release whose shell (Electron and electron/) changed, which the
// server's release updates can't install: an AppImage replaces its own file, and the pacman package is installed with
// `pkexec pacman -U`. main.cjs then relaunches the app. mac installs keep the instruction the board shows.
//
// Nothing here comes from the page, which shows agent-written HTML in frames: the version is the one the server's
// release check picked (GET /api/admin/server, which honours "Include prereleases"), and the package and its digest come
// from GitHub's API for that release's tag.

const { spawn: spawnProcess } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { compareVersions } = require("./versions.cjs");

/** What the app can install itself for an `installKind()` (versions.cjs): "appimage", "pacman", or null. */
function updateKind(install) {
  if (typeof install !== "string") return null;
  if (install.startsWith("appimage:")) return "appimage";
  return install === "pacman" ? "pacman" : null;
}

/** `<os>-<arch>` as the release's asset names have it (`linux-x64`), like `platform()` in server/src/release.rs. */
function assetPlatform(platform = process.platform, arch = process.arch) {
  return `${platform === "darwin" ? "mac" : platform}-${arch}`;
}

/**
 * The package for an install `kind` in release `version`, as electron-builder names it: the pacman package with the
 * platform's arch (`linux-x64`), the AppImage with AppImage's own (`linux-x86_64`). As `package_name` in release.rs.
 */
function packageName(kind, version, platform) {
  if (kind === "pacman") return `huntaway-${version}-${platform}.pacman`;
  if (kind !== "appimage") return null;
  const [os, arch] = platform.split("-");
  return `huntaway-${version}-${os}-${arch === "x64" ? "x86_64" : arch}.AppImage`;
}

/** An error whose message is for the user as it is. */
const fail = (message) => Object.assign(new Error(message), { userMessage: true });

/** What GitHub answered when it wasn't a success: the rate limit, or its message. */
async function refusal(res, what) {
  if ([403, 429].includes(res.status) && res.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    const at = reset ? ` until ${new Date(reset * 1000).toLocaleTimeString()}` : "";
    return fail(`GitHub's rate limit for this address is used up${at}.`);
  }
  let message = "";
  try {
    message = (await res.json()).message ?? "";
  } catch {
    // not JSON
  }
  return fail(`${what}: GitHub answered ${res.status}${message ? `: ${message}` : ""}`);
}

/**
 * The release to install, from the server this app uses (`base`, `token`): {version}, the latest release its check
 * found, once that release's shell differs from this app's and it's newer than this app (`current`, its version). Throws
 * when there's nothing to install: an older package (a check that skips the prerelease this app came from) would
 * downgrade it.
 */
async function latestShellRelease({ base, token, current, fetch = globalThis.fetch }) {
  let res;
  try {
    res = await fetch(`${base}/api/admin/server`, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    throw fail(`Couldn't ask the server which release is the latest: ${e.cause?.message ?? e.message}`);
  }
  if (!res.ok) throw fail(`Couldn't ask the server which release is the latest: it answered ${res.status}.`);
  const release = (await res.json().catch(() => ({}))).release;
  const version = release?.latest?.version;
  if (!version) throw fail("The server hasn't found a release yet. Check for updates in Settings → Server first.");
  if (!release.shell?.outdated) throw fail(`This app already has v${version}'s shell, so there's nothing to install.`);
  if (current && !(compareVersions(version, current) > 0)) throw fail(`This app (v${current}) isn't older than v${version}, so there's nothing to install.`);
  return { version };
}

/**
 * The package for `kind` in release `version` of `repo`, from GitHub's API at `api`: {name, url, size, sha256}. It must
 * have a sha256 digest, which the download is checked against.
 */
async function findPackage({ api, repo, version, kind, platform = assetPlatform(), fetch = globalThis.fetch }) {
  const name = packageName(kind, version, platform);
  if (!name) throw fail(`The app can't install itself as ${kind}.`);
  const headers = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "huntaway-desktop" };
  let release = null;
  // Release tags have a v; one without would be found too.
  for (const tag of [`v${version}`, version]) {
    const url = `${api}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`;
    let res;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      throw fail(`Couldn't reach GitHub for release v${version}: ${e.cause?.message ?? e.message}`);
    }
    if (res.status === 404) continue;
    if (!res.ok) throw await refusal(res, `Couldn't read release v${version}`);
    release = await res.json();
    break;
  }
  if (!release) throw fail(`GitHub has no release v${version} in ${repo}.`);
  const asset = (release.assets ?? []).find((a) => a.name === name);
  if (!asset) throw fail(`Release v${version} has no ${name}.`);
  const sha256 = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest ?? "")?.[1]?.toLowerCase();
  if (!sha256) throw fail(`GitHub gives no sha256 digest for ${name}, so its download can't be checked.`);
  return { name, url: asset.browser_download_url, size: asset.size ?? 0, sha256 };
}

/**
 * Download `url` into `file` (created, or replaced), hashing it as it goes, and check the hash against `sha256`. Calls
 * `onProgress(bytes, total)` (total is 0 when unknown) along the way. On failure, `file` is removed.
 */
async function download({ url, file, sha256, size = 0, onProgress = () => {}, fetch = globalThis.fetch }) {
  const hash = crypto.createHash("sha256");
  // Created here, never through something already at `file` (a link would have its target overwritten).
  let fd;
  try {
    fd = fs.openSync(file, "wx", 0o644);
  } catch (e) {
    throw fail(`Couldn't save the download in ${path.dirname(file)}: ${e.message}`);
  }
  let out;
  try {
    let res;
    try {
      res = await fetch(url, { headers: { "user-agent": "huntaway-desktop" }, signal: AbortSignal.timeout(30 * 60_000) });
    } catch (e) {
      throw fail(`Couldn't download ${path.basename(file)}: ${e.cause?.message ?? e.message}`);
    }
    if (!res.ok || !res.body) throw fail(`Couldn't download the package: ${url} answered ${res.status}.`);
    const total = Number(res.headers.get("content-length")) || size;
    let bytes = 0;
    onProgress(0, total);
    const count = new Transform({
      transform(chunk, _enc, done) {
        hash.update(chunk);
        bytes += chunk.length;
        onProgress(bytes, total);
        done(null, chunk);
      },
    });
    out = fs.createWriteStream(null, { fd });
    await pipeline(Readable.fromWeb(res.body), count, out);
    const got = hash.digest("hex");
    if (got !== sha256) throw fail(`The download of ${path.basename(url)} doesn't match its sha256 digest (got ${got}, expected ${sha256}).`);
  } catch (e) {
    // Once the stream has it, the stream closes it.
    if (!out) fs.closeSync(fd);
    fs.rmSync(file, { force: true });
    if (e.code && e.syscall) throw fail(`Couldn't save the download in ${path.dirname(file)}: ${e.message}`);
    if (e.userMessage) throw e;
    throw fail(`The download of ${path.basename(url)} was cut off: ${e.cause?.message ?? e.message}`);
  }
}

/** Whether `dir` takes new files and renames from this user. */
function writable(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Replace the AppImage `appimage` with the package: downloaded beside it under a temp name, made executable, then
 * renamed over it, so a cut-off download leaves the old one in place. The running app keeps its open file.
 */
async function updateAppImage({ appimage, pkg, onProgress, fetch }) {
  const dir = path.dirname(appimage);
  const yourself = "Download the new AppImage and put it in place yourself.";
  if (!writable(dir)) throw fail(`The app can't replace itself: ${dir} isn't writable by you. ${yourself}`);
  // A new private dir beside it (the same filesystem, for the rename), so no name in a shared dir is written through.
  let stage;
  try {
    stage = fs.mkdtempSync(path.join(dir, `.${path.basename(appimage)}.update-`));
  } catch (e) {
    throw fail(`The app can't replace itself: ${e.message}. ${yourself}`);
  }
  try {
    const tmp = path.join(stage, path.basename(appimage));
    await download({ url: pkg.url, file: tmp, sha256: pkg.sha256, size: pkg.size, onProgress, fetch });
    try {
      let mode = 0o755;
      try {
        mode = fs.statSync(appimage).mode & 0o7777;
      } catch {
        // It was moved away meanwhile: it's written anew.
      }
      fs.chmodSync(tmp, mode | 0o111);
      fs.renameSync(tmp, appimage);
    } catch (e) {
      throw fail(`The app couldn't replace ${appimage}: ${e.message}. ${yourself}`);
    }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

/** The last few lines of a command's output, for its error. */
const tail = (s, n = 6) => s.trim().split("\n").slice(-n).join("\n");

/**
 * Install the pacman package: download it into a temp dir, then `pkexec pacman -U --noconfirm <file>`, which asks for
 * the password in polkit's dialog. `onProgress(bytes, total)` during the download, then `onInstalling()`.
 */
async function updatePacman({ pkg, onProgress, onInstalling = () => {}, fetch, spawn = spawnProcess, tmpdir = os.tmpdir() }) {
  const dir = fs.mkdtempSync(path.join(tmpdir, "huntaway-update-"));
  const instead = "Install it with the sudo pacman command instead.";
  try {
    const file = path.join(dir, pkg.name);
    await download({ url: pkg.url, file, sha256: pkg.sha256, size: pkg.size, onProgress, fetch });
    onInstalling();
    const { code, output, error } = await new Promise((resolve) => {
      let output = "";
      let child;
      try {
        child = spawn("pkexec", ["pacman", "-U", "--noconfirm", file], { stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        resolve({ error });
        return;
      }
      child.stdout?.on("data", (d) => (output += d));
      child.stderr?.on("data", (d) => (output += d));
      child.once("error", (error) => resolve({ error, output }));
      child.once("close", (code, signal) => resolve({ code: code ?? signal, output }));
    });
    if (error?.code === "ENOENT") throw fail(`pkexec isn't installed, so the app can't ask for the password to install the package. ${instead}`);
    if (error) throw fail(`Couldn't run pkexec: ${error.message}. ${instead}`);
    // pkexec: 126 when the password dialog was dismissed (or the user isn't allowed), 127 when it couldn't ask at all.
    if (code === 126) throw fail(`The password prompt was cancelled, so nothing was installed. ${instead}`);
    if (code === 127) {
      const why = /authentication agent/i.test(output) ? "there's no polkit agent running to ask for the password" : `pkexec couldn't ask for the password${output.trim() ? ` (${tail(output, 2)})` : ""}`;
      throw fail(`The package wasn't installed: ${why}. ${instead}`);
    }
    if (code !== 0) throw fail(`pacman couldn't install the package (exit ${code})${output.trim() ? `:\n${tail(output)}` : "."}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Install the latest release's package for `kind` ("appimage" with `appimage` its file, or "pacman"), as reported by the
 * server at `base`. Reports progress with `onProgress({phase, bytes, total})`: "checking", "downloading", "installing".
 * Resolves once it's installed (the caller relaunches), rejects with an error for the user. `current` is this app's
 * version: an older release isn't installed.
 */
async function updateShell({ kind, appimage, base, token, current, api, repo, platform, onProgress = () => {}, fetch = globalThis.fetch, spawn, tmpdir }) {
  onProgress({ phase: "checking" });
  const { version } = await latestShellRelease({ base, token, current, fetch });
  const pkg = await findPackage({ api, repo, version, kind, platform, fetch });
  const downloading = (bytes, total) => onProgress({ phase: "downloading", version, bytes, total });
  if (kind === "appimage") {
    if (!appimage) throw fail("This app isn't running as an AppImage.");
    await updateAppImage({ appimage, pkg, onProgress: downloading, fetch });
  } else {
    await updatePacman({ pkg, onProgress: downloading, onInstalling: () => onProgress({ phase: "installing", version }), fetch, spawn, tmpdir });
  }
  return { version };
}

module.exports = { updateKind, assetPlatform, packageName, latestShellRelease, findPackage, download, updateAppImage, updatePacman, updateShell };
