// Port of server/src/update/staging.rs: the per-user install dir release updates use, `<data dir>/app/` (see
// update/release.ts):
//
// - `<v>/`: a release's server tarball, unpacked (`huntaway`, `ia-shim` and `ui/index.html` side by side)
// - `<v>.partial/`: one being downloaded or unpacked
// - `state.json`: `{current, previous, staged, trying, bad}`, which the desktop app reads and writes too
//   (apps/web/electron/versions.cjs), so it's written through a temp file and a rename, and keeps the keys it doesn't know.
//
// A release found by a check is downloaded, verified and unpacked here in the background ("staged"), and Update
// restarts onto it. A server running from `app/<v>/huntaway` settles on startup: it becomes `current`, and the
// versions nothing needs any more are deleted. (A release is this server from 0.4.0 on, and the Rust server before that,
// which stages releases and restarts onto them in the same way.)
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { constants as os_constants } from "node:os";
import { basename, dirname, join } from "node:path";
import type { AppState } from "../state.ts";
import { err_str, new_id, remove_dir_all, remove_dir_all_async } from "../util.ts";
import { VERSION } from "../hosts/proto.ts";
import * as release from "./release.ts";
import { compare, parse_version, type Semver } from "./release.ts";

const log = {
  info: (m: string) => console.error(`${new Date().toISOString()}  INFO huntaway::update::staging: ${m}`),
  warn: (m: string) => console.error(`${new Date().toISOString()}  WARN huntaway::update::staging: ${m}`),
};

/** `app/state.json`. Keys written by a newer server or the desktop app are kept as they are. */
export interface Installed {
  /** The version that last came up from `app/`. */
  current: string | null;
  /** The one before it, kept for a rollback. */
  previous: string | null;
  /** Downloaded and checked, waiting for Update. */
  staged: string | null;
  /** The one an Update is exec'ing into, until it's up. */
  trying: string | null;
  /** Versions that didn't start or were rolled back from, which aren't offered again. */
  bad: string[];
  [other: string]: any;
}

export function Installed_default(): Installed {
  return { current: null, previous: null, staged: null, trying: null, bad: [] };
}

export function is_bad(s: Installed, v: string): boolean {
  return s.bad.includes(v);
}

/** A copy of `s` (the struct's `Clone`). */
function cloned(s: Installed): Installed {
  return JSON.parse(JSON.stringify(s));
}

/** `s == t`, field by field (the struct's `PartialEq`, unknown keys included). */
export function Installed_eq(s: Installed, t: Installed): boolean {
  return JSON.stringify(ordered(s)) === JSON.stringify(ordered(t));
}

/** `s` as serde writes it: the known fields first, then the others in order (serde_json's `Map` sorts its keys). */
function ordered(s: Installed): any {
  const { current, previous, staged, trying, bad, ...other } = s;
  const rest: any = {};
  for (const k of Object.keys(other).sort()) rest[k] = other[k];
  return { current, previous, staged, trying, bad, ...rest };
}

export function app_dir(state: AppState): string {
  return join(state.data_dir, "app");
}

/** `app/<v>`, for a `v` that is a version (so it can't lead out of `app/`). */
export function version_dir(app: string, v: string): string | null {
  return parse_version(v) ? join(app, v) : null;
}

/** Whether `dir` has what a server needs: itself, the shim its agents run under, and the UI it serves. */
export function complete(dir: string): boolean {
  return ["huntaway", "ia-shim", "ui/index.html"].every((f) => {
    try {
      return lstatSync(join(dir, f)).isFile();
    } catch {
      return false;
    }
  });
}

