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

/** A title as a folder or branch name: lowercase ASCII letters and digits, a dash between runs of anything else, at most `max` long. */
export const slugify = (s: string, max: number): string => {
  let out = ""
  let dash = false
  for (const c of s) {
    if (/^[A-Za-z0-9]$/.test(c)) {
      out += c.toLowerCase()
      dash = false
    } else if (!dash && out.length > 0) {
      out += "-"
      dash = true
    }
    if (out.length >= max) break
  }
  return out.replace(/^-+|-+$/g, "")
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** `text` cut to at most `max` UTF-8 bytes (at a character's start) and marked so, if it is longer (the old `truncate`). */
export const truncate = (text: string, max: number): string => {
  const bytes = encoder.encode(text)
  if (bytes.length <= max) return text
  let end = max
  // Back up to a character's first byte (one that is not a UTF-8 continuation byte).
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--
  return `${decoder.decode(bytes.subarray(0, end))}\n… [truncated ${bytes.length - end} bytes]`
}

/** `~` and `~/…` in `path` as `home`. */
export const expandHome = (path: string, home: string): string => (path === "~" ? home : path.startsWith("~/") ? `${home}${path.slice(1)}` : path)
