import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chooseServer, compareVersions, installKind, markBad, readState, releaseEnv, writeState } = require("../electron/versions.cjs");

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A data dir's app/ with `versions` installed (all three files, or those in `files`) and `state` in state.json. */
function appDir(state, versions = [], files = ["huntaway", "ia-shim", "ui/index.html"]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-versions-"));
  dirs.push(dir);
  for (const v of versions) {
    for (const f of files) {
      fs.mkdirSync(path.dirname(path.join(dir, v, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, v, f), "");
    }
  }
  if (state) writeState(dir, state);
  return dir;
}

const BUNDLED = "/opt/Huntaway/resources/huntaway";
const choose = (dir, minVersion = "0.1.0", skip = []) => chooseServer({ appDir: dir, bundled: BUNDLED, minVersion, skip });

test("the current version runs rather than the bundled one, unless the package is newer", () => {
  const dir = appDir({ current: "0.2.0", previous: "0.1.1", bad: [] }, ["0.2.0", "0.1.1"]);
  assert.deepEqual(choose(dir), { bin: path.join(dir, "0.2.0", "huntaway"), version: "0.2.0", dir: path.join(dir, "0.2.0") });
  // The same version as the package's is still the downloaded one.
  assert.equal(choose(dir, "0.2.0").version, "0.2.0");
  // A pacman upgrade to 0.3.0 wins over both downloads.
  assert.deepEqual(choose(dir, "0.3.0"), { bin: BUNDLED, version: null });
  // Between the two, the previous one is too old as well.
  assert.deepEqual(choose(dir, "0.2.1"), { bin: BUNDLED, version: null });
});

test("without an app dir or state.json, the bundled server runs", () => {
  assert.deepEqual(choose(path.join(os.tmpdir(), "ia-versions-none")), { bin: BUNDLED, version: null });
  assert.deepEqual(choose(appDir(null, ["0.2.0"])), { bin: BUNDLED, version: null });
  const broken = appDir(null, ["0.2.0"]);
  fs.writeFileSync(path.join(broken, "state.json"), "{not json");
  assert.deepEqual(choose(broken), { bin: BUNDLED, version: null });
  assert.deepEqual(readState(broken), {});
});

test("bad versions are passed over, and a staged one is never started", () => {
  const dir = appDir({ current: "0.3.0", previous: "0.2.0", staged: "0.4.0", bad: ["0.3.0"] }, ["0.4.0", "0.3.0", "0.2.0"]);
  assert.equal(choose(dir).version, "0.2.0");
  // One that failed just now, before state.json says so.
  assert.deepEqual(choose(dir, "0.1.0", ["0.2.0"]), { bin: BUNDLED, version: null });
  // Only staged: the bundled one runs until Update.
  assert.deepEqual(choose(appDir({ staged: "0.4.0" }, ["0.4.0"])), { bin: BUNDLED, version: null });
});

test("trying comes first, and once it's marked bad (nothing came up) the current one runs", () => {
  const dir = appDir({ current: "0.2.0", previous: "0.1.1", trying: "0.3.0", bad: ["0.0.9"], extra: { kept: true } }, ["0.3.0", "0.2.0", "0.1.1"]);
  assert.equal(choose(dir).version, "0.3.0");
  markBad(dir, "0.3.0");
  assert.equal(choose(dir).version, "0.2.0");
  // The keys the shell doesn't know are kept, and nothing is added twice.
  markBad(dir, "0.3.0");
  assert.deepEqual(readState(dir), { current: "0.2.0", previous: "0.1.1", trying: null, bad: ["0.0.9", "0.3.0"], extra: { kept: true } });
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
  // Marking another version bad leaves trying alone.
  const other = appDir({ current: "0.2.0", trying: "0.3.0" }, ["0.3.0", "0.2.0"]);
  markBad(other, "0.2.0");
  assert.deepEqual(readState(other), { current: "0.2.0", trying: "0.3.0", bad: ["0.2.0"] });
  // A state.json without `bad`.
  const fresh = appDir({ current: "0.2.0" }, ["0.2.0"]);
  markBad(fresh, "0.2.0");
  assert.deepEqual(choose(fresh), { bin: BUNDLED, version: null });
});

test("a version missing any of its files is passed over", () => {
  for (const missing of ["huntaway", "ia-shim", "ui/index.html"]) {
    const files = ["huntaway", "ia-shim", "ui/index.html"].filter((f) => f !== missing);
    const dir = appDir({ current: "0.3.0", previous: "0.2.0" }, ["0.3.0"], files);
    for (const f of ["huntaway", "ia-shim", "ui/index.html"]) {
      fs.mkdirSync(path.dirname(path.join(dir, "0.2.0", f)), { recursive: true });
      fs.writeFileSync(path.join(dir, "0.2.0", f), "");
    }
    assert.equal(choose(dir).version, "0.2.0", `without ${missing}`);
  }
  // A dir where the binary should be isn't one.
  const dir = appDir({ current: "0.3.0" }, ["0.3.0"], ["ia-shim", "ui/index.html", "huntaway/x"]);
  assert.deepEqual(choose(dir), { bin: BUNDLED, version: null });
});

test("versions that aren't semver are never started", () => {
  const dir = appDir({ current: "../0.2.0", previous: "latest", trying: 3 }, ["0.2.0"]);
  assert.deepEqual(choose(dir), { bin: BUNDLED, version: null });
});

test("versions compare as semver, prereleases below their release", () => {
  const ordered = ["0.9.0", "0.10.0-alpha", "0.10.0-alpha.1", "0.10.0-alpha.beta", "0.10.0-beta", "0.10.0-beta.2", "0.10.0-beta.11", "0.10.0-rc.1", "0.10.0", "0.10.1", "1.0.0"];
  for (let i = 0; i < ordered.length; i++) {
    for (let j = 0; j < ordered.length; j++) {
      assert.equal(Math.sign(compareVersions(ordered[i], ordered[j])), Math.sign(i - j), `${ordered[i]} vs ${ordered[j]}`);
    }
  }
  assert.equal(compareVersions("v1.2.3", "1.2.3+build.5"), 0);
  assert.ok(Number.isNaN(compareVersions("1.2", "1.2.0")));
  // An rc of the package's own version is older than the package.
  const dir = appDir({ current: "0.2.0-rc.1" }, ["0.2.0-rc.1"]);
  assert.equal(choose(dir, "0.2.0").version, null);
  assert.equal(choose(dir, "0.2.0-beta.3").version, "0.2.0-rc.1");
});

test("the install kind and the environment for a release build's server", () => {
  const never = () => assert.fail("pacman isn't asked");
  assert.equal(installKind({ platform: "linux", env: { APPIMAGE: "/home/u/Huntaway.AppImage" }, resourcesPath: "/tmp/.mount_x/resources", pacmanOwns: never }), "appimage:/home/u/Huntaway.AppImage");
  assert.equal(installKind({ platform: "linux", env: {}, resourcesPath: "/opt/Huntaway/resources", pacmanOwns: () => true }), "pacman");
  assert.equal(installKind({ platform: "linux", env: {}, resourcesPath: "/opt/Huntaway/resources", pacmanOwns: () => false }), "other");
  assert.equal(installKind({ platform: "linux", env: {}, resourcesPath: "/home/u/huntaway/resources", pacmanOwns: never }), "other");
  assert.equal(installKind({ platform: "darwin", env: {}, resourcesPath: "/Applications/Huntaway.app/Contents/Resources", pacmanOwns: never }), "mac:/Applications/Huntaway.app");

  const desktop = { version: "0.2.0", shell: "abc", install: "pacman", bundled: BUNDLED };
  assert.deepEqual(releaseEnv({ env: {}, ...desktop }), {
    IA_RELEASE_UPDATES: "dire-kiwi/huntaway",
    IA_DESKTOP_VERSION: "0.2.0",
    IA_DESKTOP_SHELL: "abc",
    IA_DESKTOP_INSTALL: "pacman",
    IA_BUNDLED_SERVER: BUNDLED,
  });
  assert.equal(releaseEnv({ env: { IA_RELEASE_UPDATES: "me/fork" }, ...desktop }).IA_RELEASE_UPDATES, "me/fork");
  // Blank turns them off (the server takes a blank IA_RELEASE_UPDATES as none).
  assert.equal(releaseEnv({ env: { IA_RELEASE_UPDATES: "" }, ...desktop }).IA_RELEASE_UPDATES, "");
});
