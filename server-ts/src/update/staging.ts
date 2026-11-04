// Port of server/src/update/staging.rs, thin: the per-user install dir release updates use, `<data dir>/app/`:
//
// - `<v>/`: a release's server tarball, unpacked (`huntaway`, `ia-shim` and `ui/index.html` side by side)
// - `<v>.partial/`: one being downloaded or unpacked
// - `state.json`: `{current, previous, staged, trying, bad}`, which the desktop app reads and writes too
//   (app/electron/versions.cjs), so it's written through a temp file and a rename, and keeps the keys it doesn't know.
//
// The TypeScript server reads and writes `state.json` as the Rust one does, but doesn't download releases (a release
// is the Rust server), and never runs from `app/`, so there's nothing for it to settle.
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AppState } from "../state.ts";
import { new_id } from "../util.ts";
import { parse_version } from "./release.ts";

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

/** A download of a release, as `GET /admin/server` reports it. */
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
      return statSync(join(dir, f), { throwIfNoEntry: false } as any)?.isFile() ?? false;
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
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
  } catch (e) {
    console.error(`ignoring ${file}: ${e}`);
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
  const { current, previous, staged, trying, bad, ...other } = s;
  writeFileSync(tmp, `${JSON.stringify({ current, previous, staged, trying, bad, ...other }, null, 2)}\n`);
  try {
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw new Error(`renaming ${tmp} to ${file}`, { cause: e });
  }
}

/** Change `app/state.json`. Returns it as it was. */
export function change(state: AppState, f: (s: Installed) => void): Installed {
  const app = app_dir(state);
  const old = read(app);
  const next: Installed = JSON.parse(JSON.stringify(old));
  f(next);
  if (JSON.stringify(next) !== JSON.stringify(old)) write(app, next);
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

/**
 * For a server running from `app/<v>/huntaway`: make `v` current, and delete what nothing needs. The TypeScript server
 * never runs from `app/`, so there's nothing to settle.
 */
export function settle(_state: AppState): string | null {
  return null;
}
