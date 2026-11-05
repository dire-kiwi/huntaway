// Port of server/src/update/release.rs: updates for release installs (the desktop app's packages, or a server installed
// from a release tarball): with `--release-updates <OWNER/REPO>`, check that repository's GitHub releases for a newer
// server, and report what was found in `GET /admin/server` (API 88). A newer release is downloaded into `<data dir>/app/`
// in the background (see update/staging.ts), `POST /admin/release/update` restarts onto it, and
// `POST /admin/release/rollback` goes back to the version before.
//
// A release is the Rust server: the TypeScript server restarts onto one through `bin/huntaway` (see admin.ts's `exec`),
// which keeps its process id, as the Rust server's exec does.
import * as backup from "../backup.ts";
import * as db from "../db.ts";
import { ApiError } from "../http.ts";
import { AsyncMutex, type AppState } from "../state.ts";
import { background, err_str, now, path_str } from "../util.ts";
import { VERSION } from "../hosts/proto.ts";
import * as admin from "./admin.ts";
import * as staging from "./staging.ts";
import type { Asset, Download, Installed } from "./staging.ts";
import { statSync } from "node:fs";
import { join } from "node:path";

const log = {
  info: (m: string) => console.error(`${new Date().toISOString()}  INFO huntaway::update::release: ${m}`),
  warn: (m: string) => console.error(`${new Date().toISOString()}  WARN huntaway::update::release: ${m}`),
};

/** The settings key for "Include prereleases" (`"true"` when on). */
export const PRERELEASES = "release_prereleases";

const FIRST_CHECK = 30_000;
const CHECK_EVERY = 6 * 60 * 60_000;

/** What `--release-updates` and the desktop app's environment say, read at startup. */
export interface Config {
  /** `OWNER/REPO` on GitHub. */
  repo: string;
  /** The GitHub API's base URL (`IA_RELEASE_API`, for tests). */
  api: string;
  /** `<os>-<arch>` as the release's asset names have it (`linux-x64`, `mac-arm64`). */
  platform: string;
  /** The desktop app's version (`IA_DESKTOP_VERSION`), when the app started this server. */
  desktop_version: string | null;
  /** Its shell stamp (`IA_DESKTOP_SHELL`), compared with a release's `huntaway-<v>-release.json`. */
  desktop_shell: string | null;
  /** How the app was installed (`IA_DESKTOP_INSTALL`): `pacman`, `appimage:<path>`, `mac:<.app path>` or `other`. */
  desktop_install: string | null;
  /** The package's own server (`IA_BUNDLED_SERVER`), to fall back to. */
  bundled_server: string | null;
}

/** The config for `--release-updates <repo>`, or an error for a repo that isn't `OWNER/REPO`. */
export function Config_from_env(repo: string): Config {
  repo = repo.trim();
  const valid = (s: string) => /^[A-Za-z0-9_.-]+$/.test(s);
  const i = repo.indexOf("/");
  if (i < 0 || !valid(repo.slice(0, i)) || !valid(repo.slice(i + 1))) throw new Error(`--release-updates ${JSON.stringify(repo)} isn't OWNER/REPO`);
  const v = (k: string) => {
    const x = process.env[k]?.trim();
    return x ? x : null;
  };
  return {
    repo,
    api: (v("IA_RELEASE_API") ?? "https://api.github.com").replace(/\/+$/, ""),
    platform: platform(),
    desktop_version: v("IA_DESKTOP_VERSION"),
    desktop_shell: v("IA_DESKTOP_SHELL"),
    desktop_install: v("IA_DESKTOP_INSTALL"),
    bundled_server: v("IA_BUNDLED_SERVER"),
  };
}

/**
 * On the startup of a server with release updates that the desktop app didn't start (a tarball host's, started again by
 * its supervisor after a reboot, say): exec the release in `app/` it last updated to, when that's newer than this one
 * (`staging::choose_at_startup`). The desktop app chooses for the servers it starts, and a server in `app/` is the one
 * chosen. Returns when there's nothing to start, or the exec failed.
 *
 * Exec'ing is `bin/huntaway`'s (see admin.ts's `exec`): a server started otherwise (`node src/main.ts`) runs itself.
 */