/** `app/state.json`, or the default when there's none or it can't be read. */
export function read(app: string): Installed {
  const file = join(app, "state.json");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return Installed_default();
  }
  let v: any;
  try {
    v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("invalid type: expected struct Installed");
  } catch (e) {
    log.warn(`ignoring ${file}: ${err_str(e)}`);
    return Installed_default();
  }
  // A version, or none for anything else: the file is shared, so one odd value doesn't lose the rest.
  const str = (x: any) => (typeof x === "string" ? x : null);
  return {
    ...v,
    current: str(v.current),
    previous: str(v.previous),
    staged: str(v.staged),
    trying: str(v.trying),
    bad: Array.isArray(v.bad) ? v.bad.filter((b: any) => typeof b === "string") : [],
  };
}

/** Write `app/state.json` through a temp file and a rename, so the desktop app never reads half of it. */
export function write(app: string, s: Installed) {
  mkdirSync(app, { recursive: true });
  const file = join(app, "state.json");
  const tmp = join(app, `state.json.${new_id()}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(ordered(s), null, 2)}\n`);
  } catch (e) {
    throw new Error(`writing ${tmp}`, { cause: e });
  }
  try {
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw new Error(`renaming ${tmp} to ${file}`, { cause: e });
  }
}

/**
 * Change `app/state.json`, one change at a time in this server (it's synchronous, and this server has one thread).
 * Returns it as it was.
 */
export function change(state: AppState, f: (s: Installed) => void): Installed {
  const app = app_dir(state);
  const old = read(app);
  const next = cloned(old);
  f(next);
  if (!Installed_eq(next, old)) write(app, next);
  return old;
}

/** The version this server runs from `app/`, when its binary is `<data dir>/app/<v>/huntaway`. */
export function running_from_app(data_dir: string, exe: string): string | null {
  try {
    const real = realpathSync(exe);
    if (basename(real) !== "huntaway") return null;
    const dir = dirname(real);
    if (dirname(dir) !== realpathSync(join(data_dir, "app"))) return null;
    const v = basename(dir);
    return parse_version(v) ? v : null;
  } catch {
    return null;
  }
}

/** Whether `v` is staged: `staged` in state.json, with all its files, and not bad. */
export function is_staged(state: AppState, v: string): boolean {
  const app = app_dir(state);
  return staged(app, read(app)) === v;
}

/**
 * The staged version in `s`, if it has all its files and isn't bad (an Update onto it that didn't start, which the
 * desktop app marks bad but leaves staged).
 */
export function staged(app: string, s: Installed): string | null {
  const v = s.staged;
  if (v === null || is_bad(s, v)) return null;
  const d = version_dir(app, v);
  return d !== null && complete(d) ? v : null;
}

/** Unstage the staged version unless `keep` says it's still offered, and delete it unless state.json names it as something else. */
export function unstage_unless(state: AppState, keep: (v: Semver) => boolean) {
  const app = app_dir(state);
  const s = read(app);
  const v = s.staged;
  if (v === null) return;
  const staged_v = parse_version(v);
  if (staged_v && keep(staged_v)) return;
  log.info(`unstaging release ${v}, which the last check didn't offer`);
  s.staged = null;
  try {
    write(app, s);
  } catch (e) {
    return log.warn(`unstaging release ${v}: ${err_str(e)}`);
  }
  if ([s.current, s.previous, s.trying].includes(v)) return;
  const dir = version_dir(app, v);
  if (dir !== null && existsSync(dir)) {
    try {
      remove_dir_all(dir);
    } catch (e) {
      log.warn(`removing ${dir}: ${err_str(e)}`);
    }
  }
}

/**
 * For a server running from `app/<v>/huntaway`: make `v` current (and the one it replaced previous, after an Update),
 * and delete what nothing needs: leftover downloads, and every version but current, previous and staged. Runs on
 * startup, before the desktop app is told the server is up.
 */
