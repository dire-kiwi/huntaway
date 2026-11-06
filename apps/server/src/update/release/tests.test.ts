// Port of server/src/update/release/tests.rs.
import { afterAll, test } from "vite-plus/test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import * as db from "../../db.ts";
import * as db_file from "../../db/file.ts";
import { dispatch, makeReq, router } from "../../api.ts";
import type { AppState } from "../../state.ts";
import * as testing from "../../testing.ts";
import { new_id, path_str, sleep } from "../../util.ts";
import { VERSION } from "../../hosts/proto.ts";
import * as admin from "../admin.ts";
import * as staging from "../staging.ts";
import type { Download, Installed } from "../staging.ts";
import { check, GhAsset_from_json, GhRelease_from_json, package_name, parse_version, PRERELEASES, shell, status, Config_from_env } from "../release.ts";
import type { Config, Latest } from "../release.ts";

/** How a test's exec fails: it isn't run by bin/huntaway (see admin.ts's `exec`). */
const NOT_EXEC = "not started by bin/huntaway, which execs for this server";

const closers: Array<() => void> = [];
afterAll(() => closers.forEach((f) => f()));

/** tokio's `Notify`: `notify_one` wakes a waiter, or the next one to wait. */
class Notify {
  private permit = false;
  private waiters: Array<() => void> = [];
  notify_one() {
    const w = this.waiters.shift();
    if (w) w();
    else this.permit = true;
  }
  notified(): Promise<void> {
    if (this.permit) {
      this.permit = false;
      return Promise.resolve();
    }
    return new Promise((r) => this.waiters.push(r));
  }
}

/** How the fake serves a file: whole; half of it, then the connection breaks; or all of it, once the test lets it go. */
type Serve = { kind: "Whole" } | { kind: "CutOff" } | { kind: "Held"; go: Notify };
const Whole: Serve = { kind: "Whole" };
const CutOff: Serve = { kind: "CutOff" };

/** A status for the fake to answer with instead, and its headers. */
type Failure = [number, Array<[string, string]>] | null;

/**
 * A fake GitHub: its releases (with `{base}` in URLs standing for its own address), the ETag it gives them, and statuses
 * to answer the list and the manifests with instead. The files in `files` are served as they are, and any other download
 * as a manifest.
 */
interface Fake {
  releases: any;
  etag: string;
  fail: Failure;
  manifest_fail: Failure;
  not_modified: number;
  manifests: number;
  files: Map<string, [Buffer, Serve]>;
  downloads: number;
}

function fake_of(releases: any): Fake {
  return { releases, etag: '"one"', fail: null, manifest_fail: null, not_modified: 0, manifests: 0, files: new Map(), downloads: 0 };
}

async function serve_file(res: ServerResponse, bytes: Buffer, serve: Serve) {
  const len = String(bytes.length);
  if (serve.kind === "Held") await serve.go.notified();
  if (serve.kind !== "CutOff") return void res.writeHead(200, { "content-length": len }).end(bytes);
  // Half, and a moment later the error, so the half is sent first.
  res.writeHead(200, { "content-length": len });
  res.write(bytes.subarray(0, Math.floor(bytes.length / 2)));
  await sleep(100);
  res.destroy();
}

function failure(res: ServerResponse, [code, headers]: [number, Array<[string, string]>]) {
  res.writeHead(code, { "content-type": "application/json", ...Object.fromEntries(headers) }).end(JSON.stringify({ message: "nope" }));
}

async function github(fake: Fake): Promise<string> {
  const srv = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/repos/o/r/releases") {
      if (fake.fail) return failure(res, fake.fail);
      if (req.headers["if-none-match"] === fake.etag) {
        fake.not_modified++;
        return void res.writeHead(304).end();
      }
      const body = JSON.stringify(fake.releases).replaceAll("{base}", base);
      return void res.writeHead(200, { etag: fake.etag, "content-type": "application/json" }).end(body);
    }
    const m = /^\/download\/([^/]+)$/.exec(url.pathname);
    if (!m) return void res.writeHead(404).end();
    const name = decodeURIComponent(m[1]);
    const file = fake.files.get(name);
    if (file) {
      fake.downloads++;
      return void (await serve_file(res, file[0], file[1]));
    }
    // (Not the server tarballs the other tests' checks start downloading.)
    if (name.endsWith("-release.json")) fake.manifests++;
    if (fake.manifest_fail) return failure(res, fake.manifest_fail);
    // The stamp is in the name: huntaway-<v>-release.json → shell-<v>.
    const v = name.replace(/^huntaway-/, "").replace(/-release\.json$/, "");
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ version: v, shell: `shell-${v}`, electron: "38.0.0" }));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  closers.push(() => {
    srv.closeAllConnections();
    srv.close();
  });
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  return base;
}

const DIGEST = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function asset(name: string, digest: string | null): any {
  return { name, browser_download_url: `{base}/download/${name}`, size: 42, digest };
}

/** A release of `tag` with a server tarball for linux-x64, a pacman package and a manifest. */
function release(tag: string, prerelease: boolean): any {
  const v = tag.replace(/^v+/, "");
  return {
    tag_name: tag,
    draft: false,
    prerelease,
    published_at: "2026-10-01T00:00:00Z",
    body: `notes for ${v}`,
    html_url: `https://github.com/o/r/releases/tag/${tag}`,
    assets: [
      asset(`huntaway-server-${v}-linux-x64.tar.gz`, DIGEST),
      asset(`huntaway-server-${v}-mac-arm64.tar.gz`, DIGEST),
      asset(`huntaway-${v}-linux-x64.pacman`, DIGEST),
      asset(`huntaway-${v}-linux-x86_64.AppImage`, DIGEST),
      asset(`huntaway-${v}-release.json`, DIGEST),
    ],
  };
}

function config(api: string): Config {
  return {
    repo: "o/r",
    api,
    platform: "linux-x64",
    desktop_version: "0.1.0",
    desktop_shell: "shell-0.2.0",
    desktop_install: "pacman",
    bundled_server: "/opt/Huntaway/resources/huntaway",
  };
}

function host(cfg: Config): AppState {
  const meta = testing.meta();
  meta.release = cfg;
  return testing.state_with(meta);
}

/** A host checking a fake GitHub with these releases. */
async function setup(releases: any): Promise<[Fake, AppState]> {
  const fake = fake_of(releases);
  const base = await github(fake);
  return [fake, host(config(base))];
}

function release_status(state: AppState): any {
  return JSON.parse(JSON.stringify(status(state)));
}

test("picks_the_highest_version_with_a_server_for_this_platform", async () => {
  const [, state] = await setup([release("v0.1.0", false), release("0.10.0", false), release("v0.2.0", false)]);
  await check(state);
  const r = release_status(state);
  assert.equal(r.error, null);
  assert.equal(r.latest.version, "0.10.0");
  assert.equal(r.latest.notes, "notes for 0.10.0");
  assert.equal(r.latest.url, "https://github.com/o/r/releases/tag/0.10.0");
  assert.equal(r.latest.asset.name, "huntaway-server-0.10.0-linux-x64.tar.gz");
  assert.equal(r.latest.asset.sha256, DIGEST.replace(/^sha256:/, ""));
  assert.ok(r.latest.asset.url.endsWith("/download/huntaway-server-0.10.0-linux-x64.tar.gz"));
  assert.equal(r.latest.newer, true);
  assert.equal(r.running, VERSION);
  assert.equal(r.shell.package.name, "huntaway-0.10.0-linux-x64.pacman");
  assert.deepEqual([r.staged, r.bad], [null, []]);
  // In the server's status too.
  assert.equal((await admin.status(state)).release.latest.version, "0.10.0");
});

test("skips_drafts_tags_that_arent_semver_and_assets_without_a_digest", async () => {
  const draft = release("v0.4.0", false);
  draft.draft = true;
  const undigested = release("v0.3.0", false);
  undigested.assets[0].digest = null;
  const bad_digest = release("v0.2.5", false);
  bad_digest.assets[0].digest = "md5:abc";
  const other_platform = { tag_name: "v0.2.2", assets: [asset("huntaway-server-0.2.2-mac-arm64.tar.gz", DIGEST)] };
  const stray = { tag_name: "release/v1", assets: [] };
  let [, state] = await setup([draft, undigested, bad_digest, other_platform, stray, release("v0.2.0", false)]);
  await check(state);
  assert.equal(release_status(state).latest.version, "0.2.0");
  // With none left, there's no latest, and that isn't an error.
  [, state] = await setup([{ tag_name: "release/v1", assets: [] }]);
  await check(state);
  const r = release_status(state);
  assert.deepEqual([r.latest, r.error], [null, null]);
  assert.equal(typeof r.checked_at, "string");
});

