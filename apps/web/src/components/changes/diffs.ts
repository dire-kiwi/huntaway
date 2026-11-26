// The Changes tab's model (see Changes.tsx): diffs read into files, hunks and lines.

/** One line of a hunk: unchanged (context), removed or added. */
export interface DiffLine {
  kind: " " | "-" | "+"
  text: string
  /** Followed by `\ No newline at end of file`: the last line of its side, with no newline after it. */
  noEol: boolean
  /** Its line number in the old file (context and removed lines) and the new one (context and added lines). */
  old?: number
  new?: number
}

export interface Hunk {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  /** What git puts after the second `@@` (the function it's in), with its leading space. */
  heading: string
  lines: DiffLine[]
}

export interface FileDiff {
  /** The lines before the first hunk (`diff --git`, modes, `index`, `---`, `+++`), as they are. */
  header: string[]
  /** Null on the side the file isn't (added or deleted). */
  oldPath: string | null
  newPath: string | null
  /** The path to show: where it is now, or was for a deleted file. */
  path: string
  binary: boolean
  /** A combined diff (a conflicted file's): shown as it is, in `raw`, rather than in hunks. */
  combined: boolean
  raw: string[]
  hunks: Hunk[]
  adds: number
  dels: number
}

/** A path as git writes it in a header, quoted (C-style) when it has odd characters in it. */
export function unquote(s: string): string {
  if (!s.startsWith('"')) return s
  const bytes: number[] = []
  const esc: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 }
  const enc = new TextEncoder()
  for (let i = 1; i < s.length; i++) {
    const c = s[i] ?? ""
    if (c === '"') break
    if (c !== "\\") {
      bytes.push(...enc.encode(c))
      continue
    }
    const n = s[++i] ?? ""
    if (/[0-7]/.test(n)) {
      bytes.push(parseInt(s.slice(i, i + 3), 8))
      i += 2
    } else bytes.push(esc[n] ?? n.charCodeAt(0))
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

/** The path in a `---`/`+++` line (after its `a/` or `b/`), or null for /dev/null. */
function headerPath(rest: string): string | null {
  const p = unquote(rest.replace(/\t.*$/, ""))
  return p === "/dev/null" ? null : p.replace(/^[ab]\//, "")
}

/** The path in `diff --git a/P b/P` when it's the same on both sides (it can't otherwise be split for sure). */
function gitLinePath(rest: string): string | null {
  if (rest.startsWith('"')) {
    const end = rest.indexOf('" ', 1)
    return end < 0 ? null : headerPath(rest.slice(0, end + 1))
  }
  const n = (rest.length - 5) / 2
  if (!Number.isInteger(n) || rest.slice(n + 2, n + 5) !== " b/") return null
  return rest.slice(2, n + 2)
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

/** Reads a patch (`git diff`, `git show`, several files or none) into its files. */
export function parseDiff(patch: string): FileDiff[] {
  const lines = patch.split("\n")
  const files: FileDiff[] = []
  let f: FileDiff | null = null
  let i = 0
  while (i < lines.length) {
    const line = lines[i++] ?? ""
    // The end of the last line.
    if (line === "" && i === lines.length) break
    if (line.startsWith("diff ")) {
      const combined = line.startsWith("diff --cc ") || line.startsWith("diff --combined ")
      const p = combined ? line.replace(/^diff --(cc|combined) /, "") : gitLinePath(line.slice("diff --git ".length))
      f = { header: [line], oldPath: p, newPath: p, path: p ?? "", binary: false, combined, raw: [], hunks: [], adds: 0, dels: 0 }
      files.push(f)
      continue
    }
    if (!f) continue
    if (f.combined) {
      if (!f.raw.length && !line.startsWith("@@@")) f.header.push(line)
      else {
        f.raw.push(line)
        if (/^[ +]\+/.test(line)) f.adds++
        else if (/^[ -]-/.test(line)) f.dels++
      }
      continue
    }
    const m = HUNK.exec(line)
    if (!m) {
      // A header line, until the first hunk.
      if (f.hunks.length) continue
      f.header.push(line)
      if (line.startsWith("--- ")) f.oldPath = headerPath(line.slice(4))
      else if (line.startsWith("+++ ")) f.newPath = headerPath(line.slice(4))
      else if (line.startsWith("rename from ")) f.oldPath = unquote(line.slice(12))
      else if (line.startsWith("rename to ")) f.newPath = unquote(line.slice(10))
      else if (line.startsWith("new file mode")) f.oldPath = null
      else if (line.startsWith("deleted file mode")) f.newPath = null
      else if (line.startsWith("Binary files ") || line === "GIT binary patch") f.binary = true
      f.path = f.newPath ?? f.oldPath ?? f.path
      continue
    }
    const h: Hunk = {
      oldStart: Number(m[1] ?? 0),
      oldCount: m[2] === undefined ? 1 : +m[2],
      newStart: Number(m[3] ?? 0),
      newCount: m[4] === undefined ? 1 : +m[4],
      heading: m[5] ?? "",
      lines: [],
    }
    f.hunks.push(h)
    let [o, n] = [0, 0]
    // As many lines as its header says (an empty one is context, as diff.suppressBlankEmpty writes it).
    while (i < lines.length && (o < h.oldCount || n < h.newCount || lines[i]?.startsWith("\\"))) {
      const l = lines[i++] ?? ""
      if (l === "" && i === lines.length) break
      if (l.startsWith("\\")) {
        const last = h.lines.at(-1)
        if (last) last.noEol = true
        continue
      }
      const kind = l.startsWith("-") ? "-" : l.startsWith("+") ? "+" : " "

      const d: DiffLine = { kind, text: l.slice(1), noEol: false }
      if (kind !== "+") d.old = h.oldStart + o++
      if (kind !== "-") d.new = h.newStart + n++
      if (kind === "+") f.adds++
      if (kind === "-") f.dels++
      h.lines.push(d)
    }
  }
  return files
}
