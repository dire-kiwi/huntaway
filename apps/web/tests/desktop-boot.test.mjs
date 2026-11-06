import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "vite-plus/test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const boot = require("../electron/boot.cjs");
const { chooseServer, compareVersions } = require("../electron/versions.cjs");
const { frameStamp, shellChange, shellStamp } = require("../electron/stamp.cjs");

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const ELECTRON = "45.0.3";

/**
 * A data dir's app/ with `state` in state.json, and each of `versions` installed with its server files and, unless
 * `shell` is false, a shell (main.cjs and a shell.json, `meta` by default).
 */
function appDir(state, versions = [], { shell = true, meta = { electron: ELECTRON, boot: 1 } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-boot-"));
  dirs.push(dir);
  const files = ["huntaway", "ia-shim", "ui/index.html", ...(shell ? ["electron/main.cjs"] : [])];
  for (const v of versions) {
    for (const f of files) {
      fs.mkdirSync(path.dirname(path.join(dir, v, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, v, f), "");
    }
    if (shell) fs.writeFileSync(path.join(dir, v, "electron", "shell.json"), JSON.stringify(meta));
  }
  if (state) fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state));
  return dir;
}

const choose = (dir, appVersion = "0.1.0", electronVersion = ELECTRON) => boot.chooseShell({ appDir: dir, appVersion, electronVersion });
const shellOf = (dir, v) => ({ dir: path.join(dir, v, "electron"), version: v });

test("the shell of the version the server runs is loaded", () => {
  const dir = appDir({ current: "0.2.0", previous: "0.1.1" }, ["0.2.0", "0.1.1"]);
  assert.deepEqual(choose(dir), shellOf(dir, "0.2.0"));
  // An Update that is still coming up (trying) is the server about to run.
  assert.deepEqual(choose(appDir({ trying: "0.3.0", current: "0.2.0" }, ["0.3.0", "0.2.0"])).version, "0.3.0");
});

test("the package's own shell is used without a downloaded version, or when the package is newer", () => {
  assert.equal(choose(path.join(os.tmpdir(), "ia-boot-none")), null);
  assert.equal(choose(appDir(null, ["0.2.0"])), null);
  // Only staged: waiting for Update.
  assert.equal(choose(appDir({ staged: "0.2.0" }, ["0.2.0"])), null);
  // A pacman upgrade to 0.3.0 takes over from older downloads, as it does for the server.
  assert.equal(choose(appDir({ current: "0.2.0" }, ["0.2.0"]), "0.3.0"), null);
});

test("the shell follows the server's choice: a bad or incomplete version is passed over, a shell-less one isn't skipped for an older one", () => {
  const bad = appDir({ current: "0.3.0", previous: "0.2.0", bad: ["0.3.0"] }, ["0.3.0", "0.2.0"]);
  assert.equal(choose(bad).version, "0.2.0");
  // A version missing its server files isn't the server's, whatever shell it has.
  const incomplete = appDir({ current: "0.3.0", previous: "0.2.0" }, ["0.2.0"]);
  fs.mkdirSync(path.join(incomplete, "0.3.0", "electron"), { recursive: true });
  fs.writeFileSync(path.join(incomplete, "0.3.0", "electron", "main.cjs"), "");
  assert.equal(choose(incomplete).version, "0.2.0");
  // A release from before shells were shipped: the package's shell, not the previous version's.
  const old = appDir({ current: "0.3.0", previous: "0.2.0" }, ["0.2.0"]);
  for (const f of ["huntaway", "ia-shim", "ui/index.html"]) {
    fs.mkdirSync(path.dirname(path.join(old, "0.3.0", f)), { recursive: true });
    fs.writeFileSync(path.join(old, "0.3.0", f), "");
  }
  assert.equal(choose(old), null);
  // It picks the version chooseServer does.
  assert.equal(chooseServer({ appDir: old, bundled: "/b", minVersion: "0.1.0" }).version, "0.3.0");
});

