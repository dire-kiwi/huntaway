// Port of server/src/git/checkpoints/changed.rs: what turns changed: the files between two checkpoints, without those
// git brought in, and their stats and patches. Paths are latin1 strings of their bytes (see git.ts).
import { MAX_COMMITS, Stats_default, type Checkpoint, type Stats } from "../checkpoints.ts";
import { lossy, run, run_ok, split_nul, type Snap } from "./git.ts";

/**
 * What the reflog says about how HEAD got to each commit: whether it was made in this worktree (committed, amended,
 * picked, merged) rather than moved to (a fast-forward, reset or checkout).
 */
export function creates_commit(subject: string): boolean {
  const action = subject.split(":")[0];
  return (
    action.startsWith("commit") ||
    action.startsWith("cherry-pick") ||
    action.startsWith("revert") ||
    action === "am" ||
    ["(pick)", "(reword)", "(edit)", "(squash)", "(fixup)", "(continue)"].some((a) => action.endsWith(a)) ||
    subject.includes(": Merge made by")
  );
}

/** Rust's `str::lines`. */
function lines(s: string): string[] {
  const ls = s.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (ls.length && ls[ls.length - 1] === "") ls.pop();
  return ls;
}

/** The commits made in the worktree at `top`, from its HEAD's reflog (null if it has none). */
async function made_here(top: string): Promise<Set<string> | null> {
  const o = await run(top, ["log", "-g", "-n", "20000", "--format=%H%x1f%gs", "HEAD", "--"]);
  if (!o.ok) return null;
  const t = o.stdout.toString("utf8");
  const made = new Set<string>();
  for (const l of lines(t)) {
    const k = l.indexOf("\x1f");
    if (k < 0) continue;
    if (creates_commit(l.slice(k + 1))) made.add(l.slice(0, k));
  }
  return t.trim() !== "" ? made : null;
}

/** The paths each commit changed against the parent given with it (`commit [parent]` lines). */
async function changed_by(top: string, pairs: Array<[string, string | null]>): Promise<Set<string>> {
  if (pairs.length === 0) return new Set();
  const input = pairs.map(([c, p]) => `${c}${p !== null ? ` ${p}` : ""}\n`).join("");
  const o = await run_ok(top, ["diff-tree", "--stdin", "-r", "--root", "--name-only", "-z", "--no-commit-id", "--no-renames"], {}, input);
  return new Set(split_nul(o.stdout));
}

export async function names(top: string, from: string, to: string): Promise<Set<string>> {
  const o = await run_ok(top, ["diff-tree", "-r", "-z", "--name-only", "--no-renames", from, to]);
  return new Set(split_nul(o.stdout));
}

/**
 * The files git brought in between two checkpoints of the worktree at `top` (from HEAD `from_head` to HEAD `to_head`
 * and the files `to_tree`) that weren't changed in the worktree itself: those changed by commits HEAD moved to rather
 * than made here (a pull, a fast-forward merge, the commits a rebase went onto) and by merges made here, except where a
 * merge's result isn't git's own (conflicts resolved), where a commit made here changed them too, or where they're
 * changed and not committed.
 */
export async function brought_in(top: string, from_head: string | null, to_head: string | null, to_tree: string): Promise<Set<string>> {
  if (from_head === null || to_head === null) return new Set();
  const [hb, ha] = [from_head, to_head];
  if (hb === ha) return new Set();
  const max = `--max-count=${MAX_COMMITS + 1}`;
  const list = await run_ok(top, ["rev-list", "--parents", max, ha, `^${hb}`, "--"]);
  const commits = lines(list.stdout.toString("utf8"))
    .map((l) => l.split(/\s+/).filter((w) => w !== ""))
    .filter((c) => c.length > 0);
  if (commits.length === 0 || commits.length > MAX_COMMITS) return new Set();
  // Without a reflog it can't tell: nothing is left out.
  const made = await made_here(top);
  if (made === null) return new Set();
  const pair = (c: string[]): [string, string | null] => [c[0], c[1] ?? null];
  const own = commits.filter((c) => made.has(c[0]));
  const other = commits.filter((c) => !made.has(c[0]));
  const merges = own.filter((c) => c.length > 2);
  if (other.length === 0 && merges.length === 0) return new Set();
  const touched = await changed_by(top, own.filter((c) => c.length <= 2).map(pair));
  for (const m of merges) {
    const o = await run(top, ["show", "--remerge-diff", "--format=", "--name-only", "-z", m[0], "--"]);
    if (o.ok) {
      for (const p of split_nul(o.stdout)) touched.add(p);
    } else {
      // A git from before remerge diffs (2.36): all of the merge counts as the turn's.
      for (const p of await changed_by(top, [pair(m)])) touched.add(p);
    }
  }
  for (const p of await names(top, ha, to_tree)) touched.add(p);
  const pairs = [...other.map(pair), ...merges.map(pair)];
  const brought = await changed_by(top, pairs);
  // Sorted, as Rust's BTreeSet is (by bytes, which latin1 strings compare as).
  return new Set([...brought].filter((p) => !touched.has(p)).sort());
}

