// Which server a release build starts: one of the versions the server downloaded into `<data dir>/app/`, or the one in
// its own resources. The server (server/src/release.rs) unpacks each release into `app/<v>/` ({huntaway, ia-shim,
// ui/index.html}) and keeps `app/state.json`:
//
//   current   the version that last came up (the server sets it once it's listening)
//   previous  the one before it, kept for a rollback
//   staged    downloaded and checked, waiting for a click on Update: never started from here
//   trying    the one an Update is exec'ing into; the server clears it once that one is listening
//   bad       versions that didn't start, which are passed over
//
// Both processes write the file through a temp file and a rename, and keep each other's keys. The shell writes it only
// to mark versions bad, once the server it started has come up (startWithFallback): the server settles the file just
// before it says it's ready, and doesn't write it again until a release check, so the two don't race in practice.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** `v` as [major, minor, patch, prerelease identifiers], or null when it isn't semver. */
function parseVersion(v) {
  const m = typeof v === "string" ? v.trim().match(SEMVER) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? m[4].split(".") : []] : null;
}

/** Semver precedence of two versions (negative, 0 or positive), or NaN when either isn't semver. 1.0.0-rc.1 < 1.0.0. */
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return NaN;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  const [p, q] = [x[3], y[3]];
  // A release is above its prereleases.
  if (!p.length || !q.length) return q.length - p.length;
  for (let i = 0; i < Math.min(p.length, q.length); i++) {
    if (p[i] === q[i]) continue;
    const [n, m] = [/^\d+$/.test(p[i]), /^\d+$/.test(q[i])];
    // Numeric identifiers compare as numbers, and below alphanumeric ones.
    if (n && m) return Number(p[i]) - Number(q[i]);
    if (n !== m) return n ? -1 : 1;
    return p[i] < q[i] ? -1 : 1;
  }
  return p.length - q.length;
}

function statePath(appDir) {
  return path.join(appDir, "state.json");
}

/** `app/state.json`, or {} when there's none (no version downloaded yet) or it can't be read. */
function readState(appDir) {
  try {
    const state = JSON.parse(fs.readFileSync(statePath(appDir), "utf8"));
    return state && typeof state === "object" && !Array.isArray(state) ? state : {};
  } catch {
    return {};
  }
}

