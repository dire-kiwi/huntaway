// Port of server/src/util.rs.
import { randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/** RFC 3339 with milliseconds and a Z, as chrono's `to_rfc3339_opts(Millis, true)`. */
export function now(): string {
  return new Date().toISOString();
}

export function new_id(): string {
  return randomUUID();
}

export function new_token(): string {
  return randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
}

/** Compares secrets without giving away, by how long it takes, how much of one matched. */
export function same_secret(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function home_dir(): string | null {
  try {
    return process.env.HOME || homedir() || null;
  } catch {
    return null;
  }
}

/** Expand a leading `~` to the user's home directory. */
export function expand_tilde(p: string): string {
  p = p.trim();
  const home = home_dir();
  if (p === "~") return home ?? p;
  if (p.startsWith("~/") && home) return join(home, p.slice(2));
  return p;
}

const alnum = (c: string) => /^[A-Za-z0-9]$/.test(c);

export function slugify(s: string, max: number): string {
  let out = "";
  let dash = false;
  for (const c of s) {
    if (alnum(c)) {
      out += c.toLowerCase();
      dash = false;
    } else if (!dash && out.length) {
      out += "-";
      dash = true;
    }
    if (out.length >= max) break;
  }
  return out.replace(/^-+|-+$/g, "");
}

/** Derive a short uppercase key (e.g. "IA") from a project name. */
export function derive_key(name: string): string {
  const words = name.split(/[^A-Za-z0-9]/).filter((w) => w);
  const key = words.length >= 2 ? words.slice(0, 3).map((w) => w[0]).join("") : (words[0] ?? "").slice(0, 3);
  return key.toUpperCase() || "T";
}

export function path_str(p: string): string {
  return p;
}

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const read = (p: string): string | null => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
};

/** Whether `dir` is a git repository's top folder: a quick check without running git. */
export function is_git_root(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

/** Whether the git repository whose top folder is `dir` has a commit checked out. */
export function has_commits(dir: string): boolean {
  const dotGit = join(dir, ".git");
  let gitDir: string;
  if (isFile(dotGit)) {
    const s = (read(dotGit) ?? "").trim();
    if (!s.startsWith("gitdir:")) return false;
    gitDir = join(dir, s.slice(7).trim());
    if (s.slice(7).trim().startsWith("/")) gitDir = s.slice(7).trim();
  } else if (isDir(dotGit)) gitDir = dotGit;
  else return false;
  const head = read(join(gitDir, "HEAD"));
  if (head === null) return false;
  const h = head.trim();
  if (!h.startsWith("ref:")) return h.length >= 40 && /^[0-9a-fA-F]+$/.test(h);
  const branch = h.slice(4).trim();
  const cd = read(join(gitDir, "commondir"));
  const common = cd !== null ? (cd.trim().startsWith("/") ? cd.trim() : join(gitDir, cd.trim())) : gitDir;
  if (existsSync(join(common, "reftable"))) {
    return spawnSync("git", ["-C", dir, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { stdio: "ignore" }).status === 0;
  }
  if (isFile(join(common, branch))) return true;
  const packed = read(join(common, "packed-refs"));
  return packed !== null && packed.split("\n").some((l) => l.split(" ")[1] === branch && l.includes(" "));
}

/** Truncate a string to at most `max` bytes on a char boundary. */
export function truncate(s: string, max: number): string {
  const b = Buffer.from(s);
  if (b.length <= max) return s;
  let end = max;
  // Back up to a char boundary (a byte that isn't a UTF-8 continuation byte).
  while (end > 0 && (b[end] & 0xc0) === 0x80) end--;
  return `${b.subarray(0, end).toString()}\n… [truncated ${b.length - end} bytes]`;
}

/** A promise that resolves after `ms` milliseconds. */
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Byte length of a string in UTF-8 (Rust's `str::len`). */
export const byte_len = (s: string) => Buffer.byteLength(s);

/** An error's message with its causes, as anyhow's `{:#}`. */
export function err_str(e: unknown): string {
  if (e instanceof Error) {
    let m = e.message;
    let c = (e as any).cause;
    while (c) {
      m += `: ${c instanceof Error ? c.message : String(c)}`;
      c = c instanceof Error ? (c as any).cause : undefined;
    }
    return m;
  }
  return String(e);
}

/** `anyhow::Context`: wrap an error with what was being done. */
export function context(what: string, e: unknown): Error {
  return new Error(what, { cause: e });
}