test("prereleases_count_only_when_the_setting_is_on", async () => {
  const [, state] = await setup([release("v0.3.0-beta.1", true), release("v0.2.0", false)]);
  await check(state);
  let r = release_status(state);
  assert.deepEqual([r.latest.version, r.prereleases], ["0.2.0", false]);
  db.set_setting(state.db(), PRERELEASES, "true");
  await check(state);
  r = release_status(state);
  assert.deepEqual([r.latest.version, r.latest.prerelease], ["0.3.0-beta.1", true]);
  assert.equal(r.prereleases, true);
});

test("a_304_keeps_the_last_list", async () => {
  const [fake, state] = await setup([release("v0.3.0-rc.1", true), release("v0.2.0", false)]);
  await check(state);
  // GitHub has more now, but says the list hasn't changed: the last one stands.
  fake.releases = [release("v0.9.0", false)];
  await check(state);
  assert.equal(fake.not_modified, 1);
  const r = release_status(state);
  assert.deepEqual([r.latest.version, r.error], ["0.2.0", null]);
  // And it's picked from again, for a changed setting.
  db.set_setting(state.db(), PRERELEASES, "true");
  await check(state);
  assert.equal(fake.not_modified, 2);
  assert.equal(release_status(state).latest.version, "0.3.0-rc.1");
  // A new ETag brings the new list.
  fake.etag = '"two"';
  await check(state);
  assert.equal(release_status(state).latest.version, "0.9.0");
});

test("a_failed_check_keeps_the_last_result", async () => {
  const [fake, state] = await setup([release("v0.2.0", false)]);
  await check(state);
  fake.fail = [500, []];
  await check(state);
  let r = release_status(state);
  assert.equal(r.latest.version, "0.2.0");
  assert.equal(r.error, "GitHub answered 500 Internal Server Error: nope");
  assert.equal(r.rate_limit_reset, null);
  // The rate limit says so, with when it resets.
  const limited: Array<[string, string]> = [
    ["x-ratelimit-remaining", "0"],
    ["x-ratelimit-reset", "1793491200"],
  ];
  fake.fail = [403, limited];
  await check(state);
  r = release_status(state);
  assert.equal(r.latest.version, "0.2.0");
  assert.equal(r.rate_limit_reset, "2026-11-01T00:00:00Z");
  assert.ok(r.error.includes("rate limit"), JSON.stringify(r));
  // A 403 that isn't the rate limit is just an error.
  fake.fail = [403, [["x-ratelimit-remaining", "12"]]];
  await check(state);
  r = release_status(state);
  assert.deepEqual([r.error, r.rate_limit_reset], ["GitHub answered 403 Forbidden: nope", null]);
  // An unreachable API too.
  const state2 = host(config("http://127.0.0.1:1"));
  await check(state2);
  r = release_status(state2);
  assert.equal(r.latest, null);
  assert.ok(r.error.includes("asking http://127.0.0.1:1/repos/o/r/releases"), JSON.stringify(r));
  // Recovering clears the error.
  fake.fail = null;
  await check(state);
  assert.equal(release_status(state).error, null);
});

test("the_manifest_says_whether_the_shell_is_outdated", async () => {
  // The app's shell is 0.2.0's (see config).
  const [fake, state] = await setup([release("v0.2.0", false)]);
  await check(state);
  let r = release_status(state);
  assert.equal(r.shell.outdated, false);
  assert.equal(r.shell.install, "pacman");
  assert.equal(r.shell.version, "0.1.0");
  // 0.3.0 has another.
  fake.releases = [release("v0.3.0", false), release("v0.2.0", false)];
  fake.etag = '"two"';
  await check(state);
  r = release_status(state);
  assert.deepEqual([r.latest.version, r.shell.outdated], ["0.3.0", true]);
  assert.equal(r.shell.package.name, "huntaway-0.3.0-linux-x64.pacman");
  // The manifest is read once per release.
  fake.etag = '"three"';
  await check(state);
  assert.equal(fake.manifests, 2);
  // Without a manifest, it can't say.
  const bare = release("v0.4.0", false);
  bare.assets.pop();
  fake.releases = [bare];
  fake.etag = '"four"';
  await check(state);
  r = release_status(state);
  assert.deepEqual([r.latest.version, r.shell.outdated], ["0.4.0", false]);
});

test("an_app_newer_than_the_latest_release_isnt_offered_its_package", async () => {
  // The app was installed from 0.3.0-rc.1, and prereleases are off (as they are by default), so the checks pick 0.2.0,
  // whose shell differs: installing its package would downgrade the app.
  const fake = fake_of([release("v0.2.0", false)]);
  const base = await github(fake);
  const cfg = (v: string): Config => ({ ...config(base), desktop_version: v, desktop_shell: "shell-0.3.0-rc.1" });
  for (const [desktop, outdated] of [
    ["0.3.0-rc.1", false],
    ["0.2.0", false],
    ["0.2.0-rc.1", true],
    ["0.1.0", true],
    ["not a version", false],
  ] as const) {
    const state = host(cfg(desktop));
    await check(state);
    const r = release_status(state);
    assert.deepEqual([r.latest.version, r.shell.outdated], ["0.2.0", outdated], `app ${desktop}`);
  }
  // Without the app's version (a server started by hand with the IA_DESKTOP_* it was given), the stamps decide.
  const state = host({ ...cfg(""), desktop_version: null });
  await check(state);
  assert.equal(release_status(state).shell.outdated, true);
});

test("a_manifest_that_cant_be_read_fails_the_check", async () => {
  // 0.3.0 has a newer shell than the app's (see config).
  const [fake, state] = await setup([release("v0.3.0", false)]);
  await check(state);
  let r = release_status(state);
  assert.deepEqual([r.latest.version, r.shell.outdated], ["0.3.0", true]);
  state.release.last.checked_at = null;
  // 0.4.0's manifest can't be read: what 0.3.0 said stands, with the error.
  fake.releases = [release("v0.4.0", false), release("v0.3.0", false)];
  fake.etag = '"two"';
  fake.manifest_fail = [500, []];
  await check(state);
  r = release_status(state);
  assert.deepEqual([r.latest.version, r.shell.outdated], ["0.3.0", true]);
  assert.equal(r.error, "reading huntaway-0.4.0-release.json: GitHub answered 500 Internal Server Error: nope");
  assert.equal(typeof r.checked_at, "string", `the attempt is recorded: ${JSON.stringify(r)}`);
  // Nor one that isn't a manifest.
  fake.manifest_fail = [200, []];
  await check(state);
  r = release_status(state);
  assert.equal(r.latest.version, "0.3.0");
  assert.ok(r.error.startsWith("reading huntaway-0.4.0-release.json: "), JSON.stringify(r));
  // The rate limit on the manifest says when it resets.
  fake.manifest_fail = [
    429,
    [
      ["x-ratelimit-remaining", "0"],
      ["x-ratelimit-reset", "1793491200"],
    ],
  ];
  await check(state);
  r = release_status(state);
  assert.deepEqual([r.latest.version, r.rate_limit_reset], ["0.3.0", "2026-11-01T00:00:00Z"]);
  assert.ok(r.error.includes("rate limit"), JSON.stringify(r));
  // Once it can be read, the check goes through (the list is asked for again, not taken from a 304).
  fake.manifest_fail = null;
  await check(state);
  r = release_status(state);
  assert.deepEqual([r.latest.version, r.shell.outdated], ["0.4.0", true]);
  assert.deepEqual([r.error, r.rate_limit_reset], [null, null]);
  assert.equal(fake.not_modified, 0);
});

async function api(s: AppState, method: string, path: string, body?: any): Promise<[number, any]> {
  if (!s.local_router) router(s);
  const headers = { authorization: "Bearer ", "content-type": "application/json" };
  const a = await dispatch(s, makeReq(method, path, headers, body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body))));
  let v: any = null;
  try {
    v = JSON.parse(a.body.toString("utf8"));
  } catch {}
  return [a.status, v];
}

