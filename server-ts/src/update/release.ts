// Port of server/src/update/release.rs, thin: updates for release installs (the desktop app's packages, or a server
// installed from a release tarball): with `--release-updates <OWNER/REPO>`, check that repository's GitHub releases for
// a newer server, and report what was found in `GET /admin/server` (API 88).
//
// The TypeScript server checks and reports as the Rust one does, but a release is the Rust server: it doesn't download
// releases into `<data dir>/app/` (update/staging.rs), and can't restart onto one (Node has no exec), so Update and
// Roll back answer with an error. (Rust's update/release/tests.rs is about the downloads and restarts, so it isn't
// ported.)
import * as db from "../db.ts";
import { ApiError } from "../http.ts";
import type { AppState } from "../state.ts";
import { err_str, now, path_str } from "../util.ts";
import { VERSION } from "../hosts/proto.ts";
import * as staging from "./staging.ts";
import type { Download } from "./staging.ts";

/** The settings key for "Include prereleases" (`"true"` when on). */
export const PRERELEASES = "release_prereleases";

const FIRST_CHECK = 30_000;
const CHECK_EVERY = 6 * 60 * 60_000;

/** What updating onto a release says in the TypeScript server. */
const NO_UPDATE = "updating onto a release isn't supported by the TypeScript server";

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
  text: string;
}

/** A semver version (`1.2.3`, `1.2.3-rc.1`, `1.2.3+build`), or null. */
export function parse_version(v: string): Semver | null {
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(v);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split(".") : [], text: v };
}

/** Semver precedence: < 0, 0 or > 0. */
export function compare(a: Semver, b: Semver): number {
  for (const k of ["major", "minor", "patch"] as const) if (a[k] !== b[k]) return a[k] - b[k];
  if (!a.pre.length || !b.pre.length) return (a.pre.length ? -1 : 0) - (b.pre.length ? -1 : 0);
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (i >= a.pre.length) return -1;
    if (i >= b.pre.length) return 1;
    const [x, y] = [a.pre[i], b.pre[i]];
    const [nx, ny] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (nx && ny && Number(x) !== Number(y)) return Number(x) - Number(y);
    if (nx !== ny) return nx ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** A version as semver writes it (without build metadata kept apart: as parsed). */
const version_string = (v: Semver) => `${v.major}.${v.minor}.${v.patch}${v.pre.length ? `-${v.pre.join(".")}` : ""}`;

/** The version this server runs. */
function running(): Semver {
  return parse_version(VERSION)!;
}

// ---------- releases ----------

/** A release from `GET /repos/{repo}/releases`, with the fields used here. */
interface GhRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  body: string | null;
  html_url: string;
  assets: GhAsset[];
}

interface GhAsset {
  name: string;
  browser_download_url: string;
  size: number;
  /** `sha256:<hex>` (GitHub fills it in for assets uploaded since mid 2025). */
  digest: string | null;
}

function gh_release(r: any): GhRelease | null {
  if (typeof r?.tag_name !== "string") return null;
  return {
    tag_name: r.tag_name,
    draft: r.draft === true,
    prerelease: r.prerelease === true,
    published_at: typeof r.published_at === "string" ? r.published_at : null,
    body: typeof r.body === "string" ? r.body : null,
    html_url: typeof r.html_url === "string" ? r.html_url : "",
    assets: (Array.isArray(r.assets) ? r.assets : [])
      .filter((a: any) => typeof a?.name === "string" && typeof a?.browser_download_url === "string")
      .map((a: any) => ({ name: a.name, browser_download_url: a.browser_download_url, size: typeof a.size === "number" ? a.size : 0, digest: typeof a.digest === "string" ? a.digest : null })),
  };
}

function sha256(a: GhAsset): string | null {
  const hex = a.digest?.startsWith("sha256:") ? a.digest.slice(7) : null;
  return hex && /^[0-9a-fA-F]{64}$/.test(hex) ? hex : null;
}

function asset_json(a: GhAsset) {
  return { name: a.name, url: a.browser_download_url, size: a.size, sha256: sha256(a) };
}

/** A release's `huntaway-<v>-release.json`: which desktop shell it was built with. */
interface Manifest {
  shell: string;
}