export function exec_installed(data_dir: string) {
  if (process.env.IA_DESKTOP_VERSION) return;
  if (!admin.can_exec()) return;
  const exe = admin.current_exe();
  if (staging.running_from_app(data_dir, exe) !== null) return;
  const app = join(data_dir, "app");
  let pick: [string, string] | null;
  try {
    pick = staging.choose_at_startup(app, running());
  } catch (e) {
    return log.warn(`choosing a release in ${app} to start: ${err_str(e)}`);
  }
  if (pick === null) return;
  const [v, bin] = pick;
  log.info(`starting release ${v}, which this host last updated to, from ${bin}`);
  // So that Roll back can come back to this server.
  const env: Array<[string, string]> = process.env.IA_BUNDLED_SERVER ? [] : [["IA_BUNDLED_SERVER", exe]];
  const err = admin.exec(bin, process.argv.slice(2), env);
  log.warn(`starting ${bin}: ${err_str(err)}; running ${VERSION} instead`);
  const s = staging.read(app);
  if (s.trying === v) {
    s.trying = null;
    s.bad.push(v);
    try {
      staging.write(app, s);
    } catch (e) {
      log.warn(`marking the release bad: ${err_str(e)}`);
    }
  }
}

/** This machine's `<os>-<arch>`, with the names `release.yml` uses. */
function platform(): string {
  const os = process.platform === "darwin" ? "mac" : process.platform;
  return `${os}-${process.arch}`;
}

// ---------- versions (the `semver` crate's ordering) ----------

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
  /** Build metadata (`+…`), which the semver crate compares last, as a tiebreaker. */
  build: string;
  text: string;
}

/** A semver version (`1.2.3`, `1.2.3-rc.1`, `1.2.3+build`), or null. */
export function parse_version(v: string): Semver | null {
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(v);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split(".") : [], build: m[5] ?? "", text: v };
}

/** Semver precedence: < 0, 0 or > 0. */
export function compare(a: Semver, b: Semver): number {
  for (const k of ["major", "minor", "patch"] as const) if (a[k] !== b[k]) return a[k] - b[k];
  if (!a.pre.length !== !b.pre.length) return a.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (i >= a.pre.length) return -1;
    if (i >= b.pre.length) return 1;
    const [x, y] = [a.pre[i], b.pre[i]];
    const [nx, ny] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (nx && ny && Number(x) !== Number(y)) return Number(x) - Number(y);
    if (nx !== ny) return nx ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return a.build === b.build ? 0 : a.build < b.build ? -1 : 1;
}

/** A version as semver writes it (its `Display`). */
export const version_string = (v: Semver) => `${v.major}.${v.minor}.${v.patch}${v.pre.length ? `-${v.pre.join(".")}` : ""}${v.build ? `+${v.build}` : ""}`;

/** The version this server runs. */
export function running(): Semver {
  return parse_version(VERSION)!;
}

// ---------- releases ----------

/** A release from `GET /repos/{repo}/releases`, with the fields used here. */
export interface GhRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  body: string | null;
  html_url: string;
  assets: GhAsset[];
}

export interface GhAsset {
  name: string;
  browser_download_url: string;
  size: number;
  /** `sha256:<hex>` (GitHub fills it in for assets uploaded since mid 2025). */
  digest: string | null;
}

/** serde's deserialization of a `GhAsset`. */
export function GhAsset_from_json(a: any): GhAsset {
  if (typeof a?.name !== "string") throw new Error("missing field `name`");
  if (typeof a.browser_download_url !== "string") throw new Error("missing field `browser_download_url`");
  return { name: a.name, browser_download_url: a.browser_download_url, size: typeof a.size === "number" ? a.size : 0, digest: typeof a.digest === "string" ? a.digest : null };
}

/** serde's deserialization of a `GhRelease`. */
export function GhRelease_from_json(r: any): GhRelease {
  if (typeof r?.tag_name !== "string") throw new Error("missing field `tag_name`");
  return {
    tag_name: r.tag_name,
    draft: r.draft === true,
    prerelease: r.prerelease === true,
    published_at: typeof r.published_at === "string" ? r.published_at : null,
    body: typeof r.body === "string" ? r.body : null,
    html_url: typeof r.html_url === "string" ? r.html_url : "",
    assets: (Array.isArray(r.assets) ? r.assets : []).map(GhAsset_from_json),
  };
}

