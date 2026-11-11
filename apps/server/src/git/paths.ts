// Path and text helpers of the git area (huntaway's git/worktree.ts): paths compared by whole components, as Rust's
// `Path` did, and git's output split into lines. Plain functions: no I/O (`Git.canonicalize` resolves a real path).

/** The lines of a text, as Rust's `str::lines` (no last empty line, `\r\n` too). */
export const lines = (s: string): Array<string> => {
  const out = s.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l))
  if (out.length > 0 && out[out.length - 1] === "") out.pop()
  return out
}

/** `p` without doubled or trailing slashes. */
const trimSlashes = (p: string): string => {
  let s = p.replace(/\/+/g, "/")
  while (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1)
  return s
}

/** `Path::starts_with`: whether `p` is `base` or inside it, by whole components. */
export const pathStartsWith = (p: string, base: string): boolean => {
  const a = trimSlashes(p)
  const b = trimSlashes(base)
  if (b === "") return p.startsWith("/") === base.startsWith("/") || a === ""
  return a === b || a.startsWith(b === "/" ? "/" : `${b}/`)
}

/** `Path::strip_prefix`: the rest of `p` after `base` (by whole components), or null. */
export const stripPathPrefix = (p: string, base: string): string | null => {
  if (!pathStartsWith(p, base)) return null
  const a = trimSlashes(p)
  const b = trimSlashes(base)
  if (a === b) return ""
  return a.slice(b === "/" ? 1 : b.length + 1)
}

/** Whether two paths are the same by their components (`PathBuf == PathBuf`). */
export const samePath = (a: string, b: string): boolean => trimSlashes(a) === trimSlashes(b)

/** "" for one, "s" for any other count given as text (git's counts come as text). */
export const plural = (n: string): string => (n === "1" ? "" : "s")