test("a shell for another Electron, or needing a newer boot.cjs, isn't loaded", () => {
  assert.equal(choose(appDir({ current: "0.2.0" }, ["0.2.0"], { meta: { electron: "46.0.0", boot: 1 } })), null);
  assert.equal(choose(appDir({ current: "0.2.0" }, ["0.2.0"], { meta: { electron: "45.9.9", boot: 1 } })).version, "0.2.0");
  assert.equal(choose(appDir({ current: "0.2.0" }, ["0.2.0"], { meta: { electron: ELECTRON, boot: boot.BOOT_API + 1 } })), null);
  assert.equal(choose(appDir({ current: "0.2.0" }, ["0.2.0"], { meta: { electron: ELECTRON } })), null);
  const noMeta = appDir({ current: "0.2.0" }, ["0.2.0"]);
  fs.rmSync(path.join(noMeta, "0.2.0", "electron", "shell.json"));
  assert.equal(choose(noMeta), null);
});

test("a shell marked bad isn't loaded again, and the server's version stays the one it picks", () => {
  const dir = appDir({ current: "0.3.0", previous: "0.2.0" }, ["0.3.0", "0.2.0"]);
  boot.markShellBad(dir, "0.3.0");
  assert.equal(choose(dir), null);
  assert.deepEqual(boot.readShellState(dir).bad, ["0.3.0"]);
  // state.json's own bad list is separate: the server isn't blamed for its shell.
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")).bad, undefined);
  boot.markShellBad(dir, "0.3.0");
  assert.deepEqual(boot.readShellState(dir).bad, ["0.3.0"]);
});

test("a shell whose process died while it ran is marked bad, unless that process is still running", () => {
  const dir = appDir({ current: "0.2.0" }, ["0.2.0"]);
  boot.writeShellState(dir, { trying: { version: "0.2.0", pid: 2 ** 22 + 12345 } });
  assert.equal(boot.settleCrash(dir), false);
  assert.deepEqual(boot.readShellState(dir).bad, ["0.2.0"]);
  assert.equal(boot.readShellState(dir).trying, undefined);

  // Another app process (the test runner's parent is as good as any) still has its shell loaded.
  const other = appDir({ current: "0.2.0" }, ["0.2.0"]);
  boot.writeShellState(other, { trying: { version: "0.2.0", pid: process.ppid } });
  assert.equal(boot.settleCrash(other), true);
  assert.equal(boot.readShellState(other).bad, undefined);
  assert.equal(choose(other).version, "0.2.0");

  assert.equal(boot.settleCrash(appDir(null)), false);
});

test("boot.cjs compares versions as versions.cjs does", () => {
  const vs = ["0.1.0", "0.9.0", "0.10.0", "1.0.0-rc.1", "1.0.0-rc.2", "1.0.0-alpha", "1.0.0", "v1.0.1", "nope"];
  for (const a of vs)
    for (const b of vs)
      assert.equal(
        Object.is(boot.compareVersions(a, b), NaN) ? "nan" : Math.sign(boot.compareVersions(a, b)),
        Object.is(compareVersions(a, b), NaN) ? "nan" : Math.sign(compareVersions(a, b)),
        `${a} vs ${b}`,
      );
});

test("the data dir is found as the server and main.cjs do", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ia-boot-home-"));
  dirs.push(home);
  const at = (config, env = {}, platform = "linux") => boot.dataDir(config, { env, platform, home });
  assert.equal(at({}, { IA_DATA_DIR: "/x" }), "/x");
  assert.equal(at({ dataDir: "~/d" }), path.join(home, "d"));
  assert.equal(at({}), path.join(home, ".local/share/huntaway"));
  assert.equal(at({}, { XDG_DATA_HOME: "/xdg" }), "/xdg/huntaway");
  assert.equal(at({}, {}, "darwin"), path.join(home, "Library/Application Support/huntaway"));
  // The folder from before the rename, while it's the only one.
  fs.mkdirSync(path.join(home, ".local/share/issue-agent"), { recursive: true });
  assert.equal(at({}), path.join(home, ".local/share/issue-agent"));
});

