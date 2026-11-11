import { Result, Schema } from "effect"
import { McpServerConfig } from "@huntaway/contracts"
import { BOARD_SERVER, LEGACY_BOARD_SERVER } from "../claude/access.ts"

// Checking what the settings give (huntaway's agent/agent_tools/validation.ts and sources.ts' URL checks): a skill's
// `SKILL.md`, a server's name and config, a skill named to turn off, what to clone. Plain functions: a failure is a
// `ToolInvalid` with the old message.

/** What the settings gave is wrong: `reason` is the old message, shown beside `field`. */
export class ToolInvalid extends Schema.TaggedError<ToolInvalid, { readonly brand: unique symbol }>()("ToolInvalid", {
  field: Schema.String,
  reason: Schema.String,
}) {}

const invalid = (field: string, reason: string) => Result.fail(new ToolInvalid({ field, reason }))

export interface Frontmatter {
  readonly name: string
  readonly description: string
  /** `user-invocable: false` hides a skill from Claude Code's `/` commands (only Claude uses it). */
  readonly user_invocable: boolean
}

const bytes = (s: string) => new TextEncoder().encode(s).length

/** Split on `\n`, dropping a `\r` before it, and no empty last line after a final `\n`. */
const lines = (s: string): Array<string> => {
  if (s === "") return []
  const out = s.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l))
  if (s.endsWith("\n")) out.pop()
  return out
}

/** Whether a frontmatter value is true as Claude Code reads it: true, yes, on or 1, in any case, maybe quoted or with a comment after it. */
export const yamlTrue = (raw: string): boolean => {
  let value: string | null = null
  let rest = ""
  let quoted = false
  for (const q of ['"', "'"]) {
    if (!raw.startsWith(q)) continue
    const end = raw.indexOf(q, 1)
    if (end < 0) continue
    value = raw.slice(1, end)
    rest = raw.slice(end + 1).trimStart()
    quoted = true
    break
  }
  if (!quoted) {
    const m = /\s/u.exec(raw)
    const first = m ? raw.slice(0, m.index) : raw
    rest = m ? raw.slice(m.index + m[0].length).trimStart() : ""
    value = first !== "" && !first.startsWith("#") ? first : null
  }
  const restIsComment = rest === "" || rest.startsWith("#")
  return value !== null && restIsComment && ["true", "yes", "on", "1"].includes(value.replace(/[A-Z]/gu, (c) => c.toLowerCase()))
}

/** `name` and `description` from a `SKILL.md`'s YAML frontmatter: plain, quoted and block (`>`, `|`) scalars, which is all skills use for these. */
export const frontmatter = (text: string): Frontmatter | null => {
  const content = text.replace(/^\u{feff}+/u, "")
  if (!content.startsWith("---")) return null
  let rest = content.slice(3).replace(/^[ \t]+/u, "")
  if (rest.startsWith("\r\n")) rest = rest.slice(2)
  else if (rest.startsWith("\n")) rest = rest.slice(1)
  else return null
  const all = lines(rest)
  const end = all.findIndex((l) => l.trimEnd() === "---")
  if (end < 0) return null
  const ls = all.slice(0, end)
  const raw = (key: string): string | null => {
    for (const l of ls) if (l.startsWith(`${key}:`)) return l.slice(key.length + 1).trim()
    return null
  }
  const field = (key: string): string | null => {
    const i = ls.findIndex((l) => l.startsWith(`${key}:`))
    const line = ls[i]
    if (i < 0 || line === undefined) return null
    const value = line.slice(key.length + 1).trim()
    if (value.startsWith(">") || value.startsWith("|")) {
      const block: Array<string> = []
      for (const l of ls.slice(i + 1)) {
        if (!(l.trim() === "" || l.startsWith(" ") || l.startsWith("\t"))) break
        block.push(l.trim())
      }
      return block.join(value.startsWith(">") ? " " : "\n").trim()
    }
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1)
    if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1)
    return value
  }
  const inv = raw("user-invocable")
  return { name: field("name") ?? "", description: field("description") ?? "", user_invocable: inv === null || yamlTrue(inv) }
}