/** The release a check picked. */
interface Latest {
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

/** What the checks found (in `AppState.release`). */
export class Releases {
  last: Checked = { etag: null, releases: null, latest: null, checked_at: null, error: null, rate_limit_reset: null };
  /** A check in progress, so there's one at a time. */
  checking: Promise<void> | null = null;
  /** The download in progress, or the last one (none here: see the top of this file). */
  download: Download | null = null;
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
  console.error(`checking ${cfg.repo}'s GitHub releases for updates`);
  setTimeout(() => {
    check(state);
    setInterval(() => check(state), CHECK_EVERY).unref();
  }, FIRST_CHECK).unref();
}

/** Check in the background (when "Include prereleases" changes). */
export function check_soon(state: AppState) {
  if (!state.meta.release) return;
  check(state);
}

/** Ask GitHub for the releases and pick the newest one this server could update to. A failed check keeps what the last one found, with the error. */
export async function check(state: AppState): Promise<void> {
  const cfg = state.meta.release;
  if (!cfg) return;
  while (state.release.checking) await state.release.checking.catch(() => {});
  let done!: () => void;
  state.release.checking = new Promise<void>((r) => (done = r));
  try {
    const last = state.release.last;
    const next: Checked = { ...last, checked_at: now(), rate_limit_reset: null };
    try {
      const [etag, releases, latest] = await check_with(state, cfg, last);
      Object.assign(next, { etag, releases, latest, error: null });
    } catch (e) {
      console.error(`checking ${cfg.repo} for releases: ${err_str(e)}`);
      next.rate_limit_reset = e instanceof RateLimited ? e.reset : null;
      next.error = err_str(e);
    }
    state.release.last = next;
    state.emit({ type: "release_checked" });
  } finally {
    state.release.checking = null;
    done();
  }
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
  if (last.etag && last.releases) headers["if-none-match"] = last.etag;
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
    let list: any;
    try {
      list = await res.json();
    } catch (e) {
      throw new Error("reading the releases", { cause: e });
    }
    if (!Array.isArray(list)) throw new Error("reading the releases: not a list");
    releases = list.map(gh_release).filter((r): r is GhRelease => r !== null);
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

/** The error for a response that isn't a list: the rate limit (with when it resets), or GitHub's message. */
async function refused(res: Response): Promise<Error> {
  const header = (k: string) => res.headers.get(k)?.trim() ?? null;
  if ((res.status === 403 || res.status === 429) && header("x-ratelimit-remaining") === "0") {
    const t = Number(header("x-ratelimit-reset"));
    return new RateLimited(Number.isFinite(t) && t > 0 ? new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, "Z") : null);
  }
  const status = `${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;
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
  const download = state.release.download;
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
    download: download ? staging.Download_reported(download) : null,
    previous: installed.previous,
    bad: installed.bad,
    // What Roll back would start: a version, "bundled" (the desktop app's own server), or null. The TypeScript server
    // never runs from `app/`, so there's nothing to roll back.
    rollback_to: null,
  };
}

// ---------- Update and Roll back ----------

/** Restart onto `version`: not in the TypeScript server (see the top of this file). */
export function update(state: AppState, version: string) {
  if (!state.meta.release) throw ApiError.bad("this server doesn't update from releases (start it with --release-updates OWNER/REPO)");
  const v = parse_version(version.trim().replace(/^v+/, ""));
  if (!v) throw ApiError.bad(`${JSON.stringify(version)} isn't a version`);
  if (compare(v, running()) <= 0) throw ApiError.bad(`this server runs ${VERSION}, which isn't older than ${version_string(v)}`);
  throw ApiError.bad(NO_UPDATE);
}

/** A hub's Update for a release install (API 89): restart onto the release the hub runs, as `update` does. */
export async function update_from_hub(state: AppState, version: string): Promise<any> {
  const target = parse_version(version.trim().replace(/^v+/, ""));
  if (!target) throw ApiError.bad(`the board's version ${JSON.stringify(version)} isn't a version`);
  const c = compare(target, running());
  if (c === 0) return { ok: true, up_to_date: true };
  if (c < 0) throw ApiError.bad(`this host runs ${VERSION}, which is newer than the board's ${version_string(target)}`);
  update(state, version_string(target));
  return { ok: true };
}

/** Mark the running version bad and restart onto the one before it: not in the TypeScript server. */
export function rollback(state: AppState) {
  if (!state.meta.release) throw ApiError.bad("this server doesn't update from releases (start it with --release-updates OWNER/REPO)");
  if (staging.running_from_app(state.data_dir, state.exe) === null) throw ApiError.bad("this server isn't an installed release, so there's nothing to roll back");
  throw ApiError.bad(NO_UPDATE);
}

/**
 * The desktop package for an install `kind` (`pacman`, `appimage`) in release `version`, as electron-builder names it:
 * the pacman package with `platform`'s arch, and the AppImage with AppImage's own (`x86_64`, `arm64`).
 */
function package_name(kind: string, version: string, platform: string): string | null {
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
function shell(cfg: Config, latest: Latest | null): any {
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
