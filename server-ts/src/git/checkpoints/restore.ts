// Port of server/src/git/checkpoints/restore.rs: restoring a worktree's files to a checkpoint. Paths are latin1 strings
// of their bytes (see git.ts).
import { lstatSync, rmdirSync, unlinkSync } from "node:fs";
import { context } from "../../util.ts";
import { ScratchIndex, head, lossy, nul_list, run_ok, split_nul } from "./git.ts";

export interface Restored {
  written: number;
  removed: number;
  /**
   * Files left as they are: submodules and other repositories, files the index marks skip-worktree or assume-unchanged,
   * and files the checkpoints don't have (see `safe_to_write`).
   */
  skipped: string[];
  /** The files written or removed. */
  changed: Set<string>;
  /** The files marked skip-worktree or assume-unchanged. */
  hidden: Set<string>;
}

/**
 * Make the worktree at `top`, whose files are `now` (a tree from `snapshot`), have the files of tree `to`: only the
 * files that differ are written or removed, and only where nothing else would go with them (ignored files and the rest
 * are left alone).
 */
export async function restore(top: string, now: string, to: string): Promise<Restored> {
  const raw = await run_ok(top, ["diff-tree", "-r", "-z", "--no-renames", now, to]);
  const out: Restored = { written: 0, removed: 0, skipped: [], changed: new Set(), hidden: new Set() };
  {
    const o = await run_ok(top, ["ls-files", "-v", "-z"]);
    for (const e of split_nul(o.stdout)) {
      if (e.length > 2 && (e[0] === "S" || (e[0] >= "a" && e[0] <= "z"))) out.hidden.add(e.slice(2));
    }
  }
  // (path, whether `now` has it)
  const write: Array<[string, boolean]> = [];
  const remove: string[] = [];
  const fields = raw.stdout.toString("latin1").split("\0");
  for (let i = 0; i < fields.length; i++) {
    const meta = fields[i];
    if (meta === "") continue;
    if (i + 1 >= fields.length) break;
    const path = fields[++i];
    // `:<old mode> <new mode> <old sha> <new sha> <status>`
    const m = lossy(meta).replace(/^:+/, "").split(" ");
    const [old_mode, new_mode] = [m[0] ?? "", m[1] ?? ""];
    if (old_mode === "160000" || new_mode === "160000" || out.hidden.has(path)) out.skipped.push(lossy(path));
    else if (new_mode === "000000") remove.push(path);
    else write.push([path, old_mode !== "000000"]);
  }
  for (const p of remove) {
    if (remove_file(top, p)) {
      out.removed += 1;
      out.changed.add(p);
    }
  }
  const ok: Array<[string, boolean]> = [];
  for (const w of write) {
    if (safe_to_write(top, w[0], w[1])) ok.push(w);
    else out.skipped.push(lossy(w[0]));
  }
  if (ok.length) {
    const scratch = await ScratchIndex.create(top, false);
    try {
      await run_ok(top, ["read-tree", to], scratch.env());
      await run_ok(top, ["checkout-index", "-f", "-z", "--stdin"], scratch.env(), nul_list(ok.map(([p]) => p)));
    } finally {
      scratch.drop();
    }
    out.written = ok.length;
    for (const [p] of ok) out.changed.add(p);
  }
  return out;
}

/**
 * The parts of a relative path (a latin1 string of its bytes), as Rust's `Path::components` gives its normal ones: null
 * if it has any other (root, `..`, a leading `.`).
 */
function parts(rel: string): string[] | null {
  if (rel.startsWith("/")) return null;
  const ps = rel.split("/").filter((p, i) => p !== "" && !(p === "." && i > 0));
  return ps.some((p) => p === "." || p === "..") ? null : ps;
}

function lstat(p: Buffer) {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

const join_buf = (dir: Buffer, name: string) => Buffer.concat([dir, Buffer.from("/"), Buffer.from(name, "latin1")]);

/**
 * Whether the file `rel` can be written in the worktree at `top` without losing anything that isn't in the checkpoint
 * taken just before (`in_now`: that has the file): `checkout-index -f` would remove a folder in its way with all that's
 * in it, and overwrite whatever is there. So not where a folder is (one the restore didn't empty: it holds ignored
 * files, say), not inside another repository or through a symlink, and not over a file the checkpoint doesn't have (one
 * ignored since, too big, or unreadable).
 */
function safe_to_write(top: string, rel: string, in_now: boolean): boolean {
  const ps = parts(rel);
  if (!ps || ps.length === 0) return false;
  const name = ps[ps.length - 1];
  let dir = Buffer.from(top);
  for (const d of ps.slice(0, -1)) {
    dir = join_buf(dir, d);
    const m = lstat(dir);
    // Not there: nothing below it is either.
    if (!m) return true;
    if (!m.isDirectory()) return false;
    if (lstat(join_buf(dir, ".git"))) return false;
  }
  const m = lstat(join_buf(dir, name));
  if (!m) return true;
  if (m.isDirectory()) return false;
  return in_now;
}

/** Put `paths` back in the index as they are in HEAD. */
export async function unstaged(top: string, paths: Set<string>): Promise<void> {
  if (paths.size && (await head(top)) !== null) {
    const sorted = [...paths].sort();
    await run_ok(top, ["--literal-pathspecs", "reset", "-q", "--pathspec-from-file=-", "--pathspec-file-nul"], {}, nul_list(sorted));
  }
}

/**
 * Remove the file `rel` from the worktree at `top` (not a folder, and nothing through a symlink), then the folders it
 * leaves empty. Whether there was one to remove.
 */
function remove_file(top: string, rel: string): boolean {
  const ps = parts(rel);
  if (!ps) throw new Error("not a path in the worktree");
  if (ps.length === 0) return false;
  const name = ps[ps.length - 1];
  const dirs: Buffer[] = [];
  let dir = Buffer.from(top);
  for (const d of ps.slice(0, -1)) {
    dir = join_buf(dir, d);
    const m = lstat(dir);
    if (!m || !m.isDirectory()) return false;
    dirs.push(dir);
  }
  const path = join_buf(dir, name);
  const m = lstat(path);
  if (!m || m.isDirectory()) return false;
  try {
    unlinkSync(path);
  } catch (e) {
    throw context(`removing ${path.toString("utf8")}`, e);
  }
  // The folders it was in, deepest first, up to (not including) the top.
  for (const d of dirs.reverse()) {
    try {
      rmdirSync(d);
    } catch {
      break;
    }
  }
  return true;
}