/** A broadcast receiver of `state`'s events, from now on. */
function subscribe(state: AppState) {
  const queue: any[] = [];
  let wake: (() => void) | null = null;
  state.events.subscribe((ev) => {
    queue.push(ev);
    wake?.();
  });
  return {
    async recv(): Promise<any> {
      while (!queue.length) await new Promise<void>((r) => (wake = r));
      return queue.shift();
    },
    try_recv(): any | undefined {
      return queue.shift();
    },
  };
}
type Events = ReturnType<typeof subscribe>;

test("the_prerelease_setting_and_check_now_go_through_the_api", async () => {
  const [fake, state] = await setup([release("v0.3.0-beta.1", true), release("v0.2.0", false)]);
  let [code, v] = await api(state, "POST", "/api/admin/release/check");
  assert.equal(code, 200, JSON.stringify(v));
  assert.equal(v.release.latest.version, "0.2.0");
  [, v] = await api(state, "GET", "/api/settings");
  assert.equal(v.release_prereleases, false);
  for (const bad of ["true", 1]) assert.equal((await api(state, "PATCH", "/api/settings", { release_prereleases: bad }))[0], 400, String(bad));
  // Turning it on checks again, in the background (from the last list: the ETag is the same).
  const events = subscribe(state);
  [code, v] = await api(state, "PATCH", "/api/settings", { release_prereleases: true });
  assert.deepEqual([code, v.release_prereleases], [200, true]);
  while ((await events.recv()).type !== "release_checked") {}
  assert.equal(release_status(state).latest.version, "0.3.0-beta.1");
  assert.equal(fake.not_modified, 1);
  // Setting it to what it is doesn't; null turns it off.
  await api(state, "PATCH", "/api/settings", { release_prereleases: true });
  [, v] = await api(state, "PATCH", "/api/settings", { release_prereleases: null });
  assert.equal(v.release_prereleases, false);
  while ((await events.recv()).type !== "release_checked") {}
  assert.equal(fake.not_modified, 2);
  assert.equal(release_status(state).latest.version, "0.2.0");
  // Without --release-updates there's nothing to check.
  [code, v] = await api(testing.state(), "POST", "/api/admin/release/check");
  assert.equal(code, 400, JSON.stringify(v));
});

test("shell_reports_how_the_app_was_installed", () => {
  const cfg = config("http://unused");
  cfg.desktop_install = "appimage:/home/me/Huntaway.AppImage";
  const latest: Latest = {
    version: parse_version("0.2.0")!,
    release: GhRelease_from_json(release("v0.2.0", false)),
    asset: GhAsset_from_json(asset("huntaway-server-0.2.0-linux-x64.tar.gz", DIGEST)),
    manifest: { shell: "shell-0.2.0" },
  };
  let s = shell(cfg, latest);
  assert.deepEqual([s.install, s.path], ["appimage", "/home/me/Huntaway.AppImage"]);
  assert.equal(s.package.name, "huntaway-0.2.0-linux-x86_64.AppImage");
  assert.equal(package_name("appimage", "0.2.0", "linux-arm64"), "huntaway-0.2.0-linux-arm64.AppImage");
  assert.equal(package_name("pacman", "0.2.0", "linux-x64"), "huntaway-0.2.0-linux-x64.pacman");
  cfg.desktop_install = "mac:/Applications/Huntaway.app";
  s = shell(cfg, latest);
  assert.deepEqual([s.install, s.package], ["mac", null]);
  // A server no app started (a tarball install) has no shell.
  const bare: Config = { ...cfg, desktop_version: null, desktop_shell: null, desktop_install: null };
  assert.equal(shell(bare, latest), null);
});

test("repo_must_be_owner_slash_name", () => {
  assert.equal(Config_from_env(" dire-kiwi/huntaway ").repo, "dire-kiwi/huntaway");
  for (const bad of ["huntaway", "a/b/c", "/b", "a/", "a b/c"]) assert.throws(() => Config_from_env(bad), Error, bad);
});

test("off_without_the_flag", async () => {
  const state = testing.state();
  await check(state);
  assert.equal(status(state), null);
  assert.ok(!("release" in (await admin.status(state))));
});

// ---------- staging, Update and Roll back ----------

function sha256_hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A release's files in `dir`: `huntaway` (a script that runs `script`), `ia-shim` and `ui/index.html`. */
function server_files(dir: string, script: string) {
  mkdirSync(join(dir, "ui"), { recursive: true });
  writeFileSync(join(dir, "huntaway"), `#!/bin/sh\n${script}\n`);
  chmodSync(join(dir, "huntaway"), 0o755);
  writeFileSync(join(dir, "ia-shim"), "shim");
  writeFileSync(join(dir, "ui/index.html"), "<html>");
}