/** Write `state` through a temp file and a rename, so that the server never reads half of it. */
function writeState(appDir, state) {
  const file = statePath(appDir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/** Add `version` to `bad` and, if it's the one being tried, clear `trying`. Keeps the keys this doesn't know. */
function markBad(appDir, version) {
  const state = readState(appDir);
  const bad = Array.isArray(state.bad) ? state.bad : [];
  if (!bad.includes(version)) bad.push(version);
  const next = { ...state, bad };
  if (next.trying === version) next.trying = null;
  writeState(appDir, next);
}

/** The files a version needs: its server, the shim its agents run under, and the UI it serves. */
function installedFiles(dir, exe) {
  return [path.join(dir, exe), path.join(dir, exe.replace(/^huntaway/, "ia-shim")), path.join(dir, "ui", "index.html")];
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * The server for a release build to start: `trying`, then `current`, then `previous`, the first that is at least as
 * new as the app (`minVersion`, so a newer package wins over older downloads), isn't bad (in `state.bad` or `skip`) and
 * has all its files; otherwise the bundled one. `staged` is never started: it waits for Update.
 *
 * Returns {bin, version, dir} for an installed version, {bin, version: null} for the bundled server.
 */
function chooseServer({ appDir, bundled, minVersion, exe = "huntaway", skip = [] }) {
  const state = readState(appDir);
  const bad = new Set([...(Array.isArray(state.bad) ? state.bad : []), ...skip]);
  for (const v of [state.trying, state.current, state.previous]) {
    if (typeof v !== "string" || bad.has(v) || !(compareVersions(v, minVersion) >= 0)) continue;
    // Semver has no slashes or dots on their own, so the version can't lead out of app/.
    const dir = path.join(appDir, v);
    if (installedFiles(dir, exe).every(isFile)) return { bin: path.join(dir, exe), version: v, dir };
  }
  return { bin: bundled, version: null };
}

/**
 * Start a server: the one `choose(skip)` picks, and if that's an installed version (`choice.version`) that exits before
 * it's ready (`start` rejects with `early`), the next one, at once. Resolves with {token, choice}.
 *
 * `failed` holds the versions that failed this way (the caller keeps it, and adds `trying` and any version that exits
 * after `start` gave up waiting on it). They're skipped, and saved with `saveBad` once a server has come up, which
 * shows the failure was theirs. It's cleared, without saving, when it can't be told whose the failure was:
 *   - no server is left to try (choose throws), or the bundled or an override server fails too: every server fails
 *     the same way, a wrong host say;
 *   - something answers on the port after a failure (`portTaken`): another launch's server took it;
 *   - the app is quitting (`stopping`).
 *
 * A timeout (a rejection without `early`) keeps `failed`, as that server is still starting and only slow, which isn't
 * held against it. If it exits, the caller adds it and starts again. If it comes up (the rejection's `ready` resolves,
 * for the same child while it's still the latest start), the failures are saved then.
 */
async function startWithFallback({ choose, start, portTaken, failed, saveBad, stopping = () => false }) {
  const giveUp = (e) => {
    failed.clear();
    throw e;
  };
  const save = () => {
    for (const v of failed) saveBad(v);
    failed.clear();
  };
  for (;;) {
    let choice;
    try {
      choice = choose([...failed]);
    } catch (e) {
      giveUp(e);
    }
    let token;
    try {
      token = await start(choice);
    } catch (e) {
      if (!e.early) {
        e.ready?.then(() => stopping() || save());
        throw e;
      }
      if (!choice.version || stopping() || (await portTaken())) giveUp(e);
      failed.add(choice.version);
      continue;
    }
    save();
    return { token, choice };
  }
}

/**
 * How this app was installed, for the server's shell updates (IA_DESKTOP_INSTALL): `appimage:<file>`, `pacman` (the
 * package's files in /opt, owned by pacman), `mac:<.app>`, or `other`. `pacmanOwns` is for tests.
 */
function installKind({ platform = process.platform, env = process.env, resourcesPath, pacmanOwns = ownedByPacman }) {
  if (env.APPIMAGE) return `appimage:${env.APPIMAGE}`;
  if (platform === "darwin") {
    const bundle = path.resolve(resourcesPath, "..", "..");
    if (bundle.endsWith(".app")) return `mac:${bundle}`;
  }
  if (platform === "linux" && resourcesPath.startsWith("/opt/") && pacmanOwns(resourcesPath)) return "pacman";
  return "other";
}

function ownedByPacman(file) {
  try {
    execFileSync("pacman", ["-Qqo", file], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false; // not owned, or no pacman
  }
}

/**
 * The environment that turns release updates on for a server a release build starts. IA_RELEASE_UPDATES and
 * IA_RELEASE_API in the shell's own environment win, for tests; a blank IA_RELEASE_UPDATES turns them off. It's the
 * environment rather than --release-updates so that an older bundled server, which has no such flag, ignores it.
 */
function releaseEnv({ env = process.env, version, shell, install, bundled }) {
  return {
    IA_RELEASE_UPDATES: env.IA_RELEASE_UPDATES ?? "dire-kiwi/huntaway",
    IA_DESKTOP_VERSION: version,
    IA_DESKTOP_SHELL: shell,
    IA_DESKTOP_INSTALL: install,
    IA_BUNDLED_SERVER: bundled,
  };
}

module.exports = { parseVersion, compareVersions, readState, writeState, markBad, chooseServer, startWithFallback, installKind, releaseEnv };
