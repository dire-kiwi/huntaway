// The Changes tab's model (see components/Changes.tsx): diffs read into files, hunks and lines, the
// patches that stage, unstage or discard some of a file's lines, and the tree of changed files.
import type { GitFile } from "./api";

/** One line of a hunk: unchanged (context), removed or added. */
export interface DiffLine {
  kind: " " | "-" | "+";
  text: string;
  /** Followed by `\ No newline at end of file`: the last line of its side, with no newline after it. */
  noEol: boolean;
  /** Its line number in the old file (context and removed lines) and the new one (context and added lines). */
  old?: number;
  new?: number;
}

export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** What git puts after the second `@@` (the function it's in), with its leading space. */
  heading: string;
  lines: DiffLine[];
}

export interface FileDiff {
  /** The lines before the first hunk (`diff --git`, modes, `index`, `---`, `+++`), as they are. */
  header: string[];
  /** Null on the side the file isn't (added or deleted). */
  oldPath: string | null;
  newPath: string | null;
  /** The path to show: where it is now, or was for a deleted file. */
  path: string;
  binary: boolean;
  /** A combined diff (a conflicted file's): shown as it is, in `raw`, rather than in hunks. */
  combined: boolean;
  raw: string[];
  hunks: Hunk[];
  adds: number;
  dels: number;
}

