// Shared by the tasks area (a set's branch name, HE-117) and the git area (worktree folders and branches).

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