export function settle(state: AppState): string | null {
  const v = running_from_app(state.data_dir, state.exe);
  if (v === null) {
    // The desktop app's own server: maybe from a newer package than the versions downloaded before it.
    if (state.meta.release !== null) {
      const running = parse_version(VERSION);
      if (!running) throw new Error(`${VERSION} isn't a version`);
      let forgot = false;
      change(state, (s) => (forgot = superseded(s, running)));
      if (forgot) log.info(`this server (${VERSION}) is newer than the releases installed in app/ before it; forgetting them`);
    }
    return null;
  }
  const now = change(state, (s) => settled(s, v));
  settled(now, v);
  log.info(`running release ${v} (previous ${now.previous ?? "none"})`);
  prune(app_dir(state), now);
  return v;
}

/**
 * For a server whose version nothing else chooses (a tarball's, which its supervisor starts again after a reboot), the
 * version in `app/` to exec instead, as the desktop app chooses (`chooseServer` in apps/web/electron/versions.cjs): `current`,
 * else `previous`, the first newer than `running` (so a newer tarball wins over older downloads) that isn't bad and has
 * its files. It's set as `trying`, which it clears once it's listening (`settle`).
 *
 * A `trying` still set here never came up, from an Update or an earlier start like this one, so it's marked bad first:
 * a version that exits on startup is tried once, rather than on every restart.
 */
export function choose_at_startup(app: string, running: Semver): [string, string] | null {
  const old = read(app);
  const s = cloned(old);
  const t = s.trying;
  s.trying = null;
  if (t !== null) {
    log.warn(`release ${t} didn't start last time, so it isn't started or offered again`);
    if (!is_bad(s, t)) s.bad.push(t);
  }
  const newer = (v: string) => {
    const p = parse_version(v);
    return p !== null && compare(p, running) > 0;
  };
  const pick =
    [s.current, s.previous].find((v): v is string => {
      if (v === null || is_bad(s, v) || !newer(v)) return false;
      const d = version_dir(app, v);
      return d !== null && complete(d);
    }) ?? null;
  // Falling back to previous: it's current now, rather than the one passed over becoming previous when it settles.
  if (pick !== null && pick !== s.current) {
    s.current = pick;
    s.previous = null;
  }
  s.trying = pick;
  if (!Installed_eq(s, old)) write(app, s);
  return pick === null ? null : [pick, join(app, pick, "huntaway")];
}

/**
 * For a server that isn't running from `app/` (the desktop app's own, from a package installed after the versions there
 * were downloaded): forget `current` and `previous` where they're older than it. The desktop app doesn't start those
 * any more, so an Update from this server mustn't make one previous, and Roll back mustn't go back to it. Whether it
 * changed anything.
 */
function superseded(s: Installed, running: Semver): boolean {
  const older = (v: string | null) => {
    const p = v === null ? null : parse_version(v);
    return p !== null && compare(p, running) < 0;
  };
  let changed = false;
  for (const k of ["current", "previous"] as const) {
    if (older(s[k])) {
      s[k] = null;
      changed = true;
    }
  }
  return changed;
}

function settled(s: Installed, v: string) {
  if (s.trying === v) {
    if (s.current !== v) {
      s.previous = s.current;
      s.current = null;
    }
    s.trying = null;
  }
  s.current = v;
  // Staged is for a newer version, and one that's bad isn't offered again (so its dir is pruned).
  const running = parse_version(v);
  const st = s.staged;
  if (st !== null) {
    const sv = parse_version(st);
    // Rust compares `Option<Version>`s: None is below every version.
    const not_newer = sv === null ? true : running === null ? false : compare(sv, running) <= 0;
    if (not_newer || is_bad(s, st)) s.staged = null;
  }
}

/**
 * Delete everything in `app/` but `state.json` and the versions `s` names (current, previous, staged, and one an Update
 * is still trying): leftover `.partial` downloads, temp files and versions nothing needs.
 */
