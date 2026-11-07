/**
 * Computer use (HA-273): agents see and use the desktop of the host they run on, through Cua Driver
 * (https://github.com/trycua/cua, MIT), as T3 Code's Cua stack and its `agentcast` server do (see
 * docs/notes/t3code-comparison/t3code-cua-driver.md).
 *
 * - The host's page installs the driver (`POST /desktop/install`): a pinned release from GitHub, its size and SHA-256
 *   checked, into `<data dir>/cua-driver/<version>/` (desktop/install.ts). `IA_CUA_DRIVER` runs another build instead,
 *   and one on PATH is used when none is installed.
 * - This server runs one `cua-driver mcp` for the host, started the first time something needs it and stopped when it's
 *   been idle a while (desktop/driver.ts), so every task on the host goes through one runtime.
 * - Agents don't get Cua's own MCP server: they get ours, `desktop` (mcp/desktop_mcp.ts), served over HTTP beside the
 *   board's, with fewer, agentcast-shaped tools. Its read-only tools need no approval and the rest ask, as any tool
 *   does. It refuses on a locked screen, lets one task at a time drive the desktop (`claim`), and journals what it does
 *   (db/desktop.ts), so a call whose answer was lost isn't run twice.
 * - The board shows what a task's agent is looking at (`GET /desktop/frame`) and what it did (`GET /tasks/{id}/desktop`).
 *
 * It's off until the host's page turns it on (`PATCH /desktop`), and a project can turn its server off like any other.
 */
import { existsSync, readdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import * as db from "./db.ts";
import type { Conn } from "./db.ts";
import type { Shared } from "./state.ts";

/** The setting that lets this host's agents use its desktop. */
export const SETTING = "desktop_tools";

/** One of Cua's release archives: where it is, and what it must be. */
export interface Release {
  version: string;
  url: string;
  bytes: number;
  sha256: string;
}

/**
 * The Cua Driver release the host's page installs. Cua marks every driver release a prerelease. To bump, copy each
 * archive's size and SHA-256 from the release's assets (`gh api repos/trycua/cua/releases/tags/cua-driver-rs-v<version>`).
 */
export const VERSION = "0.41.3";

const ARCHIVES: Record<string, { name: string; bytes: number; sha256: string }> = {
  "linux-x64": {
    name: `cua-driver-rs-${VERSION}-linux-x86_64-binary.tar.gz`,
    bytes: 38_375_345,
    sha256: "a00a7bc4a648adbcbc93bfbf5a058daf71ce8838ee172e33b197aaf649ecee14",
  },
  "linux-arm64": {
    name: `cua-driver-rs-${VERSION}-linux-arm64-binary.tar.gz`,
    bytes: 37_825_705,
    sha256: "9fe4b3a28eb0e1df9b48b26ba56c1c454966824bdd6e0f077d59d283d7c76cc4",
  },
  "darwin-universal": {
    name: `cua-driver-rs-${VERSION}-darwin-universal-binary.tar.gz`,
    bytes: 54_042_598,
    sha256: "af23b26a6e2e1cd0917536244ca0050b1447f2d344c958cdb79bfb3342282268",
  },
};

/**
 * The release for this platform, or null where Cua has none (or Huntaway doesn't run). `IA_CUA_DRIVER_RELEASE` (a
 * `Release` as JSON) replaces it, for tests.
 */
export function release(platform: string = process.platform, arch: string = process.arch): Release | null {
  const own = process.env.IA_CUA_DRIVER_RELEASE;
  if (own) return JSON.parse(own) as Release;
  const key = platform === "darwin" ? "darwin-universal" : platform === "linux" && (arch === "x64" || arch === "arm64") ? `linux-${arch}` : null;
  const a = key ? ARCHIVES[key] : undefined;
  if (!a) return null;
  return { version: VERSION, url: `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${VERSION}/${a.name}`, bytes: a.bytes, sha256: a.sha256 };
}

/** Where releases are installed, each in a folder named for its version. */
export const install_root = (s: Shared) => join(s.data_dir, "cua-driver");

/** Where the driver comes from: `IA_CUA_DRIVER`, one the host's page installed, or `cua-driver` on PATH. */
export type Source = "env" | "installed" | "path";

export interface Found {
  path: string;
  source: Source;
  /** An installed one's version (a folder's name); null for the others, whose version isn't known without running them. */
  version: string | null;
}

/** The installed versions, newest first by name (a version is digits and dots). */
export function installed_versions(s: Shared): string[] {
  try {
    return readdirSync(install_root(s))
      .filter((v) => /^\d+(\.\d+)*$/.test(v) && existsSync(join(install_root(s), v, "cua-driver")))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  } catch {
    return [];
  }
}

/** The driver this host would run, or null if it has none. */
export function find(s: Shared): Found | null {
  const own = process.env.IA_CUA_DRIVER;
  if (own) return { path: own, source: "env", version: null };
  const v = installed_versions(s)[0];
  if (v) return { path: join(install_root(s), v, "cua-driver"), source: "installed", version: v };
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const p = dir && join(dir, "cua-driver");
    if (p && existsSync(p)) return { path: p, source: "path", version: null };
  }
  return null;
}

/** Whether the host's page turned computer use on. */
export const enabled = (c: Conn) => db.get_setting(c, SETTING) === "true";

/** Whether this host's runs get the `desktop` server: it's on, and there's a driver to run. */
export const available = (s: Shared) => enabled(s.db()) && find(s) !== null;

/** How long a task keeps the desktop after its last action, before another may drive it. */
export const LEASE_MS = 120_000;

/** The task driving the desktop, and when it last acted. */
let holder: { task_id: string; at: number } | null = null;

/**
 * Let task `task_id` drive the desktop: null if it may (it holds it now), or the task that holds it (for `LEASE_MS`
 * after that task's last action). One controller at a time: tasks' agents share one keyboard, pointer and focus.
 */
export function claim(task_id: string, now = Date.now()): { task_id: string; at: number } | null {
  if (holder && holder.task_id !== task_id && now - holder.at < LEASE_MS) return holder;
  holder = { task_id, at: now };
  return null;
}

/** The task driving the desktop now, if any. */
export function current_holder(now = Date.now()): { task_id: string; at: number } | null {
  return holder && now - holder.at < LEASE_MS ? holder : null;
}

/** Let the desktop go (a task that's done with it, or tests). */
export function release_claim(task_id: string | null = null): void {
  if (task_id === null || holder?.task_id === task_id) holder = null;
}

/** The window a task's agent last looked at or acted on, which the board's viewer shows. */
export interface Target {
  pid: number;
  window_id: number | null;
  at: string;
}

const targets = new Map<string, Target>();

export function set_target(task_id: string, pid: number, window_id: number | null): void {
  targets.set(task_id, { pid, window_id, at: new Date().toISOString() });
}

export const target = (task_id: string): Target | null => targets.get(task_id) ?? null;