function sha256(a: GhAsset): string | null {
  const hex = a.digest?.startsWith("sha256:") ? a.digest.slice(7) : null;
  return hex && /^[0-9a-fA-F]{64}$/.test(hex) ? hex : null;
}

function asset_json(a: GhAsset) {
  return { name: a.name, url: a.browser_download_url, size: a.size, sha256: sha256(a) };
}

function to_asset(a: GhAsset): Asset | null {
  const hex = sha256(a);
  return hex === null ? null : { name: a.name, url: a.browser_download_url, size: a.size, sha256: hex };
}

/** A release's `huntaway-<v>-release.json`: which desktop shell it was built with. */
export interface Manifest {
  shell: string;
}

/** The release a check picked. */
export interface Latest {
  version: Semver;
  release: GhRelease;
  /** Its server tarball for this platform. */
  asset: GhAsset;
  /** Its manifest, when it has one and it could be read. */
  manifest: Manifest | null;
}

interface Checked {
  /** The last list GitHub sent, and its ETag, so a 304 can be picked from again. */
  etag: string | null;
  releases: GhRelease[] | null;
  latest: Latest | null;
  checked_at: string | null;
  error: string | null;
  /** When GitHub's rate limit resets, if the last check ran into it. */
  rate_limit_reset: string | null;
}

/**
 * A value that can be waited on for changes (tokio's `watch` channel): `borrow()` reads it, and `changed(seen)`
 * resolves once `version` has gone past `seen`.
 */
export class Watch<T> {
  value: T;
  version = 0;
  private waiters: Array<() => void> = [];
  constructor(v: T) {
    this.value = v;
  }
  borrow(): T {
    return this.value;
  }
  send_replace(v: T) {
    this.value = v;
    this.notify();
  }
  send_modify(f: (v: T) => void) {
    f(this.value);
    this.notify();
  }
  changed(seen: number): Promise<void> {
    if (this.version > seen) return Promise.resolve();
    return new Promise((r) => this.waiters.push(r));
  }
  private notify() {
    this.version++;
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }
}

/** What the checks found (in `AppState.release`), and the download of the release they found. */
export class Releases {
  last: Checked = { etag: null, releases: null, latest: null, checked_at: null, error: null, rate_limit_reset: null };
  /** Held for a check, so there's one at a time. */
  checking = new AsyncMutex();
  /** The download in progress, or the last one (see staging.start). */
  download = new Watch<Download | null>(null);
  /** Held for a download, so there's one at a time. */
  staging = new AsyncMutex();
}

/** GitHub turned a request away for the rate limit. */
class RateLimited extends Error {
  reset: string | null;
  constructor(reset: string | null) {
    super(reset ? `GitHub's rate limit for release checks is used up until ${reset}` : "GitHub's rate limit for release checks is used up");
    this.reset = reset;
  }
}

/** Whether "Include prereleases" is on. */
export function prereleases(state: AppState): boolean {
  return db.get_setting(state.db(), PRERELEASES) === "true";
}

/** With `--release-updates`, check 30 seconds after start and then every 6 hours. */
export function start(state: AppState) {
  const cfg = state.meta.release;
  if (!cfg) return;
  log.info(`checking ${cfg.repo}'s GitHub releases for updates`);
  const check_now = () => background("checking for releases", check(state));
  setTimeout(() => {
    check_now();
    setInterval(check_now, CHECK_EVERY).unref();
  }, FIRST_CHECK).unref();
}

/** Check in the background (when "Include prereleases" changes). */
export function check_soon(state: AppState) {
  if (!state.meta.release) return;
  background("checking for releases", check(state));
}

/** Ask GitHub for the releases and pick the newest one this server could update to. A failed check keeps what the last one found, with the error. */
export async function check(state: AppState): Promise<void> {
  const cfg = state.meta.release;
  if (!cfg) return;
  const one = await state.release.checking.lock();
  try {
    const last = state.release.last;
    const next: Checked = { ...last, checked_at: now(), rate_limit_reset: null };
    try {
      const [etag, releases, latest] = await check_with(state, cfg, last);
      Object.assign(next, { etag, releases, latest, error: null });
    } catch (e) {
      log.warn(`checking ${cfg.repo} for releases: ${err_str(e)}`);
      next.rate_limit_reset = rate_limited(e)?.reset ?? null;
      next.error = err_str(e);
    }
    state.release.last = next;
    unstage_unpicked(state);
    state.emit({ type: "release_checked" });
    stage_latest(state);
  } finally {
    one();
  }
}