export function prune(app: string, s: Installed) {
  const keep = [s.current, s.previous, s.staged, s.trying].filter((k): k is string => k !== null);
  let entries;
  try {
    entries = readdirSync(app, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const name = e.name;
    if (name === "state.json" || keep.includes(name)) continue;
    const path = join(app, name);
    const is_dir = e.isDirectory();
    // Files the desktop app put here are left alone, but for state.json's temp files.
    if (!is_dir && !(name.startsWith("state.json.") && name.endsWith(".tmp"))) continue;
    log.info(`removing ${path}`);
    try {
      if (is_dir) remove_dir_all(path);
      else rmSync(path);
    } catch (err) {
      log.warn(`removing ${path}: ${err_str(err)}`);
    }
  }
}

// ---------- downloading a release ----------

/** A release's server tarball for this platform. */
export interface Asset {
  name: string;
  url: string;
  size: number;
  /** Its sha256 (hex), as the GitHub API lists it. */
  sha256: string;
}

/** The download in progress (or the last one), in `release.download`. */
export interface Download {
  version: string;
  /** `downloading`, `verifying`, `installing`, `failed`, or `staged` once it's done (reported as no download). */
  phase: string;
  bytes: number;
  total: number | null;
  error: string | null;
}

export function Download_running(d: Download): boolean {
  return ["downloading", "verifying", "installing"].includes(d.phase);
}

/** As `release.download` reports it: a staged one is done, and reported as `release.staged` instead. */
export function Download_reported(d: Download): Download | null {
  return d.phase === "staged" ? null : d;
}

/** What `start` did: `Started`; `Busy` (another download is running, of `release.download`'s version); `Staged` (the version is staged already). */
export type Start = "Started" | "Busy" | "Staged";

/**
 * Download, verify and unpack `version` into `app/<version>/` in the background, then stage it, unless a download is
 * running already: there's one at a time.
 */
export function start(state: AppState, version: string, asset: Asset): Start {
  const one = state.release.staging.try_lock();
  if (one === null) return "Busy";
  if (is_staged(state, version)) {
    one();
    return "Staged";
  }
  const total = asset.size > 0 ? asset.size : null;
  set_download(state, { version, phase: "downloading", bytes: 0, total, error: null });
  (async () => {
    let done: () => void = () => {};
    try {
      done = await stage(state, version, asset);
    } finally {
      // Recording how it went, letting the next download start and looking for one are one step, as in the Rust
      // server's task: an Update following this download sees it staged only once `downloaded` has had its say.
      done();
      one();
      release.downloaded(state, version);
    }
  })().catch((e) => log.warn(`staging release ${version}: ${err_str(e)}`));
  return "Started";
}

export function set_download(state: AppState, d: Download) {
  state.release.download.send_replace(d);
  emit_download(state);
}

function emit_download(state: AppState) {
  const d = state.release.download.borrow();
  state.emit({ type: "release_download", download: d ? Download_reported({ ...d }) : null });
}

function set_phase(state: AppState, phase: string) {
  state.release.download.send_modify((d) => {
    if (d) d.phase = phase;
  });
  emit_download(state);
}

/** Stage `version`. A failure leaves nothing behind. Returns what records how it went in `release.download`. */
async function stage(state: AppState, version: string, asset: Asset): Promise<() => void> {
  const app = app_dir(state);
  const partial = join(app, `${version}.partial`);
  try {
    await stage_into(state, app, partial, version, asset);
    log.info(`release ${version} is staged`);
    return () => set_phase(state, "staged");
  } catch (e) {
    const msg = err_str(e);
    log.warn(`staging release ${version}: ${msg}`);
    await remove_dir_all_async(partial).catch(() => {});
    return () => {
      state.release.download.send_modify((d) => {
        if (d) {
          d.phase = "failed";
          d.error = msg;
        }
      });
      emit_download(state);
    };
  }
}

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};