function tar_in(dir: string, args: string[]) {
  execFileSync("tar", args, { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
}

/**
 * A server tarball for `v` as release.yml packs it (`huntaway-server-<v>-linux-x64/…`), whose `huntaway` runs `script`
 * (by default, prints its version like clap does), with `tar`'s extra arguments for other entries.
 */
function tarball(v: string, script: string | null = null, extra: string[] = []): Buffer {
  const dir = testing.temp_dir();
  const top = `huntaway-server-${v}-linux-x64`;
  server_files(join(dir, top), script ?? `echo 'huntaway ${v}'`);
  writeFileSync(join(dir, "evil"), "outside");
  tar_in(dir, ["-czPf", "out.tar.gz", top, ...extra]);
  return readFileSync(join(dir, "out.tar.gz"));
}

/** A release of `tag` whose linux-x64 server tarball is `bytes`, served the way `serve` says. */
function served(fake: Fake, tag: string, bytes: Buffer, serve: Serve): any {
  const r = release(tag, false);
  const name = r.assets[0].name;
  r.assets[0].digest = `sha256:${sha256_hex(bytes)}`;
  r.assets[0].size = bytes.length;
  fake.files.set(name, [bytes, serve]);
  return r;
}

/** A host checking a fake GitHub that has the releases `make` gives. */
async function setup_with(make: (f: Fake) => any): Promise<[Fake, AppState]> {
  const [fake, state] = await setup([]);
  fake.releases = make(fake);
  return [fake, state];
}

/** Change what the fake lists (with a new ETag, so it's read again). */
function relist(fake: Fake, releases: any) {
  fake.releases = releases;
  fake.etag = `"${new_id()}"`;
}

/** The first download `pred` accepts, waiting for it. */
async function download_where(state: AppState, pred: (d: Download) => boolean): Promise<Download> {
  const rx = state.release.download;
  for (;;) {
    const seen = rx.version;
    const d = rx.borrow();
    if (d && pred(d)) return { ...d };
    await rx.changed(seen);
  }
}

/** The download, once it has finished (staged or failed). */
function finished(state: AppState): Promise<Download> {
  return download_where(state, (d) => !staging.Download_running(d));
}

/** The names in `app/`, sorted. */
function app_entries(state: AppState): string[] {
  try {
    return readdirSync(staging.app_dir(state)).sort();
  } catch {
    return [];
  }
}

test("a_newer_release_is_staged_in_the_background", async () => {
  const [fake, state] = await setup_with((f) => [served(f, "v0.2.0", tarball("0.2.0"), Whole)]);
  const events = subscribe(state);
  await check(state);
  const d = await finished(state);
  assert.deepEqual([d.phase, d.error], ["staged", null]);
  assert.equal(d.bytes, d.total);
  const app = staging.app_dir(state);
  assert.ok(staging.complete(join(app, "0.2.0")));
  assert.deepEqual(app_entries(state), ["0.2.0", "state.json"], "no tarball or .partial is left");
  assert.equal(staging.read(app).staged, "0.2.0");
  const r = release_status(state);
  assert.deepEqual([r.staged, r.download], ["0.2.0", null]);
  // The UI hears how it goes.
  const phases: string[] = [];
  for (let ev = events.try_recv(); ev !== undefined; ev = events.try_recv()) {
    if (ev.type === "release_download") {
      const p = ev.download?.phase ?? "done";
      if (phases[phases.length - 1] !== p) phases.push(p);
    }
  }
  assert.deepEqual(phases, ["downloading", "verifying", "installing", "done"]);
  // Checking again doesn't download it again.
  await check(state);
  assert.equal(fake.downloads, 1);
  assert.equal(release_status(state).staged, "0.2.0");
});

/** Stage a release whose tarball is `bytes`, served with `serve`, and expect it to fail with `error`, leaving nothing in `app/`. */
async function refused(bytes: Buffer, serve: Serve, digest: string | null, error: string): Promise<[Fake, AppState]> {
  const [fake, state] = await setup_with((f) => {
    const r = served(f, "v0.2.0", bytes, serve);
    if (digest !== null) r.assets[0].digest = digest;
    return [r];
  });
  await check(state);
  const d = await finished(state);
  assert.equal(d.phase, "failed");
  assert.ok(d.error!.includes(error), JSON.stringify(d));
  assert.deepEqual(app_entries(state), [], "nothing is left behind");
  assert.ok(!existsSync(join(state.data_dir, "evil")) && !existsSync(join(staging.app_dir(state), "evil")));
  const r = release_status(state);
  assert.deepEqual([r.download?.phase, r.staged], ["failed", null]);
  assert.equal(r.download.error, d.error);
  return [fake, state];
}

test("a_wrong_digest_leaves_nothing_behind_and_is_tried_again", async () => {
  const bytes = tarball("0.2.0");
  const [fake, state] = await refused(bytes, Whole, DIGEST, "has sha256");
  // The next check tries again, and the release has the right digest now.
  relist(fake, [served(fake, "v0.2.0", bytes, Whole)]);
  await check(state);
  assert.equal((await finished(state)).phase, "staged");
  assert.equal(release_status(state).staged, "0.2.0");
});

test("a_cut_off_download_leaves_nothing_behind", async () => {
  await refused(tarball("0.2.0"), CutOff, null, "cut off");
});

test("entries_outside_the_folder_are_refused", async () => {
  // top/../evil would unpack beside app/0.2.0.partial.
  await refused(tarball("0.2.0", null, ["huntaway-server-0.2.0-linux-x64/../evil"]), Whole, null, "outside its folder");
});

test("links_are_refused", async () => {
  const dir = testing.temp_dir();
  const top = "huntaway-server-0.2.0-linux-x64";
  server_files(join(dir, top), "echo huntaway 0.2.0");
  symlinkSync("/etc", join(dir, top, "etc"));
  tar_in(dir, ["-czf", "out.tar.gz", top]);
  await refused(readFileSync(join(dir, "out.tar.gz")), Whole, null, "isn't a file or a folder");
});

test("a_server_that_fails_its_smoke_test_is_refused", async () => {
  await refused(tarball("0.2.0", "echo broken >&2; exit 3"), Whole, null, "--version failed with exit status: 3: broken");
  await refused(tarball("0.2.0", "echo huntaway 0.1.9"), Whole, null, 'printed "huntaway 0.1.9", not 0.2.0');
  // Or that's missing its UI.
  const dir = testing.temp_dir();
  const top = "huntaway-server-0.2.0-linux-x64";
  server_files(join(dir, top), "echo huntaway 0.2.0");
  rmSync(join(dir, top, "ui"), { recursive: true });
  tar_in(dir, ["-czf", "out.tar.gz", top]);
  await refused(readFileSync(join(dir, "out.tar.gz")), Whole, null, "doesn't have huntaway, ia-shim and ui/index.html");
});

test("one_download_at_a_time", async () => {
  const go = new Notify();
  const [fake, state] = await setup_with((f) => [served(f, "v0.2.0", tarball("0.2.0"), { kind: "Held", go })]);
  await check(state);
  await check(state);
  await check(state);
  const r = release_status(state);
  assert.deepEqual([r.download.version, r.download.phase], ["0.2.0", "downloading"]);
  assert.equal(r.staged, null);
  go.notify_one();
  assert.equal((await finished(state)).phase, "staged");
  assert.equal(fake.downloads, 1);
});

test("a_release_found_during_a_download_is_downloaded_after_it", async () => {
  const go = new Notify();
  const [fake, state] = await setup_with((f) => [served(f, "v0.2.0", tarball("0.2.0"), { kind: "Held", go })]);
  await check(state);
  relist(fake, [served(fake, "v0.3.0", tarball("0.3.0"), Whole)]);
  await check(state);
  assert.equal(release_status(state).download.version, "0.2.0");
  go.notify_one();
  await download_where(state, (d) => d.version === "0.3.0" && !staging.Download_running(d));
  assert.equal(release_status(state).staged, "0.3.0");
  assert.deepEqual(app_entries(state), ["0.3.0", "state.json"]);
});

// HA-69: a prerelease staged while they were included stayed offered, and installable, after they were turned off.
test("a_staged_prerelease_is_unstaged_once_prereleases_are_off", async () => {
  const [, state] = await setup_with((f) => {
    const rc = served(f, "v0.3.0-rc.1", tarball("0.3.0-rc.1"), Whole);
    rc.prerelease = true;
    return [rc, served(f, "v0.2.0", tarball("0.2.0"), Whole)];
  });
  db.set_setting(state.db(), PRERELEASES, "true");
  await check(state);
  assert.equal((await finished(state)).version, "0.3.0-rc.1");
  assert.equal(release_status(state).staged, "0.3.0-rc.1");
  db.set_setting(state.db(), PRERELEASES, null);
  await check(state);
  const r = release_status(state);
  assert.deepEqual([r.latest.version, r.staged], ["0.2.0", null]);
  assert.ok(!existsSync(join(staging.app_dir(state), "0.3.0-rc.1")));
  // The release it does pick is downloaded instead.
  await download_where(state, (d) => d.version === "0.2.0" && !staging.Download_running(d));
  assert.equal(release_status(state).staged, "0.2.0");
  assert.deepEqual(app_entries(state), ["0.2.0", "state.json"]);
});

/**
 * A prerelease 0.3.0-rc.1 staged with prereleases on, then a stable 0.3.0 served with `serve` (and `digest`, if given)
 * and prereleases turned off: the check that follows unstages the prerelease, below 0.3.0 as it is.
 */
async function prerelease_below_a_newer_stable(serve: Serve, digest: string | null): Promise<[Fake, AppState]> {
  const [fake, state] = await setup_with((f) => {
    const rc = served(f, "v0.3.0-rc.1", tarball("0.3.0-rc.1"), Whole);
    rc.prerelease = true;
    return [rc];
  });
  db.set_setting(state.db(), PRERELEASES, "true");
  await check(state);
  assert.equal((await finished(state)).phase, "staged");
  const rc = served(fake, "v0.3.0-rc.1", tarball("0.3.0-rc.1"), Whole);
  rc.prerelease = true;
  const stable = served(fake, "v0.3.0", tarball("0.3.0"), serve);
  if (digest !== null) stable.assets[0].digest = digest;
  relist(fake, [stable, rc]);
  db.set_setting(state.db(), PRERELEASES, null);
  await check(state);
  const r = release_status(state);
  assert.deepEqual([r.latest.version, r.staged], ["0.3.0", null]);
  assert.ok(!existsSync(join(staging.app_dir(state), "0.3.0-rc.1")));
  const [code, body] = await api(state, "POST", "/api/admin/release/update", { version: "0.3.0-rc.1" });
  assert.equal(code, 400, JSON.stringify(body));
  return [fake, state];
}

// HA-69 review: a disabled prerelease below a newer stable release stayed offered while that one's download failed.
test("a_disabled_prerelease_below_a_stable_whose_download_fails_is_unstaged", async () => {
  const [, state] = await prerelease_below_a_newer_stable(Whole, `sha256:${"0".repeat(64)}`);
  const d = await finished(state);
  assert.deepEqual([d.version, d.phase], ["0.3.0", "failed"]);
  assert.equal(release_status(state).staged, null);
  assert.deepEqual(app_entries(state), ["state.json"]);
});

test("a_disabled_prerelease_is_unstaged_while_the_stable_one_downloads", async () => {
  const go = new Notify();
  const [, state] = await prerelease_below_a_newer_stable({ kind: "Held", go }, null);
  assert.equal(release_status(state).download.version, "0.3.0");
  go.notify_one();
  const d = await finished(state);
  assert.deepEqual([d.version, d.phase], ["0.3.0", "staged"]);
  assert.deepEqual(app_entries(state), ["0.3.0", "state.json"]);
});

/** `p`, or a failure once `ms` pass. */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<never>((_, fail) => (timer = setTimeout(() => fail(new Error(what)), ms)))]).finally(() => clearTimeout(timer));
}