/** The `RateLimited` in `e`'s chain, as anyhow's `downcast_ref` finds it through contexts. */
function rate_limited(e: unknown): RateLimited | null {
  for (let c: any = e; c; c = c instanceof Error ? (c as any).cause : null) if (c instanceof RateLimited) return c;
  return null;
}

/**
 * Once a check has succeeded, unstage a staged version it would no longer offer: a prerelease after "Include
 * prereleases" is turned off, or a release that was taken down. One it still offers stays, even below the latest, until
 * the latest's download replaces it.
 */
function unstage_unpicked(state: AppState) {
  const still = offered_now(state);
  if (still !== null) staging.unstage_unless(state, (v) => still.some((o) => compare(o, v) === 0));
}

/** The versions the last check would offer under the settings as they are now, or none until a check has succeeded. */
function offered_now(state: AppState): Semver[] | null {
  const cfg = state.meta.release;
  if (!cfg) return null;
  const last = state.release.last;
  if (last.checked_at === null || last.error !== null) return null;
  const releases = last.releases ?? [];
  let pre: boolean;
  try {
    pre = prereleases(state);
  } catch {
    return null;
  }
  const bad = staging.read(staging.app_dir(state)).bad;
  return offered(releases, cfg.platform, pre, bad).map(([v]) => v);
}

/** An error if a check since has withdrawn `v` (prereleases turned off, or the release taken down). */
function still_offered(state: AppState, v: string) {
  const version = parse_version(v);
  if (!version) throw new Error(`${JSON.stringify(v)} isn't a version`);
  const o = offered_now(state);
  if (o !== null && !o.some((x) => compare(x, version) === 0)) {
    throw new Error(`${v} isn't offered any more (prereleases were turned off, or the release was taken down)`);
  }
}

/**
 * Start downloading the latest release in the background, if it's newer than this server and isn't staged yet (nor
 * bad: those aren't picked). A download that failed is tried again; one that's running isn't started twice.
 */
function stage_latest(state: AppState) {
  const latest = state.release.last.latest;
  if (!latest) return;
  if (compare(latest.version, running()) <= 0) return;
  const asset = to_asset(latest.asset);
  if (!asset) return;
  const version = version_string(latest.version);
  if (staging.start(state, version, asset) === "Started") log.info(`downloading release ${version}`);
}

/** After a download of `version`: if a check found a newer release meanwhile, download that one now rather than after the next check. */
export function downloaded(state: AppState, version: string) {
  // A check while it downloaded may have stopped picking it (prereleases turned off).
  unstage_unpicked(state);
  const latest = state.release.last.latest;
  if (latest && version_string(latest.version) !== version) stage_latest(state);
}

function request(url: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, { headers: { "user-agent": `huntaway/${VERSION}`, ...headers }, signal: AbortSignal.timeout(30_000) });
}

/**
 * The list (fetched again, or the last one on a 304) and the release picked from it. A manifest that can't be read
 * fails the check, so the last result (and what it said of the shell) stands.
 */
async function check_with(state: AppState, cfg: Config, last: Checked): Promise<[string | null, GhRelease[], Latest | null]> {
  const pre = prereleases(state);
  const bad = staging.read(staging.app_dir(state)).bad;
  const url = `${cfg.api}/repos/${cfg.repo}/releases?per_page=20`;
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
  // Only with the list it goes with: a 304 means "the list you have".
  if (last.etag !== null && last.releases !== null) headers["if-none-match"] = last.etag;
  let res: Response;
  try {
    res = await request(url, headers);
  } catch (e) {
    throw new Error(`asking ${url}`, { cause: e });
  }
  let etag: string | null, releases: GhRelease[];
  if (res.status === 304) {
    if (!last.releases) throw new Error("GitHub said the releases hadn't changed, but there's no earlier list");
    [etag, releases] = [last.etag, last.releases];
  } else if (res.ok) {
    etag = res.headers.get("etag");
    try {
      const list: any = await res.json();
      if (!Array.isArray(list)) throw new Error("invalid type: expected a sequence");
      releases = list.map(GhRelease_from_json);
    } catch (e) {
      throw new Error("reading the releases", { cause: e });
    }
  } else {
    throw await refused(res);
  }
  const picked = pick(releases, cfg.platform, pre, bad);
  if (!picked) return [etag, releases, null];
  const [version, release, asset] = picked;
  // The manifest only changes with the release, so one read before is kept.
  const manifest_name = `huntaway-${tag_version(release.tag_name)}-release.json`;
  const manifest_asset = release.assets.find((a) => a.name === manifest_name);
  const kept = last.latest && compare(last.latest.version, version) === 0 && last.latest.release.tag_name === release.tag_name ? last.latest.manifest : null;
  let manifest: Manifest | null = null;
  if (manifest_asset) {
    if (kept) manifest = kept;
    else {
      try {
        manifest = await fetch_manifest(manifest_asset);
      } catch (e) {
        throw new Error(`reading ${manifest_name}`, { cause: e });
      }
    }
  }
  return [etag, releases, { version, release, asset, manifest }];
}