async function stage_into(state: AppState, app: string, partial: string, version: string, asset: Asset) {
  const dest = version_dir(app, version);
  if (dest === null) throw new Error(`${JSON.stringify(version)} isn't a version`);
  const [d, exe] = [real(join(dest, "huntaway")), real(state.exe)];
  if (d !== null && exe !== null && d === exe) throw new Error(`${version} is the version running`);
  // There's one download at a time, so any other is one a restart cut off.
  let entries: string[] = [];
  try {
    entries = readdirSync(app);
  } catch {}
  for (const e of entries.filter((e) => e.endsWith(".partial"))) await remove_dir_all_async(join(app, e)).catch(() => {});
  try {
    await mkdir(partial, { recursive: true });
  } catch (e) {
    throw new Error(`making ${partial}`, { cause: e });
  }
  const tarball = join(partial, "download.tar.gz");
  let sha256: string;
  try {
    sha256 = await download(state, asset, tarball);
  } catch (e) {
    throw new Error(`downloading ${asset.name}`, { cause: e });
  }

  set_phase(state, "verifying");
  if (sha256.toLowerCase() !== asset.sha256.toLowerCase()) throw new Error(`${asset.name} has sha256 ${sha256}, not the ${asset.sha256} GitHub lists for it`);
  try {
    check_entries(await tar(["-tzf", tarball]));
    check_types(await tar(["-tvzf", tarball]));
  } catch (e) {
    throw new Error(`${asset.name} can't be unpacked`, { cause: e });
  }

  set_phase(state, "installing");
  await tar(["-xzf", tarball, "-C", partial, "--strip-components=1", "--no-same-owner"]);
  await rm(tarball);
  if (!complete(partial)) throw new Error(`${asset.name} doesn't have huntaway, ia-shim and ui/index.html`);
  await smoke_test(join(partial, "huntaway"), version);
  // The state is changed in one go (synchronously), so a dir that's staged is always there.
  let replaced: string | null;
  {
    if (existsSync(dest)) {
      try {
        remove_dir_all(dest);
      } catch (e) {
        throw new Error(`removing ${dest}`, { cause: e });
      }
    }
    try {
      renameSync(partial, dest);
    } catch (e) {
      throw new Error(`renaming ${partial} to ${dest}`, { cause: e });
    }
    const s = read(app);
    const old = s.staged;
    s.staged = version;
    write(app, s);
    // A newer release replaces one that was never used.
    replaced = old !== null && old !== version && ![s.current, s.previous, s.trying].includes(old) ? old : null;
  }
  const dir = replaced === null ? null : version_dir(app, replaced);
  if (dir !== null) {
    log.info(`removing ${dir}, which ${version} replaces`);
    await remove_dir_all_async(dir).catch((e) => log.warn(`removing ${dir}: ${err_str(e)}`));
  }
}

/** How long a download may go without a byte before it's given up on. */
const STALLED = 60_000;

/** `p`, or an error saying `what` once `ms` pass. */
function timeout<T>(p: Promise<T>, ms: number, what: () => string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<never>((_, fail) => (timer = setTimeout(() => fail(new Error(what())), ms)))]).finally(() => clearTimeout(timer));
}

/** Stream `asset` to `file`, hashing it as it comes. Returns its sha256 (hex). */
async function download(state: AppState, asset: Asset, file: string): Promise<string> {
  const abort = new AbortController();
  const res = await timeout(fetch(asset.url, { headers: { "user-agent": `huntaway/${VERSION}` }, signal: abort.signal }), STALLED, () => "no answer");
  try {
    if (!res.ok) throw new Error(`${asset.url} answered ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`);
    const length = res.headers.get("content-length");
    const total = length !== null && /^\d+$/.test(length) ? Number(length) : asset.size > 0 ? asset.size : null;
    state.release.download.send_modify((d) => {
      if (d) d.total = total;
    });
    let out;
    try {
      out = await open(file, "w");
    } catch (e) {
      throw new Error(`making ${file}`, { cause: e });
    }
    const hash = createHash("sha256");
    let bytes = 0;
    let emitted = Date.now();
    try {
      const reader = res.body!.getReader();
      for (;;) {
        let chunk: { done: boolean; value?: Uint8Array };
        try {
          chunk = await timeout(reader.read(), STALLED, () => `it stalled at ${bytes} bytes`);
        } catch (e) {
          if (e instanceof Error && e.message.startsWith("it stalled")) throw e;
          throw new Error(`it was cut off at ${bytes} bytes`, { cause: e });
        }
        if (chunk.done) break;
        hash.update(chunk.value!);
        await out.write(chunk.value!);
        bytes += chunk.value!.length;
        state.release.download.send_modify((d) => {
          if (d) d.bytes = bytes;
        });
        if (Date.now() - emitted > 500) {
          emitted = Date.now();
          emit_download(state);
        }
      }
    } finally {
      await out.close();
    }
    if (total !== null && total !== bytes) throw new Error(`it was cut off at ${bytes} of ${total} bytes`);
    return hash.digest("hex");
  } finally {
    abort.abort();
  }
}