// HA-69 review: an Update waiting for a prerelease's download that was then withdrawn downloaded it, and the stable
// release, over and over, and its job never ended, so no other restart could start.
test("an_update_waiting_for_a_withdrawn_prerelease_fails", async () => {
  const go = new Notify();
  const [fake, state] = await setup_with((f) => {
    const rc = served(f, "v0.3.0-rc.1", tarball("0.3.0-rc.1"), { kind: "Held", go });
    rc.prerelease = true;
    return [rc, served(f, "v0.2.0", tarball("0.2.0"), Whole)];
  });
  db.set_setting(state.db(), PRERELEASES, "true");
  await check(state);
  const events = subscribe(state);
  assert.equal((await api(state, "POST", "/api/admin/release/update", { version: "0.3.0-rc.1" }))[0], 200);
  await new Promise((r) => setImmediate(r));
  db.set_setting(state.db(), PRERELEASES, null);
  await check(state);
  for (const f of fake.files.values()) f[1] = Whole;
  go.notify_one();
  const [, error] = await within(job_fails(events), 10_000, "the Update ends");
  assert.ok(error.includes("0.3.0-rc.1 isn't offered any more"), error);
  // The release still offered is downloaded, once, and the withdrawn one isn't again.
  await download_where(state, (d) => d.version === "0.2.0" && !staging.Download_running(d));
  assert.equal(fake.downloads, 2, "the prerelease and 0.2.0, each once");
  assert.equal(release_status(state).staged, "0.2.0");
  assert.deepEqual(app_entries(state), ["0.2.0", "state.json"]);
  // The job is over, so another can start.
  const [code, body] = await api(state, "POST", "/api/admin/release/update", { version: "0.2.0" });
  assert.equal(code, 200, JSON.stringify(body));
  const [phases] = await job_fails(events);
  assert.equal(phases[phases.length - 1], "failed", "not run by bin/huntaway, so its exec fails");
  assert.equal(fake.downloads, 2);
});

test("an_older_staged_release_stays_offered_while_a_newer_one_downloads", async () => {
  const [fake, state] = await setup_with((f) => [served(f, "v0.2.0", tarball("0.2.0"), Whole)]);
  await check(state);
  assert.equal((await finished(state)).phase, "staged");
  const go = new Notify();
  const older = served(fake, "v0.2.0", tarball("0.2.0"), Whole);
  relist(fake, [served(fake, "v0.3.0", tarball("0.3.0"), { kind: "Held", go }), older]);
  await check(state);
  const r = release_status(state);
  assert.deepEqual([r.staged, r.download.version], ["0.2.0", "0.3.0"]);
  go.notify_one();
  assert.equal((await finished(state)).phase, "staged");
  assert.equal(release_status(state).staged, "0.3.0");
});

test("a_staged_release_taken_down_is_unstaged_but_not_on_a_failed_check", async () => {
  const [fake, state] = await setup_with((f) => [served(f, "v0.2.0", tarball("0.2.0"), Whole)]);
  await check(state);
  assert.equal((await finished(state)).phase, "staged");
  fake.fail = [500, []];
  await check(state);
  assert.equal(release_status(state).staged, "0.2.0", "a failed check says nothing about the release");
  fake.fail = null;
  relist(fake, []);
  await check(state);
  assert.equal(release_status(state).staged, null);
  assert.deepEqual(app_entries(state), ["state.json"]);
});

test("a_newer_release_replaces_an_unused_staged_one", async () => {
  const [fake, state] = await setup_with((f) => [served(f, "v0.2.0", tarball("0.2.0"), Whole)]);
  await check(state);
  assert.equal((await finished(state)).phase, "staged");
  const older = served(fake, "v0.2.0", tarball("0.2.0"), Whole);
  relist(fake, [served(fake, "v0.3.0", tarball("0.3.0"), Whole), older]);
  await check(state);
  const d = await finished(state);
  assert.deepEqual([d.version, d.phase], ["0.3.0", "staged"]);
  assert.deepEqual(app_entries(state), ["0.3.0", "state.json"]);
  assert.equal(release_status(state).staged, "0.3.0");
});

test("a_bad_version_isnt_offered_or_staged", async () => {
  const [fake, state] = await setup_with((f) => {
    const newer = served(f, "v0.3.0", tarball("0.3.0"), Whole);
    return [newer, served(f, "v0.2.0", tarball("0.2.0"), Whole)];
  });
  staging.write(staging.app_dir(state), { ...staging.Installed_default(), bad: ["0.3.0"] });
  await check(state);
  const d = await finished(state);
  assert.deepEqual([d.version, d.phase], ["0.2.0", "staged"]);
  const r = release_status(state);
  assert.deepEqual([r.latest.version, r.bad], ["0.2.0", ["0.3.0"]]);
  const [code, v] = await api(state, "POST", "/api/admin/release/update", { version: "0.3.0" });
  assert.equal(code, 400, JSON.stringify(v));
  // A newer one is.
  relist(fake, [served(fake, "v0.3.1", tarball("0.3.1"), Whole)]);
  await check(state);
  assert.equal((await finished(state)).version, "0.3.1");
  assert.equal(release_status(state).staged, "0.3.1");
  assert.equal(fake.downloads, 2);
});

/** A host running from `app/<running>/huntaway` in its own data dir, whose `app/` has these versions. */
function host_at(cfg: Config, running: string | null, versions: string[]): AppState {
  const data_dir = realpathSync(testing.temp_dir());
  for (const v of [...versions, ...(running === null ? [] : [running])]) server_files(join(data_dir, "app", v), `echo huntaway ${v}`);
  const exe = running === null ? process.execPath : join(data_dir, "app", running, "huntaway");
  const meta = testing.meta();
  meta.release = cfg;
  return testing.state_at(meta, data_dir, exe);
}

const read_json = (p: string) => JSON.parse(readFileSync(p, "utf8"));

test("settling_keeps_current_previous_and_staged", () => {
  const state = host_at(config("http://unused"), "0.2.0", ["0.1.0", "0.1.5", "0.3.0"]);
  const app = staging.app_dir(state);
  mkdirSync(join(app, "0.4.0.partial"), { recursive: true });
  writeFileSync(join(app, "state.json.123.tmp"), "{");
  writeFileSync(join(app, "notes.txt"), "the desktop app's");
  // An Update from 0.1.0 onto 0.2.0.
  const before = { current: "0.1.0", previous: "0.1.5", staged: "0.2.0", trying: "0.2.0", bad: ["0.0.9"], shell: { x: 1 } };
  writeFileSync(join(app, "state.json"), JSON.stringify(before));
  assert.equal(staging.settle(state), "0.2.0");
  assert.deepEqual(read_json(join(app, "state.json")), { current: "0.2.0", previous: "0.1.0", staged: null, trying: null, bad: ["0.0.9"], shell: { x: 1 } });
  assert.deepEqual(app_entries(state), ["0.1.0", "0.2.0", "notes.txt", "state.json"]);
  // A later start (not an Update) keeps previous, and a staged version.
  server_files(join(app, "0.3.0"), "echo huntaway 0.3.0");
  staging.change(state, (s) => (s.staged = "0.3.0"));
  staging.settle(state);
  let s = staging.read(app);
  assert.deepEqual([s.current, s.previous, s.staged], ["0.2.0", "0.1.0", "0.3.0"]);
  assert.deepEqual(app_entries(state), ["0.1.0", "0.2.0", "0.3.0", "notes.txt", "state.json"]);
  // One staged that isn't newer than what runs (updated past it) is dropped.
  staging.change(state, (s) => (s.staged = "0.1.5"));
  server_files(join(app, "0.1.5"), "echo huntaway 0.1.5");
  staging.settle(state);
  assert.equal(staging.read(app).staged, null);
  assert.deepEqual(app_entries(state), ["0.1.0", "0.2.0", "notes.txt", "state.json"]);
  // A server that isn't running from app/ leaves it alone.
  const other = host_at(config("http://unused"), null, ["0.1.0", "0.2.0"]);
  mkdirSync(join(staging.app_dir(other), "0.3.0.partial"), { recursive: true });
  assert.equal(staging.settle(other), null);
  assert.deepEqual(app_entries(other), ["0.1.0", "0.2.0", "0.3.0.partial"]);
});

/**
 * A tarball's server, started again by its supervisor, picks the version it last updated to, and a version that didn't
 * come up isn't picked again (or it would be started on every restart).
 */