/** `git diff --numstat` from `from` to `to` (commits), without `excluded`: the stats, and the paths left out (as text). */
export async function numstat(top: string, from: string, to: string, excluded: Set<string>): Promise<[Stats, string[]]> {
  const o = await run_ok(top, ["diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", from, to, "--"]);
  const stats = Stats_default();
  const left_out: string[] = [];
  for (const entry of split_nul(o.stdout)) {
    const t1 = entry.indexOf("\t");
    const t2 = t1 < 0 ? -1 : entry.indexOf("\t", t1 + 1);
    if (t2 < 0) continue;
    const [a, d, path] = [entry.slice(0, t1), entry.slice(t1 + 1, t2), entry.slice(t2 + 1)];
    if (excluded.has(path)) {
      left_out.push(lossy(path));
      continue;
    }
    stats.files += 1;
    stats.additions += /^\+?\d+$/.test(a) ? Number(a) : 0;
    stats.deletions += /^\+?\d+$/.test(d) ? Number(d) : 0;
  }
  return [stats, left_out];
}

/** What a turn changed, from checkpoint `before` to `after`. */
export async function stats(top: string, before: Checkpoint, after: Snap): Promise<Stats> {
  const excluded = await brought_in(top, before.head, after.head, after.tree);
  const [st, left_out] = await numstat(top, before.sha, after.sha, excluded);
  st.excluded_count = left_out.length;
  st.excluded = left_out.slice(0, 200);
  return st;
}

/** A C-quoted path from a diff header (`"a/x\ty"`), unquoted: the path and the rest after its closing quote. */
function unquote(s: string): [string, string] | null {
  if (!s.startsWith('"')) return null;
  const rest = s.slice(1);
  const out: number[] = [];
  const char_at = (j: number) => String.fromCodePoint(rest.codePointAt(j)!);
  let j = 0;
  while (j < rest.length) {
    const c = char_at(j);
    j += c.length;
    if (c === '"') return [Buffer.from(out).toString("utf8"), rest.slice(j)];
    if (c !== "\\") {
      out.push(...Buffer.from(c));
      continue;
    }
    if (j >= rest.length) return null;
    const e = char_at(j);
    j += e.length;
    const simple: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11 };
    if (e in simple) out.push(simple[e]);
    else if (e >= "0" && e <= "7") {
      let v = Number(e);
      for (let k = 0; k < 2; k++) {
        const d = rest[j];
        if (d === undefined || !(d >= "0" && d <= "7")) return null;
        j++;
        v = v * 8 + Number(d);
      }
      // `as u8`.
      out.push(v & 0xff);
    } else out.push(...Buffer.from(e));
  }
  return null;
}

/** The path a `diff --git a/<path> b/<path>` line (without renames, so both are the same) is for. */
export function header_path(line: string): string | null {
  if (!line.startsWith("diff --git ")) return null;
  const rest = line.slice("diff --git ".length);
  if (rest.startsWith('"')) {
    const u = unquote(rest);
    if (!u) return null;
    return u[0].startsWith("a/") ? u[0].slice(2) : null;
  }
  // `a/<p> b/<p>`: the same path twice (lengths in bytes, as Rust's).
  const b = Buffer.from(rest);
  if (b.length < 5) return null;
  const len = Math.floor((b.length - 5) / 2);
  // Not on a char boundary: Rust's `str::get` gives None.
  const boundary = (k: number) => k === b.length || (b[k] & 0xc0) !== 0x80;
  return boundary(2) && boundary(2 + len) ? b.subarray(2, 2 + len).toString("utf8") : null;
}

/** `patch` without the files in `excluded`. */
export function without(patch: string, excluded: Set<string>): string {
  if (excluded.size === 0) return patch;
  let out = "";
  let keep = true;
  for (const line of patch.split(/(?<=\n)/)) {
    if (line.startsWith("diff --git ")) {
      const p = header_path(line.replace(/\n+$/, ""));
      keep = p === null || !excluded.has(p);
    }
    if (keep) out += line;
  }
  return out;
}