/** Claude Code's limit for a skill's description. */
export const MAX_DESCRIPTION = 1024

/** A skill's `SKILL.md`, checked: its frontmatter. */
export const checkSkill = (content: string): Result.Result<Frontmatter, ToolInvalid> => {
  const f = frontmatter(content)
  if (f === null) return invalid("content", "SKILL.md must start with a frontmatter block (--- name: …, description: … ---)")
  const valid = f.name !== "" && bytes(f.name) <= 64 && /^[a-z0-9-]+$/u.test(f.name) && !f.name.startsWith("-")
  if (!valid) return invalid("content", "the skill's name must be lowercase letters, numbers and hyphens (at most 64)")
  if (f.description === "") return invalid("content", "the skill needs a description: Claude uses it to decide when to use the skill")
  if (Array.from(f.description).length > MAX_DESCRIPTION)
    return invalid("content", `the skill's description is too long (at most ${MAX_DESCRIPTION} characters)`)
  return Result.succeed(f)
}

/** The board's own MCP server, under its name or its old one. */
export const isBoardServer = (name: string): boolean => name === BOARD_SERVER || name === LEGACY_BOARD_SERVER

export const checkServerName = (name: string): Result.Result<string, ToolInvalid> => {
  if (name === "" || bytes(name) > 64 || !/^[A-Za-z0-9_-]+$/u.test(name))
    return invalid("name", "the server's name must be letters, numbers, - and _ (at most 64)")
  if (isBoardServer(name)) return invalid("name", `${name} is the board's own server`)
  return Result.succeed(name)
}

const isObject = (v: unknown): v is Readonly<Record<string, unknown>> => typeof v === "object" && v !== null && !Array.isArray(v)
const decodeConfig = Schema.decodeUnknownResult(McpServerConfig)

/** A server's `mcpServers` entry, with `type` filled in. */
export const checkServerConfig = (config: unknown): Result.Result<McpServerConfig, ToolInvalid> => {
  if (!isObject(config)) return invalid("config", "the server's config must be a JSON object")
  const has = (k: string) => {
    const v = config[k]
    return typeof v === "string" && v.trim() !== ""
  }
  const kind = typeof config["type"] === "string" ? config["type"] : has("url") ? "http" : "stdio"
  if (kind === "stdio" && !has("command")) return invalid("config", "a stdio server needs a command")
  if ((kind === "http" || kind === "sse") && !has("url")) return invalid("config", `an ${kind} server needs a url`)
  if (!["stdio", "http", "sse"].includes(kind)) return invalid("config", "type must be stdio, http or sse")
  for (const [key, what] of [
    ["args", "a list of strings"],
    ["env", "an object of strings"],
    ["headers", "an object of strings"],
  ] as const) {
    if (!Object.hasOwn(config, key)) continue
    const v = config[key]
    const ok = Array.isArray(v)
      ? key === "args" && v.every((x) => typeof x === "string")
      : isObject(v)
        ? key !== "args" && Object.values(v).every((x) => typeof x === "string")
        : false
    if (!ok) return invalid("config", `${key} must be ${what}`)
  }
  const decoded = decodeConfig({ ...config, type: kind })
  return Result.isSuccess(decoded) ? Result.succeed(decoded.success) : invalid("config", "the server's config must be a JSON object")
}

/** A skill from outside the board, as typed to turn it off: it goes into a `Skill(<name>)` rule. Plugin skills are `<plugin>:<skill>`. */
export const validOtherSkill = (name: string): boolean => name !== "" && bytes(name) <= 200 && /^[A-Za-z0-9_:.-]+$/u.test(name)

/**
 * The skills to turn off from a `disabled_skills` patch. The UI sends the whole list, so a bad name saved before names
 * were checked would fail every later toggle: only new bad names are refused.
 */
