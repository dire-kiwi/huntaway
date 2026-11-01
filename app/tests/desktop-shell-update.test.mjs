import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { assetPlatform, packageName, updateKind, updateShell } = require("../electron/shellupdate.cjs");

const cleanups = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-shell-update-"));
  cleanups.push(() => {
    fs.chmodSync(dir, 0o755);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const PLATFORM = "linux-x64";
const PACKAGE = Buffer.from("the new package ".repeat(10_000));

/**
 * A fake Huntaway server (GET /api/admin/server, needing the token) and GitHub (releases by tag, and downloads) on
 * 127.0.0.1. `release` is GitHub's release v0.3.0, `status` the server's release block; `requests` logs every path.
 */
async function fake({ release, status, tag = "v0.3.0", file = PACKAGE, cut = false } = {}) {
  const requests = [];
  const srv = http.createServer((req, res) => {
    requests.push(req.url);
    const json = (code, body, headers = {}) => {
      res.writeHead(code, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/api/admin/server") {
      if (req.headers.authorization !== "Bearer secret") return json(401, { error: "unauthorized" });
      return json(200, { release: status ?? { latest: { version: "0.3.0" }, shell: { outdated: true, install: "pacman", package: { url: `${base}/elsewhere` } } } });
    }
    if (req.url === `/repos/o/r/releases/tags/${tag}`) {
      if (release === "rate-limited") return json(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "2000000000" });
      return json(200, release ?? gh());
    }
    if (req.url.startsWith("/download/")) {
      res.writeHead(200, { "content-length": file.length });
      // A connection that drops halfway.
      if (cut) return res.write(file.subarray(0, file.length / 2), () => res.destroy());
      return res.end(file);
    }
    json(404, { message: "Not Found" });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  cleanups.push(() => new Promise((r) => srv.close(r)));
  const base = `http://127.0.0.1:${srv.address().port}`;
  /** GitHub's release, with every package and its digest (`digest` overrides it). */
  function gh(digest = `sha256:${sha256(PACKAGE)}`) {
    const asset = (name) => ({ name, browser_download_url: `${base}/download/${name}`, size: PACKAGE.length, digest });
    return {
      tag_name: tag,
      assets: [asset(`huntaway-0.3.0-${PLATFORM}.pacman`), asset("huntaway-0.3.0-linux-x86_64.AppImage"), asset("huntaway-server-0.3.0-linux-x64.tar.gz")],
    };
  }
  return { base, requests, gh };
}

/** updateShell against the fake, with the progress it reported. */
async function run(f, opts) {
  const progress = [];
  const promise = updateShell({ base: f.base, token: "secret", api: f.base, repo: "o/r", platform: PLATFORM, onProgress: (p) => progress.push(p), ...opts });
  return { promise, progress };
}

/** A stub pkexec on PATH that logs its arguments and the package's hash, then prints `out` and exits with `code`. */
function stubPkexec(code, out = "") {
  const dir = tmp();
  const log = path.join(dir, "log");
  fs.writeFileSync(
    path.join(dir, "pkexec"),
    `#!/bin/sh\necho "$@" > ${log}\nsha256sum "$4" | cut -d' ' -f1 >> ${log}\nprintf '%s' '${out}' >&2\nexit ${code}\n`,
    { mode: 0o755 },
  );
  const spawnWith = (cmd, args, o) => spawn(cmd, args, { ...o, env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
  return { spawn: spawnWith, log: () => fs.readFileSync(log, "utf8").trim().split("\n") };
}

test("which installs the app updates itself", () => {
  assert.equal(updateKind("appimage:/home/me/Huntaway.AppImage"), "appimage");
  assert.equal(updateKind("pacman"), "pacman");
  for (const other of ["mac:/Applications/Huntaway.app", "other", undefined]) assert.equal(updateKind(other), null);
  assert.equal(assetPlatform("linux", "x64"), "linux-x64");
  assert.equal(assetPlatform("darwin", "arm64"), "mac-arm64");
  // As electron-builder names them (see the v0.1.0 release).
  assert.equal(packageName("appimage", "0.1.0", "linux-x64"), "huntaway-0.1.0-linux-x86_64.AppImage");
  assert.equal(packageName("appimage", "0.1.0", "linux-arm64"), "huntaway-0.1.0-linux-arm64.AppImage");
  assert.equal(packageName("pacman", "0.1.0", "linux-x64"), "huntaway-0.1.0-linux-x64.pacman");
});

test("an AppImage is replaced in place by the verified download", async () => {
  const f = await fake();
  const dir = tmp();
  const appimage = path.join(dir, "Huntaway.AppImage");
  fs.writeFileSync(appimage, "old", { mode: 0o750 });
  const { promise, progress } = await run(f, { kind: "appimage", appimage });
  assert.deepEqual(await promise, { version: "0.3.0" });
  assert.equal(sha256(fs.readFileSync(appimage)), sha256(PACKAGE));
  assert.equal(fs.statSync(appimage).mode & 0o777, 0o751, "it keeps its mode, and is executable");
  assert.deepEqual(fs.readdirSync(dir), ["Huntaway.AppImage"], "no temp file is left");
  // The package is GitHub's, not the URL the server's status has.
  assert.ok(f.requests.includes("/download/huntaway-0.3.0-linux-x86_64.AppImage"));
  assert.ok(!f.requests.includes("/elsewhere"));
  assert.equal(progress[0].phase, "checking");
  const last = progress.at(-1);
  assert.deepEqual(last, { phase: "downloading", version: "0.3.0", bytes: PACKAGE.length, total: PACKAGE.length });
});

test("a download that doesn't match its digest leaves the AppImage as it was", async () => {
  const f = await fake({ file: Buffer.from("tampered") });
  const dir = tmp();
  const appimage = path.join(dir, "Huntaway.AppImage");
  fs.writeFileSync(appimage, "old", { mode: 0o755 });
  const { promise } = await run(f, { kind: "appimage", appimage });
  await assert.rejects(promise, /doesn't match its sha256 digest/);
  assert.equal(fs.readFileSync(appimage, "utf8"), "old");
  assert.deepEqual(fs.readdirSync(dir), ["Huntaway.AppImage"]);
});

test("a download cut off halfway leaves the AppImage as it was", async () => {
  const f = await fake({ cut: true });
  const dir = tmp();
  const appimage = path.join(dir, "Huntaway.AppImage");
  fs.writeFileSync(appimage, "old", { mode: 0o755 });
  const { promise } = await run(f, { kind: "appimage", appimage });
  await assert.rejects(promise, /was cut off/);
  assert.equal(fs.readFileSync(appimage, "utf8"), "old");
  assert.deepEqual(fs.readdirSync(dir), ["Huntaway.AppImage"]);
});

test("an AppImage in a folder the user can't write says so before downloading", { skip: process.getuid?.() === 0 && "root writes anywhere" }, async () => {
  const f = await fake();
  const dir = tmp();
  const appimage = path.join(dir, "Huntaway.AppImage");
  fs.writeFileSync(appimage, "old", { mode: 0o755 });
  fs.chmodSync(dir, 0o555);
  const { promise } = await run(f, { kind: "appimage", appimage });
  await assert.rejects(promise, (e) => e.message.includes(`${dir} isn't writable`));
  assert.ok(!f.requests.some((r) => r.startsWith("/download/")));
  assert.equal(fs.readFileSync(appimage, "utf8"), "old");
});

test("pacman installs the verified download with pkexec, then cleans up", async () => {
  const f = await fake();
  const tmpdir = tmp();
  const pkexec = stubPkexec(0);
  const { promise, progress } = await run(f, { kind: "pacman", spawn: pkexec.spawn, tmpdir });
  assert.deepEqual(await promise, { version: "0.3.0" });
  const [args, hash] = pkexec.log();
  const file = path.join(fs.realpathSync(tmpdir), "x").replace(/x$/, "");
  assert.match(args, new RegExp(`^pacman -U --noconfirm ${file}huntaway-update-\\w+/huntaway-0\\.3\\.0-${PLATFORM}\\.pacman$`));
  assert.equal(hash, sha256(PACKAGE));
  assert.equal(progress.at(-1).phase, "installing");
  assert.deepEqual(fs.readdirSync(tmpdir), [], "the download is removed");
});

test("a cancelled password prompt, no polkit agent, or a pacman failure says so, with the command to run", async () => {
  for (const [code, out, expect] of [
    [126, "", /The password prompt was cancelled/],
    [127, "Error executing command as another user: No authentication agent found.", /there's no polkit agent running/],
    [1, "error: failed to commit transaction (conflicting files)", /pacman couldn't install the package \(exit 1\):\nerror: failed to commit transaction/],
  ]) {
    const f = await fake();
    const tmpdir = tmp();
    const { promise } = await run(f, { kind: "pacman", spawn: stubPkexec(code, out).spawn, tmpdir });
    await assert.rejects(promise, (e) => {
      assert.match(e.message, expect);
      if (code !== 1) assert.match(e.message, /Install it with the sudo pacman command instead\.$/);
      return true;
    });
    assert.deepEqual(fs.readdirSync(tmpdir), []);
  }
  // No pkexec at all.
  const f = await fake();
  const tmpdir = tmp();
  const none = (cmd, args, o) => spawn(cmd, args, { ...o, env: { PATH: tmp() } });
  const { promise } = await run(f, { kind: "pacman", spawn: none, tmpdir });
  await assert.rejects(promise, /pkexec isn't installed/);
  assert.deepEqual(fs.readdirSync(tmpdir), []);
});

test("nothing is installed when the server has no newer shell, or GitHub can't vouch for the package", async () => {
  const appimage = path.join(tmp(), "Huntaway.AppImage");
  fs.writeFileSync(appimage, "old");
  const cases = [
    [{ status: { latest: { version: "0.3.0" }, shell: { outdated: false } } }, /already has v0\.3\.0's shell/],
    [{ status: { latest: null, shell: null } }, /hasn't found a release yet/],
    [{ status: null, release: { tag_name: "v0.3.0", assets: [] } }, /Release v0\.3\.0 has no huntaway-0\.3\.0-linux-x86_64\.AppImage/],
    [{ release: "rate-limited" }, /rate limit for this address is used up/],
  ];
  for (const [opts, expect] of cases) {
    const f = await fake(opts);
    await assert.rejects((await run(f, { kind: "appimage", appimage })).promise, expect);
  }
  // An asset without a sha256 digest.
  let f = await fake();
  const undigested = f.gh(null);
  f = await fake({ release: undigested });
  await assert.rejects((await run(f, { kind: "appimage", appimage })).promise, /no sha256 digest/);
  assert.ok(!f.requests.some((r) => r.startsWith("/download/")));
  // The wrong token: the server refuses.
  await assert.rejects((await run(f, { kind: "appimage", appimage, token: "wrong" })).promise, /answered 401/);
  assert.equal(fs.readFileSync(appimage, "utf8"), "old");
});

test("a release tagged without a v is found too", async () => {
  const f = await fake({ tag: "0.3.0" });
  const appimage = path.join(tmp(), "Huntaway.AppImage");
  fs.writeFileSync(appimage, "old");
  assert.deepEqual(await (await run(f, { kind: "appimage", appimage })).promise, { version: "0.3.0" });
  assert.deepEqual(
    f.requests.filter((r) => r.includes("/tags/")),
    ["/repos/o/r/releases/tags/v0.3.0", "/repos/o/r/releases/tags/0.3.0"],
  );
});