/** HTTP reason phrases, as reqwest's `StatusCode` shows them. */
const REASONS: Record<number, string> = {
  400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 409: "Conflict", 410: "Gone", 422: "Unprocessable Entity",
  429: "Too Many Requests", 500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout",
};

/** The error for a response that isn't a list: the rate limit (with when it resets), or GitHub's message. */
async function refused(res: Response): Promise<Error> {
  const header = (k: string) => res.headers.get(k)?.trim() ?? null;
  if ((res.status === 403 || res.status === 429) && header("x-ratelimit-remaining") === "0") {
    const r = header("x-ratelimit-reset");
    const t = r !== null && /^-?\d+$/.test(r) ? Number(r) : NaN;
    return new RateLimited(Number.isFinite(t) ? new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, "Z") : null);
  }
  const reason = REASONS[res.status] ?? res.statusText;
  const status = `${res.status}${reason ? ` ${reason}` : ""}`;
  const body: any = await res.json().catch(() => null);
  return new Error(typeof body?.message === "string" ? `GitHub answered ${status}: ${body.message}` : `GitHub answered ${status}`);
}

async function fetch_manifest(asset: GhAsset): Promise<Manifest> {
  const res = await request(asset.browser_download_url);
  if (!res.ok) throw await refused(res);
  const m: any = await res.json();
  if (typeof m?.shell !== "string") throw new Error("missing field `shell`");
  return { shell: m.shell };
}