test("a_server_started_again_picks_the_version_it_updated_to", () => {
  const app = testing.temp_dir();
  const v = (s: string) => parse_version(s)!;
  const state = (s: any) => writeFileSync(join(app, "state.json"), JSON.stringify(s));
  const installed = () => read_json(join(app, "state.json"));
  // Nothing downloaded: nothing to pick, and no state.json written.
  assert.equal(staging.choose_at_startup(app, v("0.1.0")), null);
  assert.ok(!existsSync(join(app, "state.json")));
  for (const ver of ["0.2.0", "0.3.0"]) server_files(join(app, ver), "true");
  state({ current: "0.3.0", previous: "0.2.0", staged: null, trying: null, bad: [], shell: 1 });
  const pick = staging.choose_at_startup(app, v("0.1.0"));
  assert.deepEqual(pick, ["0.3.0", join(app, "0.3.0/huntaway")]);
  assert.deepEqual(installed(), { current: "0.3.0", previous: "0.2.0", staged: null, trying: "0.3.0", bad: [], shell: 1 });
  // It came up and settled; a newer tarball (0.3.0 or later) runs itself.
  state({ current: "0.3.0", previous: "0.2.0", bad: [] });
  assert.equal(staging.choose_at_startup(app, v("0.3.0")), null);
  assert.equal(staging.choose_at_startup(app, v("0.4.0")), null);
  // 0.3.0 exited before it was listening (trying is still set): it's bad, and 0.2.0 is current and tried.
  state({ current: "0.3.0", previous: "0.2.0", trying: "0.3.0", bad: [] });
  assert.equal(staging.choose_at_startup(app, v("0.1.0"))![0], "0.2.0");
  let s = staging.read(app);
  assert.deepEqual([s.current, s.previous, s.trying, s.bad], ["0.2.0", null, "0.2.0", ["0.3.0"]]);
  // And when 0.2.0 doesn't come up either, the tarball's own server runs.
  assert.equal(staging.choose_at_startup(app, v("0.1.0")), null);
  s = staging.read(app);
  assert.deepEqual([s.trying, s.bad], [null, ["0.3.0", "0.2.0"]]);
  // A version without its files isn't picked.
  state({ current: "0.4.0", bad: [] });
  assert.equal(staging.choose_at_startup(app, v("0.1.0")), null);
});

test("state_json_round_trips_with_unknown_keys", () => {
  const app = testing.temp_dir();
  assert.deepEqual(staging.read(app), staging.Installed_default());
  const written = { current: "0.2.0", previous: null, staged: "0.3.0", trying: 7, bad: ["0.2.5", 3], launches: [1, 2], x: "y" };
  writeFileSync(join(app, "state.json"), JSON.stringify(written));
  const s = staging.read(app);
  assert.deepEqual([s.current, s.staged, s.trying, s.bad], ["0.2.0", "0.3.0", null, ["0.2.5"]]);
  s.trying = "0.3.0";
  staging.write(app, s);
  assert.deepEqual(read_json(join(app, "state.json")), {
    current: "0.2.0",
    previous: null,
    staged: "0.3.0",
    trying: "0.3.0",
    bad: ["0.2.5"],
    launches: [1, 2],
    x: "y",
  });
  assert.equal(readdirSync(app).length, 1, "no temp file is left");
  // One that can't be read counts as none.
  writeFileSync(join(app, "state.json"), "{not json");
  assert.deepEqual(staging.read(app), staging.Installed_default());
});

/** The restart job's phases until it fails, and its error. */
async function job_fails(events: Events): Promise<[string[], string]> {
  const phases: string[] = [];
  for (;;) {
    const ev = await events.recv();
    if (ev.type === "restart") {
      if (phases[phases.length - 1] !== ev.phase) phases.push(ev.phase);
      if (ev.phase === "failed") return [phases, ev.error];
    }
  }
}

/** state.json as it is when the job execs. */
function at_exec(state: AppState): { seen: Installed | null } {
  const seen: { seen: Installed | null } = { seen: null };
  const app = staging.app_dir(state);
  testing.when("exec", () => (seen.seen = staging.read(app)));
  return seen;
}

test("update_restarts_onto_a_staged_version", async () => {
  const [, state] = await setup_with((f) => [served(f, "v0.2.0", tarball("0.2.0"), Whole)]);
  await check(state);
  assert.equal((await finished(state)).phase, "staged");
  const seen = at_exec(state);
  const events = subscribe(state);
  const [code, v] = await api(state, "POST", "/api/admin/release/update", { version: "0.2.0" });
  assert.equal(code, 200, JSON.stringify(v));
  // One at a time.
  assert.equal((await api(state, "POST", "/api/admin/release/update", { version: "0.2.0" }))[0], 409);
  const [phases, error] = await job_fails(events);
  assert.deepEqual(phases, ["restarting", "failed"]);
  const exe = join(staging.app_dir(state), "0.2.0/huntaway");
  assert.equal(error, `failed to exec ${exe}: ${NOT_EXEC}`);
  assert.equal(seen.seen!.trying, "0.2.0", "trying is set for the exec");
  // It failed, so this server carries on as it was.
  const s = staging.read(staging.app_dir(state));
  assert.deepEqual([s.trying, s.staged], [null, "0.2.0"]);
});

/**
 * HA-74 review: a tarball's server (not in `app/`, no IA_BUNDLED_SERVER) updated onto a release, which then had no
 * previous version and no bundled server, so it offered no Roll back until a supervisor restarted it. It passes itself
 * as IA_BUNDLED_SERVER; one that has it already, or runs from `app/`, adds nothing.
 */
test("a_tarball_servers_update_passes_itself_for_roll_back", async () => {
  const update = async (cfg: Config, running: string | null, staged: string): Promise<[Array<[string, string]>, string]> => {
    const state = host_at(cfg, running, [staged]);
    staging.change(state, (s) => (s.staged = staged));
    const events = subscribe(state);
    const [code, v] = await api(state, "POST", "/api/admin/release/update", { version: staged });
    assert.equal(code, 200, JSON.stringify(v));
    await job_fails(events);
    return [admin.exec_env()!, state.exe];
  };
  const tarball_cfg: Config = { ...config("http://unused"), bundled_server: null };
  const [env, exe] = await update(tarball_cfg, null, "0.2.0");
  assert.deepEqual(env, [["IA_BUNDLED_SERVER", exe]]);
  // The desktop app's server, or one given IA_BUNDLED_SERVER: it carries over as it is.
  assert.deepEqual((await update(config("http://unused"), null, "0.2.0"))[0], []);
  // A release from app/: its Roll back goes to the version before it (or the bundled server it was given).
  assert.deepEqual((await update(tarball_cfg, "0.2.0", "0.3.0"))[0], []);
});

test("update_waits_for_the_background_download", async () => {
  const go = new Notify();
  const [fake, state] = await setup_with((f) => [served(f, "v0.2.0", tarball("0.2.0"), { kind: "Held", go })]);
  await check(state);
  const seen = at_exec(state);
  const events = subscribe(state);
  assert.equal((await api(state, "POST", "/api/admin/release/update", { version: "0.2.0" }))[0], 200);
  go.notify_one();
  const [phases, error] = await job_fails(events);
  assert.deepEqual(phases, ["downloading", "verifying", "installing", "restarting", "failed"]);
  assert.ok(error.endsWith(`0.2.0/huntaway: ${NOT_EXEC}`), error);
  assert.equal(seen.seen!.trying, "0.2.0");
  assert.equal(fake.downloads, 1, "the job didn't start another");
  const log = state.restart!.log;
  assert.ok(log.includes("Downloading 0.2.0") && log.includes("Checking its sha256"), log);
});

test("update_downloads_first_when_the_background_download_failed", async () => {
  const bytes = tarball("0.2.0");
  const [fake, state] = await setup_with((f) => [served(f, "v0.2.0", bytes, CutOff)]);
  await check(state);
  assert.equal((await finished(state)).phase, "failed");
  // Still cut off: the job fails, and nothing is left.
  const events = subscribe(state);
  assert.equal((await api(state, "POST", "/api/admin/release/update", { version: "0.2.0" }))[0], 200);
  let [phases, error] = await job_fails(events);
  assert.deepEqual(phases, ["downloading", "failed"]);
  assert.ok(error.includes("cut off"), error);
  assert.deepEqual(app_entries(state), []);
  // Now it comes through.
  for (const f of fake.files.values()) f[1] = Whole;
  assert.equal((await api(state, "POST", "/api/admin/release/update", { version: "v0.2.0" }))[0], 200);
  [phases, error] = await job_fails(events);
  assert.deepEqual(phases, ["downloading", "verifying", "installing", "restarting", "failed"]);
  assert.ok(error.endsWith(NOT_EXEC), error);
  assert.equal(fake.downloads, 3);
  assert.equal(staging.read(staging.app_dir(state)).staged, "0.2.0");
});