/** Run the system tar (GNU tar, or bsdtar on a mac) and return what it printed. */
function tar(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("tar", args, { timeout: 300_000, maxBuffer: 64 << 20, encoding: "utf8" }, (e, stdout, stderr) => {
      if (e && (e as any).killed) return reject(new Error("tar timed out"));
      if (e && typeof (e as any).code !== "number") return reject(new Error("running tar", { cause: e }));
      if (e) return reject(new Error(`tar ${args[0]} failed: ${stderr.trim()}`));
      resolve(stdout);
    });
    child.stdin?.end();
  });
}

/**
 * The tarball's entries (`tar -t`) must all be in one top folder (which unpacking strips), with no absolute paths or
 * `..` that could lead out of it.
 */
export function check_entries(listing: string) {
  let top: string | null = null;
  for (const name of listing.split("\n").filter((l) => l !== "")) {
    // Rust's `Path::components`: empty parts and `.`s after the first are dropped.
    const parts = name.split("/").filter((p, i) => p !== "" && !(i > 0 && p === "."));
    const first = parts[0];
    if (name.startsWith("/") || first === undefined || first === "." || first === "..") throw new Error(`it has an entry outside its folder: ${name}`);
    if (parts.slice(1).some((p) => p === "..")) throw new Error(`it has an entry outside its folder: ${name}`);
    if (top !== null && top !== first) throw new Error(`it has more than one top folder (${top} and ${first})`);
    top = first;
  }
  if (top === null) throw new Error("it's empty");
}

/** The tarball's entries (`tar -tv`) must be files and folders: a link could point out of the folder it unpacks to. */
export function check_types(listing: string) {
  for (const line of listing.split("\n").filter((l) => l !== "")) {
    if (!line.startsWith("-") && !line.startsWith("d")) throw new Error(`it has an entry that isn't a file or a folder: ${line}`);
  }
}

/** Run `huntaway --version`, which must succeed and print `version`. */
function smoke_test(exe: string, version: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(exe, ["--version"], { timeout: 30_000, encoding: "utf8" }, (e, stdout, stderr) => {
      if (e && (e as any).killed && (e as any).signal === "SIGTERM" && typeof (e as any).code !== "number")
        return reject(new Error(`${exe} --version didn't finish`));
      if (e && typeof (e as any).code !== "number" && !(e as any).signal) return reject(new Error(`running ${exe} --version`, { cause: e }));
      if (e) {
        const status = (e as any).signal ? `signal: ${signal_number((e as any).signal)} (${(e as any).signal})` : `exit status: ${(e as any).code}`;
        return reject(new Error(`huntaway --version failed with ${status}: ${stderr.trim()}`));
      }
      if (!stdout.split(/\s+/).some((w) => (w.startsWith("v") ? w.slice(1) : w) === version)) {
        return reject(new Error(`huntaway --version printed ${JSON.stringify(stdout.trim())}, not ${version}`));
      }
      resolve();
    });
    child.stdin?.end();
  });
}

/** A signal's number, as Rust's `ExitStatus` shows it. */
function signal_number(name: string): number | string {
  const n = (os_constants.signals as any)[name];
  return typeof n === "number" ? n : name;
}