test("the frame stamp changes with boot.cjs and Electron, not with the rest of the shell", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-frame-"));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, "boot.cjs"), "boot");
  fs.writeFileSync(path.join(dir, "main.cjs"), "main");
  const frame = frameStamp(dir, "45.0.3");
  const shell = shellStamp(dir, "45.0.3");
  fs.writeFileSync(path.join(dir, "main.cjs"), "main, changed");
  fs.writeFileSync(path.join(dir, "preload.cjs"), "new file");
  assert.equal(frameStamp(dir, "45.0.3"), frame);
  assert.notEqual(shellStamp(dir, "45.0.3"), shell);
  assert.notEqual(frameStamp(dir, "45.0.4"), frame);
  fs.writeFileSync(path.join(dir, "boot.cjs"), "boot, changed");
  assert.notEqual(frameStamp(dir, "45.0.3"), frame);
});

test("loading boot.cjs outside Electron does nothing", () => {
  // The module would have run boot() against a missing `app` otherwise; reaching this line is the test.
  assert.equal(typeof boot.chooseShell, "function");
});

/** What main.cjs's did-finish-load asks: boot.cjs's view of the app dir, and a stamp of the running shell's folder. */
function relaunchCheck(dir, running, startStamp) {
  const params = { appDir: dir, appVersion: "0.1.0", electronVersion: ELECTRON };
  return shellChange({ boot: { running, choose: () => boot.chooseShell(params) }, stampNow: () => shellStamp(running.dir, ELECTRON), startStamp });
}

test("a Roll back that deleted the running shell relaunches the app rather than throwing", () => {
  const dir = appDir({ current: "0.3.0", previous: "0.2.0" }, ["0.3.0", "0.2.0"]);
  const running = shellOf(dir, "0.3.0");
  const started = shellStamp(running.dir, ELECTRON);
  assert.equal(relaunchCheck(dir, running, started), null);
  // Roll back marks 0.3.0 bad and makes 0.2.0 current, then the server prunes 0.3.0 (staging::prune).
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ current: "0.2.0", bad: ["0.3.0"] }));
  fs.rmSync(path.join(dir, "0.3.0"), { recursive: true });
  assert.throws(() => shellStamp(running.dir, ELECTRON), /ENOENT/);
  assert.match(relaunchCheck(dir, running, started), /different desktop shell/);
  // Back to the package's shell: nothing left to load.
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ current: "0.1.0" }));
  assert.match(relaunchCheck(dir, running, started), /different desktop shell/);
});

test("a shell loaded from a release isn't hashed, and a checkout still relaunches on a change", () => {
  const dir = appDir({ current: "0.2.0" }, ["0.2.0"]);
  const running = shellOf(dir, "0.2.0");
  const params = { appDir: dir, appVersion: "0.1.0", electronVersion: ELECTRON };
  const stampNow = () => {
    throw new Error("a release's shell folder never changes in place, and may be gone");
  };
  assert.equal(shellChange({ boot: { running, choose: () => boot.chooseShell(params) }, stampNow, startStamp: "a" }), null);
  // No boot.cjs (a checkout): the stamp decides, and unreadable files aren't a change.
  assert.equal(shellChange({ boot: undefined, stampNow: () => "b", startStamp: "a" }), "the desktop app changed on disk");
  assert.equal(shellChange({ boot: undefined, stampNow: () => "a", startStamp: "a" }), null);
  assert.equal(
    shellChange({
      boot: undefined,
      stampNow: () => {
        throw new Error("ENOENT");
      },
      startStamp: "a",
    }),
    null,
  );
  // The package's own shell in a release build (running null): the stamp still applies.
  assert.equal(shellChange({ boot: { running: null, choose: () => null }, stampNow: () => "b", startStamp: "a" }), "the desktop app changed on disk");
});
