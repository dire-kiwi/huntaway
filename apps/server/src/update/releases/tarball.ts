// The safety rules for a release's tarball (the old staging.ts's `check_entries` and `check_types`) and its smoke
// test's answer: pure. Each returns why it refuses, or null.

/**
 * The tarball's entries (`tar -tzf`) must all be in one top folder (which unpacking strips), with no absolute paths or
 * `..` that could lead out of it.
 */
export const checkEntries = (listing: string): string | null => {
  let top: string | null = null
  for (const name of listing.split("\n").filter((l) => l !== "")) {
    // Empty parts, and `.`s after the first, are dropped (Rust's `Path::components`).
    const parts = name.split("/").filter((p, i) => p !== "" && !(i > 0 && p === "."))
    const first = parts[0]
    if (name.startsWith("/") || first === undefined || first === "." || first === ".." || parts.slice(1).includes("..")) {
      return `it has an entry outside its folder: ${name}`
    }
    if (top !== null && top !== first) return `it has more than one top folder (${top} and ${first})`
    top = first
  }
  return top === null ? "it's empty" : null
}

/** The tarball's entries (`tar -tvzf`) must be files and folders: a link could point out of the folder it unpacks to. */
export const checkTypes = (listing: string): string | null => {
  const odd = listing.split("\n").find((line) => line !== "" && !line.startsWith("-") && !line.startsWith("d"))
  return odd === undefined ? null : `it has an entry that isn't a file or a folder: ${odd}`
}

/** What a release's server needs beside it: itself, the shim its agents run under, and the UI it serves. */
export const RELEASE_FILES: ReadonlyArray<string> = ["huntaway", "ia-shim", "ui/index.html"]

/** Whether `huntaway --version`'s output names `version` (as `huntaway 1.2.3`, or `v1.2.3`). */
export const printsVersion = (stdout: string, version: string) => stdout.split(/\s+/).some((w) => (w.startsWith("v") ? w.slice(1) : w) === version)