test("update_refuses_what_it_cant_update_to", async () => {
  const [, state] = await setup_with((f) => [served(f, "v0.2.0", tarball("0.2.0"), Whole)]);
  const update = (v: string) => api(state, "POST", "/api/admin/release/update", { version: v });
  // Before a check, nothing is known.
  assert.equal((await update("0.2.0"))[0], 400);
  await check(state);
  await finished(state);
  for (const [v, why] of [
    ["0.1.0", "isn't older"],
    ["0.0.1", "isn't older"],
    ["0.9.0", "isn't the latest"],
    ["nope", "isn't a version"],
  ]) {
    const [code, body] = await update(v);
    assert.equal(code, 400, `${v}: ${JSON.stringify(body)}`);
    assert.ok(body.error.includes(why), `${v}: ${JSON.stringify(body)}`);
  }
  const [code] = await api(testing.state(), "POST", "/api/admin/release/update", { version: "0.2.0" });
  assert.equal(code, 400);
});

test("a_hubs_update_checks_for_its_version_and_restarts_onto_it", async () => {
  const [, state] = await setup_with((f) => [served(f, "v0.2.0", tarball("0.2.0"), Whole)]);
  assert.equal((await api(state, "GET", "/api/info"))[1].updates_from, "releases");
  // No check yet, so 0.2.0 isn't known: the hub's Update checks first. Its commit and bundle are ignored.
  const events = subscribe(state);
  const body = { commit: "abc", bundle: "eA==", branch: "master", version: "0.2.0" };
  let [code, v] = await api(state, "POST", "/api/admin/update", body);
  assert.equal(code, 200, JSON.stringify(v));
  assert.deepEqual(v, { ok: true });
  const [phases, error] = await job_fails(events);
  assert.equal(phases[phases.length - 1], "failed");
  assert.ok(phases.includes("restarting"), JSON.stringify(phases));
  assert.ok(error.endsWith(`0.2.0/huntaway: ${NOT_EXEC}`), error);
  // A hub that runs a release sends no commit.
  assert.equal(staging.read(staging.app_dir(state)).staged, "0.2.0");
  [code, v] = await api(state, "POST", "/api/admin/update", { version: "v0.2.0" });
  assert.equal(code, 200, JSON.stringify(v));
});

test("a_hubs_update_refuses_what_a_release_host_cant_go_to", async () => {
  const [, state] = await setup_with((f) => [served(f, "v0.3.0", tarball("0.3.0"), Whole), release("v0.2.0", false)]);
  const update = (b: any) => api(state, "POST", "/api/admin/update", b);
  // The same version is up to date, without a check.
  assert.deepEqual(await update({ commit: "abc", version: VERSION }), [200, { ok: true, up_to_date: true }]);
  assert.equal(status(state).checked_at, null);
  for (const [b, why] of [
    [{ commit: "abc" }, "API 89"],
    [{ commit: "abc", version: "0.0.9" }, "newer than the board's 0.0.9"],
    [{ commit: "abc", version: "nope" }, "isn't a version"],
    // A newer release than the hub's is out: this host doesn't go to the older one.
    [{ commit: "abc", version: "0.2.0" }, "the latest release is 0.3.0"],
  ] as const) {
    const [code, v] = await update(b);
    assert.equal(code, 400, `${JSON.stringify(b)}: ${JSON.stringify(v)}`);
    assert.ok(v.error.includes(why), `${JSON.stringify(b)}: ${JSON.stringify(v)}`);
  }
  assert.equal(state.restart, null, "nothing restarted");
});

test("a_checkout_host_needs_the_hubs_commit", async () => {
  let state = testing.state();
  let [code, v] = await api(state, "GET", "/api/info");
  assert.deepEqual([code, v.updates_from], [200, null]);
  // Neither a checkout nor a release install.
  [code, v] = await api(state, "POST", "/api/admin/update", { commit: "abc", version: "0.2.0" });
  assert.equal(code, 400);
  assert.ok(v.error.includes("isn't running from a source checkout"), JSON.stringify(v));
  // A hub that runs a release can't update a checkout.
  const meta = testing.meta();
  meta.source_dir = testing.temp_dir();
  state = testing.state_with(meta);
  assert.equal((await api(state, "GET", "/api/info"))[1].updates_from, "checkout");
  [code, v] = await api(state, "POST", "/api/admin/update", { version: "0.2.0" });
  assert.equal(code, 400);
  assert.ok(v.error.includes("runs a release rather than a checkout"), JSON.stringify(v));
});

/**
 * HA-153 review: a server started with --recopy-db passed it on to the version Roll back started, which, from before the
 * flag, exited on it. It's for the start it was given to, so no restart passes it on.
 */
test("rollback_leaves_out_flags_for_one_start", async () => {
  const state = host_at(config("http://unused"), "0.2.0", ["0.1.5"]);
  state.meta.args = ["serve", "--port", "7878", "--recopy-db", "--demo"];
  staging.write(staging.app_dir(state), { ...staging.Installed_default(), current: "0.2.0", previous: "0.1.5" });
  const events = subscribe(state);
  assert.equal((await api(state, "POST", "/api/admin/release/rollback"))[0], 200);
  assert.deepEqual((await job_fails(events))[0], ["restarting", "failed"]);
  assert.deepEqual(admin.exec_args(), ["serve", "--port", "7878", "--demo"]);
});

/**
 * HA-153: with the new database file, the server says which file the database is in, and copies the older builds' one
 * again only when an older build has changed it since (db/file.test.ts has the copying itself). Without it, it says
 * nothing and copies nothing.
 */