export const checkDisabledSkills = (saved: ReadonlyArray<string>, v: ReadonlyArray<string>): Result.Result<ReadonlyArray<string>, ToolInvalid> => {
  const bad = v.find((n) => !validOtherSkill(n) && !saved.includes(n))
  if (bad !== undefined) return invalid("disabled_skills", `"${bad}" isn't a skill name: skill names are letters, numbers, -, _, : and .`)
  return Result.succeed(v)
}

// ---- what to clone (sources) ----

const word = (s: string) => s !== "" && s !== "." && s !== ".." && /^[A-Za-z0-9_.-]+$/u.test(s)

/**
 * The repository to clone from what was typed: a URL (https, http, ssh, git or file), `git@host:owner/repo`, a local
 * path, or `owner/repo` for GitHub. Anything git could take as an option or another transport (`ext::`) is refused.
 */
export const normalizeUrl = (input: string): Result.Result<string, ToolInvalid> => {
  const url = input.trim()
  if (url === "") return invalid("url", "the repository is needed: a git URL, or owner/repo for GitHub")
  if (url.startsWith("-") || /[\s\p{Cc}]/u.test(url)) return invalid("url", "that isn't a git repository URL")
  const sep = url.indexOf("://")
  if (sep >= 0) {
    const scheme = url.slice(0, sep).toLowerCase()
    if (["https", "http", "ssh", "git", "file"].includes(scheme)) return Result.succeed(url)
    return invalid("url", `${scheme}:// repositories aren't supported: use https, ssh or git`)
  }
  if (url.startsWith("/")) return Result.succeed(url)
  // `git@github.com:owner/repo`; a `::` is git's `ext::` and similar transports.
  const colon = url.indexOf(":")
  if (!url.includes("::") && colon >= 0) {
    const host = new Set(url.slice(0, colon))
    const path = url.slice(colon + 1)
    if (host.has("@") && !host.has("/") && path !== "") return Result.succeed(url)
  }
  const parts = url.split("/")
  const [owner, repo] = parts
  if (parts.length === 2 && owner !== undefined && repo !== undefined && word(owner) && word(repo)) {
    let r = repo
    while (r.endsWith(".git")) r = r.slice(0, -4)
    return Result.succeed(`https://github.com/${owner}/${r}`)
  }
  return invalid("url", "that isn't a git repository: use a URL, git@host:owner/repo, a path or owner/repo")
}

/** A branch or tag to clone, if one is given. */
export const checkRef = (r: string | null | undefined): Result.Result<string | null, ToolInvalid> => {
  const t = r?.trim() ?? ""
  if (t === "") return Result.succeed(null)
  const ok = !t.startsWith("-") && !t.startsWith("/") && !t.includes("..") && t.length <= 200 && /^[A-Za-z0-9._\-/+@]+$/u.test(t)
  return ok ? Result.succeed(t) : invalid("ref", "the branch or tag has characters a git ref can't have")
}

/** A folder in the repository to take the skills from, if one is given: a relative path, with `/`s. */
export const checkSubdir = (d: string | null | undefined): Result.Result<string | null, ToolInvalid> => {
  const parts = (d?.trim() ?? "").split("/").filter((p) => p !== "" && p !== ".")
  if (parts.length === 0) return Result.succeed(null)
  const ok = parts.every((p) => p !== ".." && p !== ".git" && !/[\p{Cc}\\]/u.test(p)) && parts.join("/").length <= 300
  return ok ? Result.succeed(parts.join("/")) : invalid("subdir", "the subfolder must be a folder in the repository, such as skills/en")
}

/** The repository's name for lists: the last part of its path, less `.git`. */
export const sourceName = (url: string): string => {
  const path = url.replace(/\/+$/u, "")
  const last = path.split(/[/:]/u).pop() ?? path
  const name = last.endsWith(".git") ? last.slice(0, -4) : last
  return name === "" ? "skills" : Array.from(name).slice(0, 80).join("")
}
