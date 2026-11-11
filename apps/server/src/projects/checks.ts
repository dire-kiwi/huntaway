import { Effect } from "effect"
import { Invalid, Status } from "@huntaway/contracts"
import type { StatusScripts } from "@huntaway/contracts"

// The checks the old `api/projects.ts` project_fields made that need nothing but the value: what is stored, or why it
// is refused.

const invalid = (field: string, reason: string) => Effect.fail(new Invalid({ field, reason }))

/** The entries of a `copy_files` or `link_folders` text: trimmed lines, without blanks and `#` comments. */
export const entries = (text: string): Array<string> =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"))

/** Why a `copy_files` pattern cannot be used: it must not climb out with `..`. */
const patternError = (p: string): string | null => {
  const q = p.startsWith("!") ? p.slice(1) : p
  return q.split("/").includes("..") ? `${q}: patterns are relative to the repository, without ..` : null
}

/** Why a `link_folders` entry is not a folder inside the repository. */
const linkError = (p: string): string | null => {
  const path = p.replace(/\/+$/, "")
  if (path.startsWith("/") || p.startsWith("~")) return `${p}: folders are relative to the repository`
  const parts = path.split("/").filter((c) => c !== "" && c !== ".")
  if (parts.some((c) => c === ".." || c === ".git")) return `${p}: folders are relative to the repository, inside it, without .. or .git`
  if (parts.length === 0) return `${p}: name a folder inside the repository`
  return null
}

/** A `copy_files` or `link_folders` value as stored: trimmed, at most 200 entries, each usable. Null is none. */
export const checkFileList = (field: "copy_files" | "link_folders", v: string | null): Effect.Effect<string, Invalid> => {
  const text = v?.trim() ?? ""
  const lines = entries(text)
  if (lines.length > 200) return invalid(field, `${field} can have at most 200 entries`)
  for (const l of lines) {
    const e = field === "link_folders" ? linkError(l) : patternError(l)
    if (e !== null) return invalid(field, `${field}: ${e}`)
  }
  return Effect.succeed(text)
}

/** A pull request preview template: null (or blank) for none, else an http(s) URL with `{pr}` in it. */
export const checkPreviewUrl = (v: string | null): Effect.Effect<string | null, Invalid> => {
  const url = v?.trim() ?? ""
  if (url === "") return Effect.succeed(null)
  if (!((url.startsWith("http://") || url.startsWith("https://")) && url.includes("{pr}"))) {
    return invalid("pr_preview_url", "pr_preview_url must be null or an http(s) URL with {pr} for the pull request's number")
  }
  return Effect.succeed(url)
}

/** A project's name: trimmed, required, at most 100 characters. */
export const checkName = (v: string): Effect.Effect<string, Invalid> => {
  const name = v.trim()
  if (name === "") return invalid("name", "name can't be blank")
  if (Array.from(name).length > 100) return invalid("name", "name can be at most 100 characters")
  return Effect.succeed(name)
}

/** A sidebar group: trimmed, at most 100 characters; null or blank takes the project out of its group. */
export const checkGroupName = (v: string | null): Effect.Effect<string | null, Invalid> => {
  const name = v?.trim() ?? ""
  if (Array.from(name).length > 100) return invalid("group_name", "group_name can be at most 100 characters")
  return Effect.succeed(name === "" ? null : name)
}

/** Review rounds: a whole number from 0 to 20. */
export const checkReviewRounds = (v: number): Effect.Effect<number, Invalid> =>
  Number.isInteger(v) && v >= 0 && v <= 20 ? Effect.succeed(v) : invalid("review_rounds", "review_rounds must be a whole number from 0 to 20")

/** Scripts per status as stored: blank scripts dropped, statuses in order. Null is none. */
export const tidyStatusScripts = (v: StatusScripts | null): StatusScripts => {
  const out: { [K in Status]?: string } = {}
  for (const status of [...Status.literals].toSorted()) {
    const script = v?.[status]
    if (script !== undefined && script.trim() !== "") out[status] = script
  }
  return out
}