test("the_database_is_copied_again_only_when_the_older_file_has_changed", async () => {
  let [code, v] = await api(testing.state(), "GET", "/api/admin/server");
  assert.equal(code, 200);
  assert.equal(v.database, undefined);
  [code, v] = await api(testing.state(), "POST", "/api/admin/database/recopy");
  assert.equal(code, 400);
  assert.match(v.error, /doesn't use huntaway-2.db/);

  const dir = realpathSync(testing.temp_dir());
  const s = testing.state_on(db_file.open(dir, false).conn, dir);
  [code, v] = await api(s, "GET", "/api/admin/server");
  assert.deepEqual(v.database, { file: "huntaway-2.db", copied_from: null, older_changed: null });
  assert.equal((await api(s, "POST", "/api/admin/database/recopy"))[0], 400);
  assert.ok(!existsSync(join(dir, "recopy-db")));

  // An older build has made its own file since.
  writeFileSync(join(dir, "huntaway.db"), "");
  assert.equal((await api(s, "GET", "/api/admin/server"))[1].database.older_changed, "huntaway.db");
  const events = subscribe(s);
  [code, v] = await api(s, "POST", "/api/admin/database/recopy");
  assert.equal(code, 200, JSON.stringify(v));
  // A restart, without a rebuild, which asks the next start to copy it.
  const [phases, error] = await job_fails(events);
  assert.deepEqual(phases, ["restarting", "failed"]);
  assert.ok(error.endsWith(NOT_EXEC), error);
  assert.ok(existsSync(join(dir, "recopy-db")));
});

test("rollback_goes_back_to_the_previous_version", async () => {
  const state = host_at(config("http://unused"), "0.2.0", ["0.1.5"]);
  const app = staging.app_dir(state);
  staging.write(app, { ...staging.Installed_default(), current: "0.2.0", previous: "0.1.5" });
  assert.equal(release_status(state).exe, path_str(join(app, "0.2.0", "huntaway")));
  assert.equal(release_status(state).rollback_to, "0.1.5");
  assert.equal(release_status(state).previous, "0.1.5");
  const seen = at_exec(state);
  const events = subscribe(state);
  assert.equal((await api(state, "POST", "/api/admin/release/rollback"))[0], 200);
  const [phases, error] = await job_fails(events);
  assert.deepEqual(phases, ["restarting", "failed"]);
  assert.equal(error, `failed to exec ${join(app, "0.1.5/huntaway")}: ${NOT_EXEC}`);
  const s = seen.seen!;
  assert.deepEqual([s.current, s.previous, s.bad], ["0.1.5", null, ["0.2.0"]]);
  // The exec failed, so it's as it was.
  const after = staging.read(app);
  assert.deepEqual([after.current, after.previous, after.bad.length], ["0.2.0", "0.1.5", 0]);
});

/** HA-174 review: an Update or Roll back that can't back up the database fails before it changes anything. */
test("an_update_that_cant_back_up_the_database_doesnt_go_ahead", async () => {
  const [, state] = await setup_with((f) => [served(f, "v0.2.0", tarball("0.2.0"), Whole)]);
  await check(state);
  assert.equal((await finished(state)).phase, "staged");
  // Where backups go is a file, so none can be made.
  writeFileSync(join(state.data_dir, "backups"), "");
  const events = subscribe(state);
  assert.equal((await api(state, "POST", "/api/admin/release/update", { version: "0.2.0" }))[0], 200);
  const [phases, error] = await job_fails(events);
  // It didn't get as far as restarting (or exec'ing).
  assert.deepEqual(phases, ["failed"]);
  assert.ok(error.startsWith("couldn't back up the database before switching to 0.2.0, so it didn't go ahead: "), error);
  assert.ok(error.includes("IA_SKIP_DB_BACKUP=1"), error);
  const s = staging.read(staging.app_dir(state));
  assert.deepEqual([s.trying, s.staged, s.current], [null, "0.2.0", null]);
});

test("a_rollback_that_cant_back_up_the_database_doesnt_go_ahead", async () => {
  const state = host_at(config("http://unused"), "0.2.0", ["0.1.5"]);
  const app = staging.app_dir(state);
  staging.write(app, { ...staging.Installed_default(), current: "0.2.0", previous: "0.1.5" });
  writeFileSync(join(state.data_dir, "backups"), "");
  const events = subscribe(state);
  assert.equal((await api(state, "POST", "/api/admin/release/rollback"))[0], 200);
  const [phases, error] = await job_fails(events);
  // It didn't get as far as restarting (or exec'ing).
  assert.deepEqual(phases, ["failed"]);
  assert.ok(error.startsWith("couldn't back up the database before switching to 0.1.5, so it didn't go ahead: "), error);
  const after = staging.read(app);
  assert.deepEqual([after.current, after.previous, after.bad.length], ["0.2.0", "0.1.5", 0]);
});

test("a_failed_rollback_keeps_what_a_download_staged_meanwhile", async () => {
  const state = host_at(config("http://unused"), "0.2.0", ["0.1.5", "0.2.5", "0.3.0"]);
  const app = staging.app_dir(state);
  const before: Installed = { ...staging.Installed_default(), current: "0.2.0", previous: "0.1.5", staged: "0.2.5", bad: ["0.0.9"] };
  staging.write(app, before);
  // A download finishes while the rollback waits to exec: it stages 0.3.0 in place of 0.2.5, as stage_into does.
  testing.when("exec", () => {
    staging.change(state, (s) => (s.staged = "0.3.0"));
    rmSync(join(staging.app_dir(state), "0.2.5"), { recursive: true });
  });
  const events = subscribe(state);
  assert.equal((await api(state, "POST", "/api/admin/release/rollback"))[0], 200);
  const [, error] = await job_fails(events);
  assert.ok(error.endsWith(`0.1.5/huntaway: ${NOT_EXEC}`), error);
  // What the rollback changed is put back, and what the download did stands.
  assert.deepEqual(staging.read(app), { ...before, staged: "0.3.0" });
  assert.equal(release_status(state).staged, "0.3.0");
});

test("a_bad_staged_version_isnt_offered_and_is_pruned", () => {
  // An Update onto 0.3.0 didn't start: the desktop app marked it bad and started 0.2.0 again.
  const state = host_at(config("http://unused"), "0.2.0", ["0.1.5", "0.3.0"]);
  const app = staging.app_dir(state);
  staging.write(app, { ...staging.Installed_default(), current: "0.2.0", previous: "0.1.5", staged: "0.3.0", bad: ["0.3.0"] });
  assert.equal(release_status(state).staged, null);
  assert.ok(!staging.is_staged(state, "0.3.0"));
  staging.settle(state);
  const s = staging.read(app);
  assert.deepEqual([s.staged, s.bad], [null, ["0.3.0"]]);
  assert.deepEqual(app_entries(state), ["0.1.5", "0.2.0", "state.json"]);
  assert.equal(release_status(state).staged, null);
});

test("a_newer_packages_server_takes_over_from_the_versions_downloaded_before_it", () => {
  const bundled = join(testing.temp_dir(), "huntaway");
  writeFileSync(bundled, "");
  // This server is the app's own, from a package newer than what was downloaded before it: package 0.0.0-a updated to
  // 0.0.0-old, then this package was installed, so the desktop app starts its own server.
  const cfg: Config = { ...config("http://unused"), desktop_version: VERSION, bundled_server: path_str(bundled) };
  const state = host_at(cfg, null, ["0.0.0-a", "0.0.0-old"]);
  const app = staging.app_dir(state);
  const bad = ["0.0.0-b"];
  staging.write(app, { ...staging.Installed_default(), current: "0.0.0-old", previous: "0.0.0-a", bad });
  staging.settle(state);
  let s = staging.read(app);
  assert.deepEqual([s.current, s.previous, s.bad], [null, null, bad]);
  // So an Update from it to 9.0.0 rolls back to this server, not to the download it took over from.
  server_files(join(app, "9.0.0"), "echo huntaway 9.0.0");
  staging.change(state, (s) => (s.trying = "9.0.0"));
  const meta = testing.meta();
  meta.release = cfg;
  const updated = testing.state_at(meta, state.data_dir, join(app, "9.0.0/huntaway"));
  staging.settle(updated);
  s = staging.read(app);
  assert.deepEqual([s.current, s.previous, s.trying], ["9.0.0", null, null]);
  assert.equal(release_status(updated).rollback_to, "bundled");
});

test("rollback_doesnt_go_back_past_the_apps_own_server", () => {
  // app/state.json says 0.2.0 was before 0.5.0, but the app is 0.4.0: it starts its own server over 0.2.0.
  const bundled = join(testing.temp_dir(), "huntaway");
  writeFileSync(bundled, "");
  const cfg: Config = { ...config("http://unused"), desktop_version: "0.4.0", bundled_server: path_str(bundled) };
  let state = host_at(cfg, "0.5.0", ["0.2.0", "0.4.5"]);
  const app = staging.app_dir(state);
  staging.write(app, { ...staging.Installed_default(), current: "0.5.0", previous: "0.2.0" });
  assert.equal(release_status(state).rollback_to, "bundled");
  // One at least as new as the app's still counts.
  staging.write(app, { ...staging.Installed_default(), current: "0.5.0", previous: "0.4.5" });
  assert.equal(release_status(state).rollback_to, "0.4.5");
  // Without a bundled server to go back to, there's nothing.
  state = host_at({ ...cfg, bundled_server: null }, "0.5.0", ["0.2.0"]);
  staging.write(staging.app_dir(state), { ...staging.Installed_default(), current: "0.5.0", previous: "0.2.0" });
  assert.equal(release_status(state).rollback_to, null);
});

test("rollback_without_a_previous_version_starts_the_bundled_server", async () => {
  const bundled = join(testing.temp_dir(), "huntaway");
  writeFileSync(bundled, "");
  const cfg: Config = { ...config("http://unused"), bundled_server: path_str(bundled) };
  let state = host_at(cfg, "0.2.0", []);
  const app = staging.app_dir(state);
  // A previous version that's bad, or missing its files, doesn't count.
  staging.write(app, { ...staging.Installed_default(), current: "0.2.0", previous: "0.1.5" });
  assert.equal(release_status(state).rollback_to, "bundled");
  const seen = at_exec(state);
  const events = subscribe(state);
  assert.equal((await api(state, "POST", "/api/admin/release/rollback"))[0], 200);
  const [, error] = await job_fails(events);
  assert.equal(error, `failed to exec ${bundled}: ${NOT_EXEC}`);
  const s = seen.seen!;
  assert.deepEqual([s.current, s.bad], [null, ["0.2.0"]]);
  // Without a bundled server either, there's nothing to roll back to.
  state = host_at({ ...config("http://unused"), bundled_server: null }, "0.2.0", []);
  assert.equal(release_status(state).rollback_to, null);
  assert.equal((await api(state, "POST", "/api/admin/release/rollback"))[0], 400);
  // Nor for a server that isn't running from app/.
  state = host_at(config("http://unused"), null, ["0.1.5"]);
  assert.equal((await api(state, "POST", "/api/admin/release/rollback"))[0], 400);
});