/** A path as git writes it in a header, quoted (C-style) when it has odd characters in it. */
export function unquote(s: string): string {
  if (!s.startsWith('"')) return s;
  const bytes: number[] = [];
  const esc: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
  const enc = new TextEncoder();
  for (let i = 1; i < s.length; i++) {
    const c = s[i];
    if (c === '"') break;
    if (c !== "\\") {
      bytes.push(...enc.encode(c));
      continue;
    }
    const n = s[++i];
    if (/[0-7]/.test(n)) {
      bytes.push(parseInt(s.slice(i, i + 3), 8));
      i += 2;
    } else bytes.push(esc[n] ?? n.charCodeAt(0));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** The path in a `---`/`+++` line (after its `a/` or `b/`), or null for /dev/null. */
function headerPath(rest: string): string | null {
  const p = unquote(rest.replace(/\t.*$/, ""));
  return p === "/dev/null" ? null : p.replace(/^[ab]\//, "");
}

/** The path in `diff --git a/P b/P` when it's the same on both sides (it can't otherwise be split for sure). */
function gitLinePath(rest: string): string | null {
  if (rest.startsWith('"')) {
    const end = rest.indexOf('" ', 1);
    return end < 0 ? null : headerPath(rest.slice(0, end + 1));
  }
  const n = (rest.length - 5) / 2;
  if (!Number.isInteger(n) || rest.slice(n + 2, n + 5) !== " b/") return null;
  return rest.slice(2, n + 2);
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** Reads a patch (`git diff`, `git show`, several files or none) into its files. */
export function parseDiff(patch: string): FileDiff[] {
  const lines = patch.split("\n");
  const files: FileDiff[] = [];
  let f: FileDiff | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i++];
    // The end of the last line.
    if (line === "" && i === lines.length) break;
    if (line.startsWith("diff ")) {
      const combined = line.startsWith("diff --cc ") || line.startsWith("diff --combined ");
      const p = combined ? line.replace(/^diff --(cc|combined) /, "") : gitLinePath(line.slice("diff --git ".length));
      f = { header: [line], oldPath: p, newPath: p, path: p ?? "", binary: false, combined, raw: [], hunks: [], adds: 0, dels: 0 };
      files.push(f);
      continue;
    }
    if (!f) continue;
    if (f.combined) {
      if (!f.raw.length && !line.startsWith("@@@")) f.header.push(line);
      else {
        f.raw.push(line);
        if (/^[ +]\+/.test(line)) f.adds++;
        else if (/^[ -]-/.test(line)) f.dels++;
      }
      continue;
    }
    const m = HUNK.exec(line);
    if (!m) {
      // A header line, until the first hunk.
      if (f.hunks.length) continue;
      f.header.push(line);
      if (line.startsWith("--- ")) f.oldPath = headerPath(line.slice(4));
      else if (line.startsWith("+++ ")) f.newPath = headerPath(line.slice(4));
      else if (line.startsWith("rename from ")) f.oldPath = unquote(line.slice(12));
      else if (line.startsWith("rename to ")) f.newPath = unquote(line.slice(10));
      else if (line.startsWith("new file mode")) f.oldPath = null;
      else if (line.startsWith("deleted file mode")) f.newPath = null;
      else if (line.startsWith("Binary files ") || line === "GIT binary patch") f.binary = true;
      f.path = f.newPath ?? f.oldPath ?? f.path;
      continue;
    }
    const h: Hunk = {
      oldStart: +m[1],
      oldCount: m[2] === undefined ? 1 : +m[2],
      newStart: +m[3],
      newCount: m[4] === undefined ? 1 : +m[4],
      heading: m[5],
      lines: [],
    };
    f.hunks.push(h);
    let [o, n] = [0, 0];
    // As many lines as its header says (an empty one is context, as diff.suppressBlankEmpty writes it).
    while (i < lines.length && (o < h.oldCount || n < h.newCount || lines[i].startsWith("\\"))) {
      const l = lines[i++];
      if (l === "" && i === lines.length) break;
      if (l.startsWith("\\")) {
        const last = h.lines.at(-1);
        if (last) last.noEol = true;
        continue;
      }
      const kind = l[0] === "-" || l[0] === "+" ? l[0] : " ";
      const d: DiffLine = { kind, text: l.slice(1), noEol: false };
      if (kind !== "+") d.old = h.oldStart + o++;
      if (kind !== "-") d.new = h.newStart + n++;
      if (kind === "+") f.adds++;
      if (kind === "-") f.dels++;
      h.lines.push(d);
    }
  }
  return files;
}

/** Whether a file's lines can be staged one by one. */
export const linesStageable = (f: FileDiff) => !f.binary && !f.combined && f.hunks.length > 0;

/**
 * A patch of just the chosen changed lines of `file`, or null if none are chosen. Applied with
 * `git apply` it makes those changes (staging them, from the unstaged diff); with `reverse`, it's
 * for `git apply -R`, undoing them (unstaging, from the staged diff, or discarding, from the
 * unstaged one). The changes left out stay as they are: in a forward patch a removal left out
 * becomes context and an addition is dropped, and the other way round in a reverse one.
 */
export function linesPatch(file: FileDiff, chosen: (hunk: number, line: number) => boolean, reverse: boolean): string | null {
  if (!linesStageable(file)) return null;
  const body: string[] = [];
  // Every change is in (so a new or deleted file stays one), and how far the side being made has moved.
  let all = true;
  let delta = 0;
  file.hunks.forEach((h, hi) => {
    let lines: DiffLine[] = [];
    let any = false;
    h.lines.forEach((l, li) => {
      if (l.kind === " ") lines.push(l);
      else if (chosen(hi, li)) {
        lines.push(l);
        any = true;
      } else {
        all = false;
        // What's left out is context on the side the patch is checked against, and missing on the other.
        if (l.kind === (reverse ? "+" : "-")) lines.push({ ...l, kind: " " });
      }
    });
    if (!any) return;
    // A last line with no newline that's now context, with additions after it, gets its newline in this
    // patch; one that's put back with context after it (the last line now) has one already.
    lines = lines.flatMap((l, k) => {
      const later = lines.slice(k + 1);
      if (!reverse && l.noEol && l.kind === " " && later.some((x) => x.kind === "+")) return [{ ...l, kind: "-" }, { ...l, kind: "+", noEol: false }];
      if (reverse && l.noEol && l.kind === "-" && later.some((x) => x.kind === " ")) return [{ ...l, noEol: false }];
      return [l];
    });
    const oldCount = lines.filter((l) => l.kind !== "+").length;
    const newCount = lines.filter((l) => l.kind !== "-").length;
    // The side the patch is checked against keeps its start; the other's moves with the earlier hunks
    // (an empty side's start is the line before it).
    let oldStart = h.oldStart;
    let newStart = h.newStart;
    if (!reverse) newStart = h.oldStart + delta + (oldCount ? 0 : 1) - (newCount ? 0 : 1);
    else oldStart = h.newStart - delta + (newCount ? 0 : 1) - (oldCount ? 0 : 1);
    delta += newCount - oldCount;
    body.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${h.heading}`);
    for (const l of lines) {
      body.push(l.kind + l.text);
      if (l.noEol) body.push("\\ No newline at end of file");
    }
  });
  if (!body.length) return null;
  // Part of a deleted file (staged) or a new one (unstaged or discarded) leaves the file there, changed.
  const keeps = !all && (reverse ? file.oldPath === null : file.newPath === null);
  const header = file.header
    .filter((l) => !l.startsWith("index ") && !(keeps && /^(new|deleted) file mode /.test(l)))
    .map((l) => {
      if (!keeps) return l;
      if (reverse && l === "--- /dev/null") return file.header.find((x) => x.startsWith("+++ "))!.replace(/^\+\+\+ ("?)b\//, "--- $1a/");
      if (!reverse && l === "+++ /dev/null") return file.header.find((x) => x.startsWith("--- "))!.replace(/^--- ("?)a\//, "+++ $1b/");
      return l;
    });
  return [...header, ...body, ""].join("\n");
}

/** A row of the files list: a folder (in the tree view) or a file. */
export interface FileRow {
  /** The path, with a `/` after a folder's. */
  key: string;
  /** What to show: the file's or folder's name (folders with just one folder in them run on, `a/b`), or the whole path when flat. */
  name: string;
  depth: number;
  /** The file, for a file's row. */
  file?: GitFile;
  /** The files it stands for: itself, or everything under the folder. */
  files: GitFile[];
}

interface Dir {
  dirs: Map<string, Dir>;
  files: GitFile[];
}

/** The rows of the files list: a tree of folders (with `collapsed` ones' files left out), or the paths in order. */
export function fileRows(files: GitFile[], tree: boolean, collapsed: ReadonlySet<string>): FileRow[] {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (!tree) return sorted.map((f) => ({ key: f.path, name: f.path, depth: 0, file: f, files: [f] }));
  const root: Dir = { dirs: new Map(), files: [] };
  for (const f of sorted) {
    const parts = f.path.split("/");
    let d = root;
    for (const p of parts.slice(0, -1)) {
      if (!d.dirs.has(p)) d.dirs.set(p, { dirs: new Map(), files: [] });
      d = d.dirs.get(p)!;
    }
    d.files.push(f);
  }
  const all = (d: Dir): GitFile[] => [...[...d.dirs.values()].flatMap(all), ...d.files];
  const rows: FileRow[] = [];
  const walk = (d: Dir, prefix: string, depth: number) => {
    for (const [name, sub] of [...d.dirs].sort(([a], [b]) => (a < b ? -1 : 1))) {
      let [label, at] = [name, sub];
      while (at.dirs.size === 1 && !at.files.length) {
        const [[n, next]] = at.dirs;
        label += `/${n}`;
        at = next;
      }
      const key = `${prefix}${label}/`;
      rows.push({ key, name: label, depth, files: all(at) });
      if (!collapsed.has(key)) walk(at, key, depth + 1);
    }
    for (const f of d.files) rows.push({ key: f.path, name: f.path.slice(prefix.length), depth, file: f, files: [f] });
  };
  walk(root, "", 0);
  return rows;
}

/** Whether a file has changes in the index, and in the working tree (untracked files' are). */
export const hasStaged = (f: GitFile) => f.x !== " " && f.x !== "?" && !conflicted(f);
export const hasUnstaged = (f: GitFile) => f.y !== " " || conflicted(f);
export const conflicted = (f: GitFile) => f.x === "U" || f.y === "U" || (f.x === "A" && f.y === "A") || (f.x === "D" && f.y === "D");
export const untracked = (f: GitFile) => f.x === "?";