/** A tag's version text, without the optional `v`. */
function tag_version(tag: string): string {
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

/**
 * The highest semver release that isn't a draft (nor a prerelease, unless they're included) nor bad (rolled back from,
 * or failed to start), and has a server tarball for `platform` with a sha256 digest.
 */
function pick(releases: GhRelease[], platform: string, pre: boolean, bad: string[]): [Semver, GhRelease, GhAsset] | null {
  let best: [Semver, GhRelease, GhAsset] | null = null;
  for (const o of offered(releases, platform, pre, bad)) if (!best || compare(o[0], best[0]) >= 0) best = o;
  return best;
}

/** The releases a check could pick (see `pick`), each with its version and server tarball. */
function offered(releases: GhRelease[], platform: string, pre: boolean, bad: string[]): Array<[Semver, GhRelease, GhAsset]> {
  const out: Array<[Semver, GhRelease, GhAsset]> = [];
  for (const r of releases) {
    if (r.draft || (!pre && r.prerelease)) continue;
    const text = tag_version(r.tag_name);
    const version = parse_version(text);
    if (!version) continue;
    if (bad.some((b) => {
      const v = parse_version(b);
      return v !== null && compare(v, version) === 0;
    })) continue;
    const name = `huntaway-server-${text}-${platform}.tar.gz`;
    const asset = r.assets.find((a) => a.name === name && sha256(a) !== null);
    if (asset) out.push([version, r, asset]);
  }
  return out;
}

/** The `release` block of `GET /admin/server`, when release updates are on. */
export function status(state: AppState): any | null {
  const cfg = state.meta.release;
  if (!cfg) return null;
  const pre = prereleases(state);
  const last = state.release.last;
  const app = staging.app_dir(state);
  const installed = staging.read(app);
  const download = state.release.download.borrow();
  const l = last.latest;
  const latest = l && {
    version: version_string(l.version),
    prerelease: l.release.prerelease,
    published_at: l.release.published_at,
    notes: l.release.body,
    url: l.release.html_url,
    asset: asset_json(l.asset),
    newer: compare(l.version, running()) > 0,
  };
  const rollback = rollback_target(state);
  return {
    repo: cfg.repo,
    running: VERSION,
    // Where it runs from: `<data dir>/app/<v>/huntaway`, the desktop app's own server, or a tarball's.
    exe: path_str(state.exe),
    latest,
    prereleases: pre,
    checked_at: last.checked_at,
    error: last.error,
    rate_limit_reset: last.rate_limit_reset,
    shell: shell(cfg, l),
    bundled_server: cfg.bundled_server,
    // A version downloaded and checked, for Update to restart onto.
    staged: staging.staged(app, installed),
    download: download ? staging.Download_reported({ ...download }) : null,
    previous: installed.previous,
    bad: installed.bad,
    // What Roll back would start: a version, "bundled" (the desktop app's own server), or null.
    rollback_to: rollback === null ? null : (rollback[1] ?? "bundled"),
  };
}

// ---------- Update and Roll back ----------

/**
 * Restart onto `version` (a `RestartJob`): straight away if it's staged, after its background download if that's still
 * running, or after downloading it now. Anything that goes wrong before the exec leaves this server running.
 */
export function update(state: AppState, version: string) {
  if (!state.meta.release) throw ApiError.bad("this server doesn't update from releases (start it with --release-updates OWNER/REPO)");
  const parsed = parse_version(version.trim().replace(/^v+/, ""));
  if (!parsed) throw ApiError.bad(`${JSON.stringify(version)} isn't a version`);
  if (compare(parsed, running()) <= 0) throw ApiError.bad(`this server runs ${VERSION}, which isn't older than ${version_string(parsed)}`);
  const v = version_string(parsed);
  if (staging.is_bad(staging.read(staging.app_dir(state)), v)) throw ApiError.bad(`${v} was rolled back from or didn't start, so it isn't offered again`);
  // The asset, in case it has to be downloaded: only the latest release's is known.
  const latest = state.release.last.latest;
  const asset = latest && compare(latest.version, parsed) === 0 ? to_asset(latest.asset) : null;
  if (asset === null && !staging.is_staged(state, v)) throw ApiError.bad(`${v} isn't the latest release; check for releases again`);
  admin.begin(state, async (st) => {
    await wait_for_staging(st, v, asset);
    await restart_onto(st, v);
  });
}

/**
 * A hub's Update for a release install (API 89): restart onto the release the hub runs, as `update` does. When that
 * isn't the latest release this server knows of (nor staged), it checks first: the hub may run one published since.
 */
export async function update_from_hub(state: AppState, version: string): Promise<any> {
  const target = parse_version(version.trim().replace(/^v+/, ""));
  if (!target) throw ApiError.bad(`the board's version ${JSON.stringify(version)} isn't a version`);
  const c = compare(target, running());
  if (c === 0) return { ok: true, up_to_date: true };
  if (c < 0) throw ApiError.bad(`this host runs ${VERSION}, which is newer than the board's ${version_string(target)}`);
  const v = version_string(target);
  const latest = () => state.release.last.latest?.version ?? null;
  const is_latest = () => {
    const l = latest();
    return l !== null && compare(l, target) === 0;
  };
  if (!is_latest() && !staging.is_staged(state, v)) {
    await check(state);
    const newer = latest();
    if (newer !== null && compare(newer, target) > 0 && !staging.is_staged(state, v)) {
      throw ApiError.bad(`the latest release is ${version_string(newer)}, newer than the board's ${v}: update the board first, or this host from its own board`);
    }
  }
  update(state, v);
  return { ok: true };
}

/** Until `v` is staged: follow its download (starting one if none is running) in the restart's phases and log. */
async function wait_for_staging(st: AppState, v: string, asset: Asset | null) {
  const rx = st.release.download;
  let seen = -1;
  let started = false;
  const logged: { v: [string, number] | null } = { v: null };
  for (;;) {
    if (staging.is_staged(st, v)) return;
    seen = rx.version;
    const cur = rx.borrow();
    const d = cur && cur.version === v ? { ...cur } : null;
    if (d && staging.Download_running(d)) {
      mirror(st, d, logged);
      await rx.changed(seen);
      continue;
    }
    if (d && started) throw new Error(d.error ?? `${v} wasn't staged`);
    // Its download finished but was unstaged, or it's about to be downloaded again: only while it's still offered.
    still_offered(st, v);
    if (asset === null) throw new Error(`${v} isn't staged any more; check for releases again`);
    const r = staging.start(st, v, asset);
    if (r === "Started") started = true;
    else if (r === "Staged") return;
    else {
      const other = rx.borrow();
      const running_d = other && staging.Download_running(other) ? other : null;
      // One of `v` is followed next time round.
      if (running_d === null || running_d.version !== v) {
        if (running_d !== null) admin.log_line(st, `Waiting for the download of ${running_d.version} to finish`);
        (await st.release.staging.lock())();
      }
    }
  }
}

/** Show a download's progress in the restart job: its phase, and a line in the log for each phase and tenth. */
function mirror(st: AppState, d: Download, logged: { v: [string, number] | null }) {
  const tenth = d.total !== null && d.total > 0 ? Math.floor((d.bytes * 10) / d.total) : 0;
  if (logged.v !== null && logged.v[0] === d.phase && logged.v[1] === tenth) return;
  if (logged.v === null || logged.v[0] !== d.phase) {
    admin.set_phase(st, d.phase, null);
    admin.log_line(
      st,
      d.phase === "downloading"
        ? `Downloading ${d.version}${d.total !== null ? ` (${mb(d.total)})` : ""}`
        : d.phase === "verifying"
          ? "Checking its sha256 and what it holds"
          : `Unpacking it into ${path_str(join(staging.app_dir(st), d.version))}, and checking that it runs`,
    );
  } else if (d.total !== null) {
    admin.log_line(st, `${tenth}0% (${mb(d.bytes)} of ${mb(d.total)})`);
  }
  logged.v = [d.phase, tenth];
}

function mb(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

/** Set `trying` and exec `app/<v>/huntaway`. When that fails, `trying` is put back. */
async function restart_onto(st: AppState, v: string) {
  const app = staging.app_dir(st);
  const dir = staging.version_dir(app, v);
  if (dir === null) throw new Error("not a version");
  const exe = join(dir, "huntaway");
  // Before anything changes: without a backup, the Update fails and this server carries on.
  await backup.before_switch(st.data_dir, st.db(), VERSION, v);
  const old = staging.change(st, (s) => (s.trying = v));
  const err = await admin.restart_into(st, exe, bundled_env(st));
  staging.change(st, (s) => {
    if (s.trying === v) s.trying = old.trying;
  });
  throw err;
}

/**
 * What an Update adds to the environment of the version it execs: a server that isn't running from `app/` (a
 * tarball's) and has no `IA_BUNDLED_SERVER` passes itself as that, so that Roll back can come back to it straight
 * away, as it can after a supervisor's restart (`exec_installed`). One set already (by the desktop app or by hand)
 * carries over as it is.
 */
function bundled_env(st: AppState): Array<[string, string]> {
  const unset = st.meta.release !== null && st.meta.release.bundled_server === null;
  return unset && staging.running_from_app(st.data_dir, st.exe) === null ? [["IA_BUNDLED_SERVER", st.exe]] : [];
}

const is_file = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * What Roll back would exec, and its version (none for the desktop app's own server): the version before this one, or
 * else the bundled server. Only for a server running from `app/`. As the desktop app does, it doesn't go back to a
 * version older than the app's own server (whose version is the app's): a newer package's server takes over from it.
 */
function rollback_target(state: AppState): [string, string | null] | null {
  const current = staging.running_from_app(state.data_dir, state.exe);
  if (current === null) return null;
  const app = staging.app_dir(state);
  const installed = staging.read(app);
  const cfg = state.meta.release;
  if (!cfg) return null;
  const desktop = cfg.desktop_version === null ? null : parse_version(cfg.desktop_version.trim().replace(/^v+/, ""));
  const at_least_the_apps = (p: string) => {
    if (desktop === null) return true;
    const pv = parse_version(p);
    return pv !== null && compare(pv, desktop) >= 0;
  };
  const p = installed.previous;
  if (p !== null && p !== current && !staging.is_bad(installed, p) && at_least_the_apps(p)) {
    const dir = staging.version_dir(app, p);
    if (dir !== null && staging.complete(dir)) return [join(dir, "huntaway"), p];
  }
  if (cfg.bundled_server === null) return null;
  return is_file(cfg.bundled_server) ? [cfg.bundled_server, null] : null;
}

/** Mark the running version bad and restart onto the one before it (or the desktop app's own server). When the exec fails, `app/state.json` is put back. */
export function rollback(state: AppState) {
  if (!state.meta.release) throw ApiError.bad("this server doesn't update from releases (start it with --release-updates OWNER/REPO)");
  const current = staging.running_from_app(state.data_dir, state.exe);
  if (current === null) throw ApiError.bad("this server isn't an installed release, so there's nothing to roll back");
  if (rollback_target(state) === null) throw ApiError.bad("there's no earlier version to roll back to");
  admin.begin(state, async (st) => {
    const target = rollback_target(st);
    if (target === null) throw new Error("there's no earlier version to roll back to");
    const [exe, previous] = target;
    admin.log_line(st, `Rolling back from ${current} to ${previous ?? "the app's own server"}`);
    // Before anything changes: without a backup, the Roll back fails and this server carries on.
    await backup.before_switch(st.data_dir, st.db(), VERSION, previous ?? "bundled");
    const old = staging.change(st, (s) => rolled_back(s, current, previous));
    const err = await admin.restart_into(st, exe, []);
    // Only what the rollback changed is put back: a download may have staged a version meanwhile.
    staging.change(st, (s) => not_rolled_back(s, old, current, previous));
    throw err;
  });
}

/** Undo `rolled_back(s, current, previous)` on `s`, which was `old` before it, for the fields it changed and nothing has changed since. */
function not_rolled_back(s: Installed, old: Installed, current: string, previous: string | null) {
  if (!staging.is_bad(old, current)) s.bad = s.bad.filter((b) => b !== current);
  if (s.current === previous) s.current = old.current;
  if (s.previous === null) s.previous = old.previous;
  if (old.trying === current && s.trying === null) s.trying = old.trying;
}

/** `s` once `current` is rolled back from to `previous` (none for the bundled server, which the desktop app starts when there's no current). */
function rolled_back(s: Installed, current: string, previous: string | null) {
  if (!staging.is_bad(s, current)) s.bad.push(current);
  s.current = previous;
  s.previous = null;
  if (s.trying === current) s.trying = null;
}

/**
 * The desktop package for an install `kind` (`pacman`, `appimage`) in release `version`, as electron-builder names it:
 * the pacman package with `platform`'s arch, and the AppImage with AppImage's own (`x86_64`, `arm64`).
 */
export function package_name(kind: string, version: string, platform: string): string | null {
  if (kind === "pacman") return `huntaway-${version}-${platform}.pacman`;
  if (kind === "appimage") {
    const i = platform.indexOf("-");
    if (i < 0) return null;
    const [os, arch] = [platform.slice(0, i), platform.slice(i + 1)];
    return `huntaway-${version}-${os}-${arch === "x64" ? "x86_64" : arch}.AppImage`;
  }
  return null;
}

/** The desktop app this server was started by, and whether the latest release has a newer shell (null when no app started it). */
export function shell(cfg: Config, latest: Latest | null): any {
  if (cfg.desktop_version === null && cfg.desktop_install === null && cfg.desktop_shell === null) return null;
  const install = cfg.desktop_install ?? "other";
  const i = install.indexOf(":");
  const [kind, path] = i < 0 ? [install, null] : [install.slice(0, i), install.slice(i + 1)];
  // Only a newer release's: an app installed from a release the checks don't pick (a prerelease, with them off) would
  // otherwise be offered an older package, which would start its older server on a database the newer one migrated.
  const newer = (l: Latest) => {
    if (cfg.desktop_version === null) return true;
    const d = parse_version(cfg.desktop_version.trim().replace(/^v/, ""));
    return d !== null && compare(l.version, d) > 0;
  };
  const theirs = latest && newer(latest) ? (latest.manifest?.shell ?? null) : null;
  const outdated = theirs !== null && cfg.desktop_shell !== null ? theirs !== cfg.desktop_shell : false;
  let pkg: GhAsset | null = null;
  if (latest) {
    const name = package_name(kind, tag_version(latest.release.tag_name), cfg.platform);
    pkg = name ? (latest.release.assets.find((a) => a.name === name) ?? null) : null;
  }
  return { version: cfg.desktop_version, install: kind, path, outdated, package: pkg ? asset_json(pkg) : null };
}
