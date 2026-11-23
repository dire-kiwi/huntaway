// HE-79: the Code tab's file tree, from `git.files`'s paths: folders first, each folder's contents in name order, a
// folder with only one folder in it shown with it on one row (`src/components`), as GitHub and VS Code do. And the
// file finder's matches. HE-90: with what git ignores when it's shown, marked as ignored.

export interface Folder {
  readonly name: string
  /** From the top of the repository, without a slash at the end; "" for the top. */
  readonly path: string
  readonly folders: Map<string, Folder>
  readonly files: Array<string>
  /** Only what git ignores is in it. */
  readonly ignored: boolean
}

const newFolder = (name: string, path: string, ignored: boolean): Folder => ({ name, path, folders: new Map(), files: [], ignored })

/**
 * The tree of `paths` (from the top of the repository), from `root` (the project's folder, `web/`, or null for the top),
 * with what git ignores (`git.files`'s `ignored`: files, and folders ending in `/`).
 */
export function buildTree(paths: ReadonlyArray<string>, root: string | null, ignored: ReadonlyArray<string> = []): Folder {
  const top = newFolder("", "", false)
  const add = (p: string, isIgnored: boolean) => {
    const folder = p.endsWith("/")
    const parts = (folder ? p.slice(0, -1) : p).split("/")
    let at = top
    for (let i = 0; i < parts.length - (folder ? 0 : 1); i++) {
      const name = parts[i] ?? ""
      let next = at.folders.get(name)
      if (!next) at.folders.set(name, (next = newFolder(name, parts.slice(0, i + 1).join("/"), isIgnored)))
      at = next
    }
    if (!folder) at.files.push(p)
  }
  for (const p of paths) add(p, false)
  for (const p of ignored) add(p, true)
  if (root === null) return top
  let at: Folder | undefined = top
  for (const name of root.replace(/\/+$/, "").split("/")) at = at?.folders.get(name)
  return at ? { ...at, name: "" } : newFolder("", root.replace(/\/+$/, ""), false)
}

/** The folders of `open` that are ignored ones (or in one), whose contents `git.files` lists only when asked. */
export function openIgnored(ignored: ReadonlyArray<string>, open: ReadonlySet<string>): Array<string> {
  const folders = ignored.filter((p) => p.endsWith("/"))
  return [...open].filter((p) => folders.some((f) => `${p}/`.startsWith(f))).toSorted()
}

/** A row of the tree as shown: a folder (open or not) or a file, how deep it is, and its name (a folder's run of names). */
export interface Row {
  readonly kind: "folder" | "file"
  readonly path: string
  readonly name: string
  readonly depth: number
  readonly open: boolean
  readonly ignored: boolean
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true })
export const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1)

/** The rows shown: the open folders' contents, folders first. */
export function rows(tree: Folder, open: ReadonlySet<string>, ignored: ReadonlySet<string> = new Set()): Array<Row> {
  const out: Array<Row> = []
  const walk = (folder: Folder, depth: number) => {
    for (const name of [...folder.folders.keys()].toSorted(byName)) {
      let f = folder.folders.get(name)
      if (!f) continue
      let label = f.name
      // A folder with nothing but one folder in it is one row with it; not an ignored one, whose contents are listed only
      // once it's opened (the click that opens it would make it another row, closed).
      for (let only = f; !only.ignored && only.files.length === 0 && only.folders.size === 1;) {
        const [next] = only.folders.values()
        if (!next) break
        label = `${label}/${next.name}`
        only = f = next
      }
      const isOpen = open.has(f.path)
      out.push({ kind: "folder", path: f.path, name: label, depth, open: isOpen, ignored: f.ignored })
      if (isOpen) walk(f, depth + 1)
    }
    for (const p of folder.files.toSorted((a, b) => byName(baseName(a), baseName(b))))
      out.push({ kind: "file", path: p, name: baseName(p), depth, open: false, ignored: ignored.has(p) })
  }
  walk(tree, 0)
  return out
}

/** The folders a file is in, from the top: what's opened to show it. */
export function ancestors(path: string): Array<string> {
  const parts = path.split("/")
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"))
}

/**
 * The files `query` finds, best first, at most `limit`: the query's characters in order in the path (spaces ignored),
 * without regard to case; a match in the file's name beats one across folders, a run of characters beats scattered
 * ones, and a shorter path a longer one.
 */
export function findFiles(paths: ReadonlyArray<string>, query: string, limit = 100): Array<string> {
  const q = query.toLowerCase().replace(/\s+/g, "")
  if (!q) return []
  const scored: Array<{ readonly path: string; readonly score: number }> = []
  for (const path of paths) {
    const lower = path.toLowerCase()
    const name = lower.slice(lower.lastIndexOf("/") + 1)
    let score: number
    if (name.includes(q)) score = name.startsWith(q) ? 0 : 1
    else if (lower.includes(q)) score = 2
    else {
      // In order, scattered: how spread out the characters are.
      let at = -1
      let spread = 0
      for (const ch of q) {
        const next = lower.indexOf(ch, at + 1)
        if (next < 0) {
          at = -2
          break
        }
        if (at >= 0) spread += next - at - 1
        at = next
      }
      if (at === -2) continue
      score = 3 + spread / 100
    }
    scored.push({ path, score: score + path.length / 10_000 })
  }
  return scored
    .toSorted((a, b) => a.score - b.score)
    .slice(0, limit)
    .map((s) => s.path)
}
