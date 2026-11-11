// Quoting and cutting what goes into a prompt from a thread (huntaway's review.ts `quote`, `cut_chars`, `clip`). Plan
// tasks 4.6 and 6.6.

/** Rust's `str::lines`: split on \n (dropping a \r before it), with no last empty line. */
const lines = (s: string): ReadonlyArray<string> => {
  if (s === "") return []
  const out = s.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l))
  if (s.endsWith("\n")) out.pop()
  return out
}

/** Each line of `s` quoted, Markdown style. */
export const quote = (s: string): string =>
  lines(s)
    .map((l) => `> ${l}`)
    .join("\n")

/** `s` cut to `n` characters with " [...]" after it, if it's longer. */
export const cutChars = (s: string, n: number): string => {
  const chars = Array.from(s)
  return chars.length > n ? `${chars.slice(0, n).join("")} [...]` : s
}

/** `s`'s first `n` characters, or its last with `end`, marked where it was cut. */
export const clip = (s: string, n: number, end: boolean): string => {
  const chars = Array.from(s)
  if (chars.length <= n) return s
  return end ? `[...] ${chars.slice(chars.length - n).join("")}` : `${chars.slice(0, n).join("")} [...]`
}
